import {
	createAgentSession,
	SessionManager,
	z,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// lang-nag — watches the MAIN session's assistant replies and, when the reply
// is not written in the configured language, prepends a tiny pre-written
// instruction (e.g. "说中文") to the front of the NEXT user message so the model
// self-corrects on its own next turn.
//
// What gets classified. Only the assistant's REPLY BODY — the `type: "text"`
// content blocks of the messages `agent_end` delivers. Thinking and tool calls
// (`toolCall`) are never treated as reply text. From that body we take the LAST
// paragraph (blank-line separated) and
// hand the classifier the first 200 code points of it — the natural-language
// sign-off, not the whole turn.
//
// Cancellation. Detection starts at `agent_end` and overlaps with the user
// reading and typing. The next genuine user message only takes a verdict that
// has already settled; if detection is still running when the message is sent,
// the detector session is aborted and the message goes out unchanged.
//
// Detection uses a dedicated, in-memory `createAgentSession` (doc-polish's
// runner shape): the configured model, thinking OFF, NO tools, no MCP/LSP/
// extensions. Config (model + target language + the literal instruction string)
// lives in a standalone `lang-nag.json`, resolved from the caller's cwd first,
// then next to this file — same lookup order as doc-polish.
//
// Scope is the main session only, mirroring tool-policy-nag: subagents run
// short decomposed slices where a language nag is noise. A detection failure,
// an unavailable model, an ambiguous verdict, or a missing config all degrade
// to "no nag" — the extension never blocks or corrupts a turn.
// ============================================================================

const DETECT_CHAR_LIMIT = 200; // code points of the last paragraph handed to the classifier; never more.

type Model = NonNullable<CreateAgentSessionOptions["model"]>;

/** Checked keyed access on loosely-typed values without an unchecked `as` cast. */
function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
	return typeof value === "object" && value !== null && key in value;
}

/**
 * Same pattern tool-policy-nag / ctx-post-compact-hint use to tell the main
 * session file apart from subagent session files. Kept in sync intentionally.
 */
const MAIN_SESSION_FILE_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const isMainSession = (ctx: ExtensionContext): boolean => {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const fileName = sessionFile?.split(/[\\/]/).pop();
	return fileName !== undefined && MAIN_SESSION_FILE_PATTERN.test(fileName);
};

// --- config (standalone lang-nag.json) --------------------------------------

const configSchema = z.object({
	/** Model spec (`provider/id`, bare id, or role alias). Any `:effort` suffix is dropped — thinking is forced off. */
	model: z.string().min(1),
	/** Target language name the reply is expected to be in, passed verbatim to the classifier (e.g. "中文", "English"). */
	language: z.string().min(1),
	/** Literal instruction prepended to the next user message on a mismatch (e.g. "说中文", "say English"). */
	instruction: z.string().min(1),
});

type LangNagConfig = z.infer<typeof configSchema>;

// cwd-local lang-nag.json wins over the one shipped beside this extension;
// missing / malformed config leaves the extension inert.
function loadConfig(cwd: string): LangNagConfig | null {
	for (const path of [join(cwd, "lang-nag.json"), join(import.meta.dir, "lang-nag.json")]) {
		if (!existsSync(path)) continue;
		try {
			return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			// Malformed / incomplete config: try the next candidate, else stay inert.
		}
	}
	return null;
}

// --- model resolution -------------------------------------------------------

const THINKING_SUFFIXES: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

// Thinking is forced off for the classifier, so any `:effort` suffix on the
// configured spec is irrelevant — strip it before resolving.
function baseSpec(spec: string): string {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0 && THINKING_SUFFIXES[trimmed.slice(colon + 1)] === true) return trimmed.slice(0, colon);
	return trimmed;
}

function resolveModel(ctx: ExtensionContext, spec: string): Model | undefined {
	const base = baseSpec(spec);
	const resolved = ctx.models?.resolve?.(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	return (
		available.find((m: Model) => `${m.provider}/${m.id}` === base) ??
		available.find((m: Model) => m.id === base)
	);
}

// --- reply body extraction --------------------------------------------------

// Reply BODY of one assistant message: `type: "text"` blocks only. Thinking and
// toolCall blocks are structurally excluded, never flattened into the text.
function assistantTextBody(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (!hasKey(block, "type") || block.type !== "text") continue;
		if (hasKey(block, "text") && typeof block.text === "string") text += block.text;
	}
	return text;
}

