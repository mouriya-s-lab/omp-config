import {
	createAgentSession,
	SessionManager,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ============================================================================
// watchdog-agent — a per-target reviewer ("watchdog") driven by `WATCHDOG-*.md`
// files, complementing OMP's native advisor.
//
// WHY THIS EXISTS. OMP's native advisor already attaches per subagent
// (`task.agentAdvisor` / agent frontmatter `advisor:`) and discovers
// `WATCHDOG.md` / `WATCHDOG.yml`. What it does NOT do is route the *guidance
// content itself* to a specific target: every advised session receives the
// whole discovered roster. This extension adds exactly that — a `WATCHDOG-*.md`
// file declares in its frontmatter WHICH agent it watches (`target: main` or a
// subagent name) and WHICH model reviews, and its body only ever reaches that
// target. There is no ExtensionAPI hook into the native advisor, so this is a
// small self-contained reviewer, not an extension of the native subsystem.
//
// FILE FORMAT. `WATCHDOG-<label>.md`, discovered at:
//   - user level:  <agent dir>/WATCHDOG-*.md          (~/.omp/agent by default)
//   - repo level:  <dir>/WATCHDOG-*.md and <dir>/.omp/WATCHDOG-*.md, walking
//                  from cwd up to the git root.
// Frontmatter (Claude rule.md style, between `---` fences):
//   target: main            # main | <subagent-name> | * | subagents | CSV list
//   model:  anthropic/claude-sonnet-4-5:medium   # optional; else @advisor role
//   tools:  [read, grep, glob]                   # optional; reviewer's tools
//   name:   Architecture                          # optional label
//   enabled: true                                 # optional, default true
//   delivery: aside                               # aside|steer|nextTurn|followUp
//   maxPerContext: 6                              # optional safety cap
// Body after the frontmatter = the review priorities handed to the reviewer.
//
// RUNTIME. On each settled agent turn (`agent_end`, non-continuation) in a
// session whose identity matches a discovered watchdog, the extension renders a
// bounded tail of the transcript, runs each matching watchdog's reviewer model
// (its own read-only `createAgentSession`, with tools so it can inspect the
// workspace), and — when the reviewer flags something — injects a `<watchdog>`
// note back into that session via `sendUserMessage`. Repeats are de-duplicated
// and bounded per context so a stubborn model cannot loop.
//
// FAILURE POLICY. Every failure path (no match, unresolved model, reviewer
// error/timeout, malformed file) degrades to "no note". The extension never
// blocks, mutates, or corrupts a primary turn.
//
// SCOPE HONESTY. On a subagent the note is best-effort: it lands if the turn
// re-opens before the executor collects the slice result. On the main session a
// note delivered at idle starts a fresh turn (that is what an advisor does).
// ============================================================================

type Model = NonNullable<CreateAgentSessionOptions["model"]>;

/** Main session files are `<timestamp>_<uuid>.jsonl`; subagents are `<parent>/<name>.jsonl`. */
const MAIN_SESSION_FILE_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const WATCHDOG_FILE_PATTERN = /^WATCHDOG-.+\.md$/i;
/** Marks injected advisory user-messages so they are excluded from review + counting. */
const ADVISORY_TAG = "<watchdog";
const DEFAULT_TOOLS: readonly string[] = ["read", "grep", "glob"];
/** Reviewer tools we are willing to grant from frontmatter (superset stays read-only by default). */
const GRANTABLE_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	edit: true,
	write: true,
	bash: true,
	eval: true,
};
const THINKING_SUFFIXES: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

const TRANSCRIPT_BUDGET = 20_000; // chars of recent transcript handed to the reviewer.
const PER_ENTRY_LIMIT = 1_000; // chars kept per transcript entry.
const REVIEW_TIMEOUT_MS = 90_000; // hard cap on one reviewer run.
const DEFAULT_MAX_PER_CONTEXT = 6; // advisories before going quiet until a context reset.

type DeliverAs = "aside" | "steer" | "nextTurn" | "followUp";

type Identity = { readonly kind: "main" } | { readonly kind: "sub"; readonly agent: string; readonly fileId: string };

type WatchdogSpec = {
	readonly name: string;
	readonly targets: readonly string[];
	readonly model?: string;
	readonly tools: readonly string[];
	readonly delivery: DeliverAs;
	readonly maxPerContext: number;
	readonly guidance: string;
	readonly filePath: string;
};

type Verdict =
	| { readonly kind: "pass" }
	| { readonly kind: "advice"; readonly severity: "nit" | "concern" | "blocker"; readonly note: string };

/** Checked keyed access without an unchecked cast. */
function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
	return typeof value === "object" && value !== null && key in value;
}

function trunc(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// --- discovery + parsing ----------------------------------------------------

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".omp", "agent");
}

/** User agent dir + every dir from cwd up to (and including) the git root, plus each `.omp`. */
function discoverWatchdogFiles(cwd: string): string[] {
	const dirs: string[] = [agentDir()];
	const home = homedir();
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir, join(dir, ".omp"));
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir || dir === home) break;
		dir = parent;
	}
	const files: string[] = [];
	const seen = new Set<string>();
	for (const d of dirs) {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			continue;
		}
		for (const n of names) {
			if (!WATCHDOG_FILE_PATTERN.test(n)) continue;
			const p = join(d, n);
			if (seen.has(p)) continue;
			seen.add(p);
			files.push(p);
		}
	}
	return files;
}

/** Split a scalar/CSV/`[a, b]` frontmatter value into trimmed, unquoted items. */
function toList(value: string): string[] {
	let s = value.trim();
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	return s
		.split(",")
		.map(x => x.trim().replace(/^["']|["']$/g, "").trim())
		.filter(x => x !== "");
}

function unquote(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "").trim();
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const t = line.trim();
		if (t === "" || t.startsWith("#")) continue;
		const idx = t.indexOf(":");
		if (idx <= 0) continue;
		fields[t.slice(0, idx).trim().toLowerCase()] = t.slice(idx + 1).trim();
	}
	return { fields, body: raw.slice(m[0].length) };
}

/** Parse one `WATCHDOG-*.md`; returns null when disabled, targetless, or unreadable. */
function parseWatchdogFile(path: string): WatchdogSpec | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const { fields, body } = parseFrontmatter(raw);
	const enabled = fields.enabled === undefined || /^(true|yes|on|1)$/i.test(unquote(fields.enabled));
	if (!enabled) return null;
	const targets = fields.target ? toList(fields.target) : [];
	if (targets.length === 0) return null;

	const rawTools = fields.tools ? toList(fields.tools) : [...DEFAULT_TOOLS];
	const tools = rawTools.map(t => t.toLowerCase()).filter(t => GRANTABLE_TOOLS[t] === true);
	const delivery = normalizeDelivery(fields.delivery);
	const maxPerContext = normalizeCap(fields.maxpercontext);
	const fallbackName = basename(path).replace(/^WATCHDOG-/i, "").replace(/\.md$/i, "");

	return {
		name: fields.name ? unquote(fields.name) : fallbackName || "watchdog",
		targets,
		model: fields.model ? unquote(fields.model) : undefined,
		tools: tools.length > 0 ? tools : [...DEFAULT_TOOLS],
		delivery,
		maxPerContext,
		guidance: body.trim(),
		filePath: path,
	};
}

function normalizeDelivery(value: string | undefined): DeliverAs {
	switch (unquote(value ?? "").toLowerCase()) {
		case "steer":
			return "steer";
		case "nextturn":
			return "nextTurn";
		case "followup":
			return "followUp";
		default:
			return "aside";
	}
}

function normalizeCap(value: string | undefined): number {
	const n = Number.parseInt(unquote(value ?? ""), 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PER_CONTEXT;
}

// --- identity + matching ----------------------------------------------------

function resolveIdentity(ctx: ExtensionContext): Identity | null {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return null;
	const base = file.split(/[\\/]/).pop();
	if (!base) return null;
	if (MAIN_SESSION_FILE_PATTERN.test(base)) return { kind: "main" };
	const fileId = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
	let agent = fileId;
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"session_init"')) continue;
			try {
				const obj: unknown = JSON.parse(line);
				if (hasKey(obj, "type") && obj.type === "session_init" && hasKey(obj, "agent") && typeof obj.agent === "string" && obj.agent) {
					agent = obj.agent;
					break;
				}
			} catch {
				// keep scanning; a non-init line that merely contains the token is ignored.
			}
		}
	} catch {
		// session file unreadable → fall back to the file-id as the agent name.
	}
	return { kind: "sub", agent, fileId };
}

function matchesIdentity(spec: WatchdogSpec, identity: Identity): boolean {
	for (const target of spec.targets) {
		const t = target.toLowerCase();
		if (t === "*" || t === "all" || t === "any") return true;
		if (identity.kind === "main") {
			if (t === "main") return true;
			continue;
		}
		if (t === "subagents" || t === "subagent" || t === "sub" || t === "subs") return true;
		if (t === identity.agent.toLowerCase() || t === identity.fileId.toLowerCase()) return true;
	}
	return false;
}