// Body of the last assistant message that actually said something. A trailing
// tool-only message (no text) is skipped in favour of the real reply before it.
function lastAssistantBody(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!hasKey(m, "role") || m.role !== "assistant") continue;
		const body = assistantTextBody(hasKey(m, "content") ? m.content : undefined);
		if (body.trim() !== "") return body;
	}
	return "";
}

// The classifier sees the reply's last blank-line-separated paragraph, capped at
// DETECT_CHAR_LIMIT code points from its start.
function lastParagraphSample(body: string): string {
	const trimmed = body.trim();
	if (trimmed === "") return "";
	const paragraphs = trimmed
		.split(/\n[ \t]*\n/)
		.map(p => p.trim())
		.filter(p => p !== "");
	const last = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : trimmed;
	return [...last].slice(0, DETECT_CHAR_LIMIT).join("");
}

// --- classifier -------------------------------------------------------------

// Maps the classifier's one-word answer to a verdict: true (in target), false
// (not), or null (empty/ambiguous → never nags). Exposed as a test seam.
function interpretVerdict(answer: string): boolean | null {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "") return null;
	if (normalized.startsWith("yes") || normalized.startsWith("是")) return true;
	if (normalized.startsWith("no") || normalized.startsWith("否") || normalized.startsWith("不")) return false;
	return null;
}

async function isTargetLanguage(
	ctx: ExtensionContext,
	model: Model,
	prompt: string,
	signal: AbortSignal,
): Promise<boolean | null> {
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		modelRegistry: ctx.modelRegistry,
		model,
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(),
		toolNames: [],
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		// Classify the helper as a subagent: a main-kind session's dispose tears
		// down the global AgentLifecycleManager and strands every live subagent.
		taskDepth: 1,
		agentId: "lang-nag-detector",
	});
	if (signal.aborted) {
		await session.dispose();
		return null;
	}
	const onAbort = (): void => {
		void session.abort();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	let deltas = "";
	let finalMessages: unknown;
	const unsubscribe = session.subscribe((event: unknown) => {
		if (!hasKey(event, "type")) return;
		if (event.type === "message_update" && hasKey(event, "assistantMessageEvent")) {
			const a = event.assistantMessageEvent;
			if (hasKey(a, "type") && a.type === "text_delta" && hasKey(a, "delta") && typeof a.delta === "string") {
				deltas += a.delta;
			}
		} else if (event.type === "agent_end") {
			const terminal = !hasKey(event, "isTerminal") || event.isTerminal !== false;
			if (terminal) finalMessages = hasKey(event, "messages") ? event.messages : undefined;
		}
	});
	try {
		await session.prompt(prompt);
	} finally {
		signal.removeEventListener("abort", onAbort);
		unsubscribe();
		await session.dispose();
	}
	if (signal.aborted) return null;
	// A provider failure lands as an assistant turn with stopReason "error"; treat
	// it as undetermined rather than a mismatch.
	const msgs = Array.isArray(finalMessages) ? finalMessages : [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!hasKey(m, "role") || m.role !== "assistant") continue;
		if (hasKey(m, "stopReason") && m.stopReason === "error") return null;
		break;
	}
	return interpretVerdict(deltas.trim() || lastAssistantBody(finalMessages));
}