// --- transcript rendering ---------------------------------------------------

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const b of content) {
		if (!hasKey(b, "type") || b.type !== "text") continue;
		if (hasKey(b, "text") && typeof b.text === "string") out += b.text;
	}
	return out;
}

function toolCallSummaries(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const calls: string[] = [];
	for (const b of content) {
		if (!hasKey(b, "type") || b.type !== "toolCall") continue;
		const name =
			hasKey(b, "toolName") && typeof b.toolName === "string"
				? b.toolName
				: hasKey(b, "name") && typeof b.name === "string"
					? b.name
					: "tool";
		const rawArgs = hasKey(b, "args") ? b.args : hasKey(b, "input") ? b.input : undefined;
		let args = "";
		try {
			args = rawArgs === undefined ? "" : trunc(JSON.stringify(rawArgs), 200);
		} catch {
			args = "";
		}
		calls.push(`${name}(${args})`);
	}
	return calls;
}

/** Number of real (non-advisory) message entries — the "has new work?" signal. */
function countableEntries(entries: ReadonlyArray<unknown>): number {
	let n = 0;
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "message") continue;
		const m = hasKey(e, "message") ? e.message : undefined;
		if (!hasKey(m, "role") || typeof m.role !== "string") continue;
		if (m.role === "user" && textBlocks(hasKey(m, "content") ? m.content : undefined).trimStart().startsWith(ADVISORY_TAG)) continue;
		if (m.role === "user" || m.role === "assistant" || m.role === "toolResult" || m.role === "developer") n++;
	}
	return n;
}

/** One entry's compact rendering, or undefined when it contributes nothing (incl. our own advisories). */
function renderEntry(e: unknown): string | undefined {
	if (!hasKey(e, "type") || e.type !== "message") return undefined;
	const m = hasKey(e, "message") ? e.message : undefined;
	if (!hasKey(m, "role") || typeof m.role !== "string") return undefined;
	const role = m.role;
	const content = hasKey(m, "content") ? m.content : undefined;
	if (role === "assistant") {
		const text = textBlocks(content).trim();
		const calls = toolCallSummaries(content);
		const segs: string[] = [];
		if (text) segs.push(`ASSISTANT: ${trunc(text, PER_ENTRY_LIMIT)}`);
		for (const c of calls) segs.push(`  → tool ${trunc(c, PER_ENTRY_LIMIT)}`);
		return segs.length > 0 ? segs.join("\n") : undefined;
	}
	if (role === "user") {
		const text = textBlocks(content).trim();
		if (text.startsWith(ADVISORY_TAG)) return undefined; // skip our own advisory injections
		return text ? `USER: ${trunc(text, PER_ENTRY_LIMIT)}` : undefined;
	}
	if (role === "toolResult") {
		const name = hasKey(m, "toolName") && typeof m.toolName === "string" ? m.toolName : "tool";
		return `RESULT[${name}]: ${trunc(textBlocks(content).trim(), PER_ENTRY_LIMIT)}`;
	}
	if (role === "developer") {
		const text = textBlocks(content).trim();
		return text ? `DEV: ${trunc(text, PER_ENTRY_LIMIT)}` : undefined;
	}
	return undefined;
}

/**
 * Bounded tail of the transcript, rendered compactly, excluding our own advisories.
 * Walks from the newest entry and stops once the budget is full, so per-turn cost
 * tracks the budget rather than the whole branch.
 */
function renderTranscript(entries: ReadonlyArray<unknown>, budget: number): string {
	let out = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const part = renderEntry(entries[i]);
		if (part === undefined) continue;
		const next = out ? `${part}\n${out}` : part;
		if (next.length > budget && out !== "") break;
		out = next;
	}
	return out;
}

// --- reviewer ---------------------------------------------------------------

function splitEffort(spec: string): { base: string; effort: string | undefined } {
	const t = spec.trim();
	const colon = t.lastIndexOf(":");
	if (colon > 0 && THINKING_SUFFIXES[t.slice(colon + 1).toLowerCase()] === true) {
		return { base: t.slice(0, colon), effort: t.slice(colon + 1).toLowerCase() };
	}
	return { base: t, effort: undefined };
}

function resolveModelSpec(ctx: ExtensionContext, base: string): Model | undefined {
	const resolved = ctx.models?.resolve?.(base);
	if (resolved) return resolved;
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	return available.find((m: Model) => `${m.provider}/${m.id}` === base) ?? available.find((m: Model) => m.id === base);
}

/** Reviewer model + thinking level: explicit `model` (honoring `:effort`), else the `advisor` role. */
function resolveReviewer(ctx: ExtensionContext, spec: WatchdogSpec): { model: Model; thinkingLevel: string } | null {
	if (spec.model) {
		const { base, effort } = splitEffort(spec.model);
		const model = resolveModelSpec(ctx, base);
		if (model) return { model, thinkingLevel: effort ?? "off" };
		return null;
	}
	for (const role of ["@advisor", "advisor", "@slow"]) {
		const model = ctx.models?.resolve?.(role);
		if (model) return { model, thinkingLevel: "off" };
	}
	const current = ctx.models?.current?.();
	return current ? { model: current, thinkingLevel: "off" } : null;
}

function buildReviewPrompt(guidance: string, transcript: string): string {
	return (
		`You are a code-review WATCHDOG silently observing another AI coding agent ("the primary agent") as it works in this repository. ` +
		`You are NOT the primary agent; do not perform its task.\n\n` +
		`Your review priorities:\n${guidance || "(no specific priorities configured; apply general senior-engineer judgment)"}\n\n` +
		`You may use your read-only tools to inspect the workspace and verify a concern before raising it. Investigate briefly; never rewrite the code.\n\n` +
		`Below is the recent transcript of the primary agent (oldest first, newest last). Judge only whether the LATEST work has a problem worth flagging.\n\n` +
		`Reply format — obey EXACTLY:\n` +
		`- If nothing is worth flagging, reply with the single word: PASS\n` +
		`- Otherwise reply with two lines:\n` +
		`SEVERITY: <nit|concern|blocker>\n` +
		`<one concise, concrete note, at most ~80 words, citing specific files/symbols/lines>\n\n` +
		`Do not restate the transcript. Do not add anything else.\n\n` +
		`TRANSCRIPT:\n"""\n${transcript}\n"""`
	);
}

function interpretVerdict(answer: string): Verdict | null {
	const trimmed = answer.trim();
	if (trimmed === "") return null;
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (/^(pass|ok|lgtm|none)\b/i.test(firstLine)) return { kind: "pass" };
	const sev = trimmed.match(/severity\s*:\s*(nit|concern|blocker)/i);
	const severity = (sev ? sev[1].toLowerCase() : "concern") as "nit" | "concern" | "blocker";
	let note = trimmed.replace(/^\s*severity\s*:\s*(nit|concern|blocker)\s*/i, "").trim();
	if (note === "") note = trimmed;
	return { kind: "advice", severity, note };
}

async function withTimeout(ctx: ExtensionContext, work: Promise<unknown>, ms: number): Promise<void> {
	if (typeof ctx.setTimeout !== "function") {
		await work.catch(() => undefined);
		return;
	}
	let timer: unknown;
	await Promise.race([
		work.catch(() => undefined),
		new Promise<void>(res => {
			timer = ctx.setTimeout(() => res(), ms);
		}),
	]);
	if (timer !== undefined && typeof ctx.clearTimer === "function") ctx.clearTimer(timer);
}

/** Runs one reviewer session over the transcript. Never throws; failures → null. */
async function runReviewer(pi: ExtensionAPI, ctx: ExtensionContext, spec: WatchdogSpec, transcript: string): Promise<Verdict | null> {
	const reviewer = resolveReviewer(ctx, spec);
	if (!reviewer) {
		pi.logger?.warn?.(`watchdog "${spec.name}": no reviewer model resolved (model=${spec.model ?? "@advisor"}) — skipping`);
		return null;
	}
	let deltas = "";
	let finalMessages: unknown;
	try {
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			model: reviewer.model,
			thinkingLevel: reviewer.thinkingLevel,
			sessionManager: SessionManager.inMemory(),
			toolNames: [...spec.tools],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			// Classify the helper as a subagent: a main-kind session's dispose tears
			// down the global AgentLifecycleManager and strands every live subagent.
			taskDepth: 1,
			agentId: `watchdog-${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchdog"}`,
		});
		const unsubscribe = session.subscribe((event: unknown) => {
			if (!hasKey(event, "type")) return;
			if (event.type === "message_update" && hasKey(event, "assistantMessageEvent")) {
				const a = event.assistantMessageEvent;
				if (hasKey(a, "type") && a.type === "text_delta" && hasKey(a, "delta") && typeof a.delta === "string") deltas += a.delta;
			} else if (event.type === "agent_end") {
				const terminal = !hasKey(event, "isTerminal") || event.isTerminal !== false;
				if (terminal) finalMessages = hasKey(event, "messages") ? event.messages : undefined;
			}
		});
		try {
			await withTimeout(ctx, session.prompt(buildReviewPrompt(spec.guidance, transcript)), REVIEW_TIMEOUT_MS);
		} finally {
			unsubscribe();
			await session.dispose().catch(() => undefined);
		}
	} catch (error) {
		pi.logger?.warn?.(`watchdog "${spec.name}": reviewer run failed`, { error: String(error) });
		return null;
	}

	const msgs = Array.isArray(finalMessages) ? finalMessages : [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!hasKey(m, "role") || m.role !== "assistant") continue;
		if (hasKey(m, "stopReason") && m.stopReason === "error") return null; // provider failure ≠ verdict
		break;
	}
	return interpretVerdict(deltas.trim() || lastAssistantText(finalMessages));
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!hasKey(m, "role") || m.role !== "assistant") continue;
		const text = textBlocks(hasKey(m, "content") ? m.content : undefined);
		if (text.trim() !== "") return text;
	}
	return "";
}