// Resolves to the instruction to prepend, or null (in-target / undetermined /
// misconfigured / aborted). Never rejects, so it is safe to hold as a floating promise.
async function detectInstruction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: LangNagConfig,
	sample: string,
	signal: AbortSignal,
): Promise<string | null> {
	const model = resolveModel(ctx, cfg.model);
	if (!model) {
		pi.logger?.warn?.(`lang-nag: model "${cfg.model}" unavailable — skipping detection`);
		return null;
	}
	const prompt =
		`You are a strict language classifier.\n` +
		`Decide whether the TEXT below is written mainly in ${cfg.language}.\n` +
		`Ignore code, file paths, URLs, and isolated technical terms; judge the prose.\n` +
		`Reply with exactly one word — "yes" or "no" — and nothing else.\n\n` +
		`TEXT:\n"""\n${sample}\n"""`;
	try {
		const inTarget = await isTargetLanguage(ctx, model, prompt, signal);
		return inTarget === false ? cfg.instruction : null;
	} catch (error) {
		if (signal.aborted) return null;
		pi.logger?.warn?.("lang-nag: detection failed", { error: String(error) });
		return null;
	}
}

// --- extension registration -------------------------------------------------

// Detection for the latest terminal reply: nothing armed, still running (abortable),
// or settled with the instruction to prepend (null = no nag).
type Detection =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly controller: AbortController }
	| { readonly kind: "settled"; readonly instruction: string | null };

const IDLE: Detection = { kind: "idle" };

export default function langNag(pi: ExtensionAPI): void {
	let config: LangNagConfig | null = null;
	let mainSession = false;
	let detection: Detection = IDLE;

	// Drops the current detection, aborting it if it is still running.
	const cancelDetection = (): void => {
		if (detection.kind === "running") detection.controller.abort();
		detection = IDLE;
	};

	pi.on("session_start", (_event, ctx) => {
		mainSession = isMainSession(ctx);
		cancelDetection();
		if (!mainSession) return;
		config = loadConfig(ctx.cwd);
		if (config) {
			pi.logger?.info?.(`lang-nag: active (language=${config.language}, model=${config.model})`);
		} else {
			pi.logger?.info?.("lang-nag: no lang-nag.json found — inert");
		}
	});
	// Switching to another session file re-reads cwd-local config and identity.
	pi.on("session_switch", (_event, ctx) => {
		mainSession = isMainSession(ctx);
		cancelDetection();
		config = mainSession ? loadConfig(ctx.cwd) : null;
	});
	// Boundaries that swap the working context invalidate any in-flight verdict.
	pi.on("session_branch", (_event, ctx) => {
		if (isMainSession(ctx)) cancelDetection();
	});
	pi.on("session_tree", (_event, ctx) => {
		if (isMainSession(ctx)) cancelDetection();
	});
	pi.on("session_compact", (_event, ctx) => {
		if (isMainSession(ctx)) cancelDetection();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!mainSession || config === null) return;
		// An auto-scheduled continuation is not a user-visible terminal reply.
		if (event.willContinue === true) return;
		// A newer terminal reply supersedes any verdict still pending for an older one.
		cancelDetection();
		const sample = lastParagraphSample(lastAssistantBody(event.messages));
		if (sample === "") return;
		const controller = new AbortController();
		const running: Detection = { kind: "running", controller };
		detection = running;
		// Runs while the user reads/types; only a verdict that settles before the
		// next input is used.
		void detectInstruction(pi, ctx, config, sample, controller.signal).then(instruction => {
			if (detection === running) detection = { kind: "settled", instruction };
		});
	});

	pi.on("input", (event) => {
		if (!mainSession) return;
		// Slash-command invocations are harness UI, not natural language — never nag.
		// Drop any verdict: this turn is consumed by the command, and a stale
		// instruction must not leak into the next genuine user message.
		if (event.text.startsWith("/")) {
			cancelDetection();
			return;
		}
		// Only prepend to genuine user turns, never to synthetic injections
		// (steers/asides from this or other extensions).
		if (event.source === "extension") return;

		const current = detection;
		cancelDetection();
		if (current.kind === "settled" && current.instruction !== null && current.instruction !== "") {
			return { text: `${current.instruction}\n\n${event.text}` };
		}
	});
}

// Pure-logic seam for out-of-harness verification (mirrors xai-oauth-cost-ticks).
// The model-calling path (isTargetLanguage/detectInstruction) still requires a
// live session and is not exposed here.
export function __testables() {
	return { assistantTextBody, lastAssistantBody, lastParagraphSample, baseSpec, interpretVerdict, loadConfig };
}