function normalizeNote(note: string): string {
	return note.toLowerCase().replace(/\s+/g, " ").trim();
}

// --- extension registration -------------------------------------------------

export default function watchdogAgent(pi: ExtensionAPI): void {
	let identified = false;
	let specs: WatchdogSpec[] = [];
	let lastReviewedCount = 0;
	let advisoriesSent = 0;
	let capTotal = DEFAULT_MAX_PER_CONTEXT;
	let exhausted = false;
	let reviewing = false;
	const sentNotes = new Set<string>();

	const resetCounters = (): void => {
		lastReviewedCount = 0;
		advisoriesSent = 0;
		exhausted = false;
		reviewing = false;
		sentNotes.clear();
	};

	const configure = (ctx: ExtensionContext): void => {
		const identity = resolveIdentity(ctx);
		identified = identity !== null;
		if (!identity) {
			specs = [];
			return;
		}
		const matched: WatchdogSpec[] = [];
		for (const file of discoverWatchdogFiles(ctx.cwd)) {
			const spec = parseWatchdogFile(file);
			if (spec && matchesIdentity(spec, identity)) matched.push(spec);
		}
		specs = matched;
		capTotal = matched.reduce((max, s) => Math.max(max, s.maxPerContext), DEFAULT_MAX_PER_CONTEXT);
		if (matched.length > 0) {
			const who = identity.kind === "main" ? "main" : `subagent "${identity.agent}"`;
			pi.logger?.info?.(`watchdog: ${matched.length} watchdog(s) active for ${who} — ${matched.map(s => s.name).join(", ")}`);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		resetCounters();
		configure(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		resetCounters();
		configure(ctx);
	});
	// Boundaries that rewrite the working transcript invalidate the review cursor + budget.
	pi.on("session_branch", () => resetCounters());
	pi.on("session_tree", () => resetCounters());
	pi.on("session_compact", () => resetCounters());

	pi.on("agent_end", async (event, ctx) => {
		// A session that had no file at start (identity unknown) is retried once, lazily.
		if (!identified) configure(ctx);
		if (specs.length === 0 || exhausted || reviewing) return;
		if (event.willContinue === true) return; // auto-continuation, not a settled turn.

		const entries = ctx.sessionManager.getBranch();
		const count = countableEntries(entries);
		if (count <= lastReviewedCount) return; // no new primary work since last review.

		reviewing = true;
		try {
			lastReviewedCount = count;
			const transcript = renderTranscript(entries, TRANSCRIPT_BUDGET);
			if (transcript.trim() === "") return;
			for (const spec of specs) {
				if (exhausted) break;
				const verdict = await runReviewer(pi, ctx, spec, transcript);
				if (!verdict || verdict.kind !== "advice") continue;
				const key = normalizeNote(verdict.note);
				if (key === "" || sentNotes.has(key)) continue;
				sentNotes.add(key);
				const safeName = spec.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
				const text = `<watchdog name="${safeName}" severity="${verdict.severity}">\n${verdict.note}\n</watchdog>`;
				pi.sendUserMessage(text, { deliverAs: spec.delivery, attribution: "agent" });
				pi.logger?.info?.(`watchdog "${spec.name}": ${verdict.severity} → delivered (${advisoriesSent + 1}/${capTotal})`);
				advisoriesSent += 1;
				if (advisoriesSent >= capTotal) exhausted = true;
			}
		} finally {
			reviewing = false;
		}
	});
}

// Pure-logic seam for out-of-harness verification (mirrors lang-nag's __testables).
// The model-calling path (runReviewer) still requires a live session and is not exposed.
export function __testables() {
	return {
		parseFrontmatter,
		parseWatchdogFile,
		toList,
		matchesIdentity,
		interpretVerdict,
		renderTranscript,
		countableEntries,
		splitEffort,
		normalizeDelivery,
		normalizeCap,
		normalizeNote,
		discoverWatchdogFiles,
	};
}
