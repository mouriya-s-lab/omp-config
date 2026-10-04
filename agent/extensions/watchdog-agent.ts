import {
	createAgentSession,
	SessionManager,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { TypeSafeJudge, isJudgmentApi } from "@oh-my-pi/pi-ai";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
//   model:  anthropic/claude-sonnet-4-5:medium   # chat reviewer; else @advisor role
//   tools:  [read, grep, glob]                   # optional; chat reviewer's tools
//   judge:  typesafe/jev-latest                  # alternative native Jev backend
//   instructions: Judge only the latest work.    # optional Jev question text
//   option.<label>: <criteria>                   # Jev choice option (>= 2); empty = name suffices
//   option.<label>.prompt: <text>                # injected when Jev picks <label>; omit = silent
//   option.<label>.delivery: steer               # optional per-option delivery override
//   name:   Architecture                          # optional label; `/watchdog` addresses it by name
//   enabled: true                                 # optional, default true; `/watchdog on|off <name> global` rewrites it
//   delivery: aside                               # aside|steer|nextTurn|followUp
//   maxPerContext: 6                              # optional per-watchdog cap; default unlimited
//   every:  30                                    # run after this many watched actions (default 30)
//   scope:  full                                  # full (whole branch, default) | window (since own last run)
// Body = review priorities for chat; judgment criterion for Jev. Jev evaluates
// only the supplied transcript and picks one configured option; the injected
// text is that option's author-written prompt. Jev has no tools, free-form
// explanation, or implicit chat fallback. Labels are lowercased (the frontmatter
// parser lowercases keys) and each value is a single line.
//
// RUNTIME. Every discovered watchdog matching the session identity runs
// independently with its own counter, cursor and cap. The counter
// accumulates the watched agent's actions: each assistant tool call and each
// assistant text reply counts as one. When a watchdog's counter reaches
// `every`, it runs immediately (mid-run), and its finding is injected as soon as
// the review finishes, whatever state the agent is in. When the agent's run
// settles (`agent_end`, non-continuation) with a nonzero counter below
// `every`, the watchdog runs once for the remainder. `scope: full` reviews the
// whole branch; `scope: window` reviews only messages after the cursor, which
// advances only when a review reaches a verdict and is persisted as a session
// entry. The transcript is never truncated. Chat reviewers use a
// tool-capable `createAgentSession`; native Jev uses `Judge.judge` and only
// selects one configured option whose prewritten prompt (if any) is injected.
// Findings go through `sendUserMessage`, bounded per watchdog per context when
// `maxPerContext` is set; `nextTurn` findings wait for the user's next prompt
// (a subagent's next turn) and arrive as a custom message. Each compaction
// starts a new context: the cap count resets, nothing else does. On session
// load or branch move the cursor is restored from its entries, the cap count
// from the findings already injected on the branch since the last compaction,
// and the counter from the actions after the cursor.
//
// COMMANDS. `/watchdog [list]` lists every discovered file with its global
// (`enabled`) and session state. `/watchdog on|off <name> [session|global]`
// switches one watchdog: `session` (default) records a session custom entry that
// shadows the file for this session only and follows the session branch;
// `global` rewrites the file's `enabled` line and drops this session's override.
// `/watchdog add <requirement>` and `/watchdog edit <name> [change]` send the
// model a prompt (attribution `agent`) carrying the request, every setting's
// default, the project and global paths and the other names in use (`edit`
// also the current file): the model drafts a complete file plus the expected
// behaviour (for `edit`, what changes against now), revises it in chat as the
// user names changes (no `ask`), and writes only after explicit confirmation.
// `/watchdog rm <name>` deletes the file after a UI confirmation and drops
// this session's override of it. Any successful `write`/`edit` touching a
// `WATCHDOG-*.md` re-reads the roster at once and appends the file's status
// (recognised and active, NOT recognised with the reason, valid but not
// searched, or removed) to that tool result.
// Subcommands, names and scopes are offered as argument completions.
//
// FAILURE POLICY. Every failure path (no match, unresolved model, judge
// unavailable, reviewer error/timeout, malformed file) degrades to "no note"
// and leaves the cursor where it was. Explicit native judge selection never
// falls back to a chat model. The extension never blocks, mutates, or corrupts
// a primary turn.
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

const REVIEW_TIMEOUT_MS = 90_000; // hard cap on one reviewer run.
const DEFAULT_MAX_PER_CONTEXT = Number.POSITIVE_INFINITY; // advisories per watchdog per context; unlimited unless configured.
const DEFAULT_EVERY = 30; // watched actions (tool calls + text replies) between runs.

/** Which messages a run reviews: the whole branch, or only those after the watchdog's previous run. */
type Scope = "full" | "window";

type DeliverAs = "aside" | "steer" | "nextTurn" | "followUp";

type Identity = { readonly kind: "main" } | { readonly kind: "sub"; readonly agent: string; readonly fileId: string };

type WatchdogBase = {
	readonly name: string;
	readonly targets: readonly string[];
	/** File-level (global) switch: frontmatter `enabled`, default true. A session override may shadow it. */
	readonly enabled: boolean;
	readonly delivery: DeliverAs;
	readonly maxPerContext: number;
	readonly every: number;
	readonly scope: Scope;
	readonly guidance: string;
	readonly filePath: string;
};

type ChatWatchdog = WatchdogBase & {
	readonly kind: "chat";
	readonly model?: string;
	readonly tools: readonly string[];
};

/** What happens when Jev picks an option: stay quiet, or inject the author's prompt. */
type JevOutcome =
	| { readonly kind: "silent" }
	| { readonly kind: "inject"; readonly prompt: string; readonly delivery: DeliverAs };

type JevOption = {
	readonly label: string;
	/** Rubric handed to Jev; null when the label alone is self-explanatory. */
	readonly criteria: string | null;
	readonly outcome: JevOutcome;
};

type JevWatchdog = WatchdogBase & {
	readonly kind: "jev";
	readonly judge: { readonly provider: string; readonly modelId: string };
	readonly instructions: string;
	readonly options: readonly JevOption[];
};

type WatchdogSpec = ChatWatchdog | JevWatchdog;

type Verdict =
	| { readonly kind: "pass" }
	| { readonly kind: "advice"; readonly severity: string; readonly note: string; readonly delivery: DeliverAs };

const DEFAULT_JEV_INSTRUCTIONS =
	"Judge only the latest work in the supplied transcript against the configured guidance. Do not infer facts outside the supplied transcript.";
const JEV_OPTION_KEY = /^option\.([a-z0-9_-]+)(?:\.(prompt|delivery))?$/;

/** Checked keyed access without an unchecked cast. */
function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
	return typeof value === "object" && value !== null && key in value;
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

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const m = raw.match(FRONTMATTER_PATTERN);
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

/**
 * The file text with frontmatter `enabled` set, replacing an existing `enabled:` line or
 * appending one as the last frontmatter line; everything else is kept byte for byte.
 * Null when the file has no frontmatter (it could not be a valid watchdog).
 */
function setFrontmatterEnabled(raw: string, enabled: boolean): string | null {
	const m = raw.match(FRONTMATTER_PATTERN);
	if (!m) return null;
	const blockStart = m[0].startsWith("---\r\n") ? 5 : 4;
	const blockEnd = blockStart + m[1].length;
	const eol = m[1].includes("\r\n") ? "\r\n" : "\n";
	const line = /^([ \t]*)enabled[ \t]*:.*$/im;
	const block = line.test(m[1]) ? m[1].replace(line, `$1enabled: ${enabled}`) : `${m[1]}${eol}enabled: ${enabled}`;
	return raw.slice(0, blockStart) + block + raw.slice(blockEnd);
}

type WatchdogParse =
	| { readonly kind: "ok"; readonly spec: WatchdogSpec }
	| { readonly kind: "invalid"; readonly reason: string };

/** Parse one `WATCHDOG-*.md` (enabled or not); invalid when unreadable, targetless, or a malformed Jev declaration. */
function parseWatchdogFile(path: string): WatchdogParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `cannot read: ${error instanceof Error ? error.message : String(error)}` };
	}
	const { fields, body } = parseFrontmatter(raw);
	const enabled = fields.enabled === undefined || /^(true|yes|on|1)$/i.test(unquote(fields.enabled));
	const targets = fields.target ? toList(fields.target) : [];
	if (targets.length === 0) return { kind: "invalid", reason: "frontmatter has no `target`" };

	const rawTools = fields.tools ? toList(fields.tools) : [...DEFAULT_TOOLS];
	const tools = rawTools.map(t => t.toLowerCase()).filter(t => GRANTABLE_TOOLS[t] === true);
	const delivery = normalizeDelivery(fields.delivery);
	const maxPerContext = parsePositiveInt(fields.maxpercontext, DEFAULT_MAX_PER_CONTEXT);
	const fallbackName = basename(path).replace(/^WATCHDOG-/i, "").replace(/\.md$/i, "");

	const common: WatchdogBase = {
		name: fields.name ? unquote(fields.name) : fallbackName || "watchdog",
		targets,
		enabled,
		delivery,
		maxPerContext,
		every: parsePositiveInt(fields.every, DEFAULT_EVERY),
		scope: normalizeScope(fields.scope),
		guidance: body.trim(),
		filePath: path,
	};
	if (fields.judge !== undefined) {
		const judge = unquote(fields.judge);
		const slash = judge.indexOf("/");
		if (fields.model !== undefined || fields.tools !== undefined || fields.note !== undefined || !common.guidance ||
			slash <= 0 || slash === judge.length - 1 || THINKING_SUFFIXES[judge.slice(judge.lastIndexOf(":") + 1).toLowerCase()] === true) {
			return { kind: "invalid", reason: "judge requires provider/model and a nonempty body; model, tools, note and thinking suffixes are not allowed" };
		}
		const parsed = parseJevOptions(fields, delivery);
		if (parsed.kind === "invalid") return parsed;
		const instructions = unquote(fields.instructions ?? "");
		return {
			kind: "ok",
			spec: {
				...common,
				kind: "jev",
				judge: { provider: judge.slice(0, slash), modelId: judge.slice(slash + 1) },
				instructions: instructions || DEFAULT_JEV_INSTRUCTIONS,
				options: parsed.options,
			},
		};
	}
	return {
		kind: "ok",
		spec: {
			...common,
			kind: "chat",
			model: fields.model ? unquote(fields.model) : undefined,
			tools: tools.length > 0 ? tools : [...DEFAULT_TOOLS],
		},
	};
}

type JevOptionsParse =
	| { readonly kind: "ok"; readonly options: readonly JevOption[] }
	| { readonly kind: "invalid"; readonly reason: string };

/** Collect flat `option.<label>[.prompt|.delivery]` keys into Jev options. */
function parseJevOptions(fields: Record<string, string>, defaultDelivery: DeliverAs): JevOptionsParse {
	const criteria = new Map<string, string | null>();
	const prompts = new Map<string, string>();
	const deliveries = new Map<string, DeliverAs>();
	for (const [key, raw] of Object.entries(fields)) {
		if (!key.startsWith("option.")) continue;
		const m = key.match(JEV_OPTION_KEY);
		if (!m) return { kind: "invalid", reason: `unsupported option key "${key}" (use option.<label>, option.<label>.prompt, option.<label>.delivery)` };
		const [, label, part] = m;
		const value = unquote(raw);
		switch (part) {
			case undefined:
				criteria.set(label, value || null);
				break;
			case "prompt":
				if (!value) return { kind: "invalid", reason: `option.${label}.prompt is empty (omit it for a silent option)` };
				prompts.set(label, value);
				break;
			case "delivery":
				deliveries.set(label, normalizeDelivery(value));
				break;
		}
	}
	for (const label of [...prompts.keys(), ...deliveries.keys()]) {
		if (!criteria.has(label)) return { kind: "invalid", reason: `option.${label} is not declared (add option.${label}: <criteria>)` };
	}
	for (const label of deliveries.keys()) {
		if (!prompts.has(label)) return { kind: "invalid", reason: `option.${label}.delivery set on a silent option` };
	}
	if (criteria.size < 2) return { kind: "invalid", reason: "judge requires at least two option.<label> entries" };
	if (prompts.size === 0) return { kind: "invalid", reason: "judge requires at least one option.<label>.prompt" };
	const options: JevOption[] = [];
	for (const [label, rubric] of criteria) {
		const prompt = prompts.get(label);
		options.push({
			label,
			criteria: rubric,
			outcome: prompt === undefined
				? { kind: "silent" }
				: { kind: "inject", prompt, delivery: deliveries.get(label) ?? defaultDelivery },
		});
	}
	return { kind: "ok", options };
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(unquote(value ?? ""), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeScope(value: string | undefined): Scope {
	return unquote(value ?? "").toLowerCase() === "window" ? "window" : "full";
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
		const rawArgs = hasKey(b, "args") ? b.args : hasKey(b, "arguments") ? b.arguments : hasKey(b, "input") ? b.input : undefined;
		let args = "";
		try {
			args = rawArgs === undefined ? "" : JSON.stringify(rawArgs);
		} catch {
			args = "";
		}
		calls.push(`${name}(${args})`);
	}
	return calls;
}

/** Watched actions in one message: each assistant tool call plus one for a nonempty text reply. */
function countActions(message: unknown): number {
	if (!hasKey(message, "role") || message.role !== "assistant") return 0;
	const content = hasKey(message, "content") ? message.content : undefined;
	return toolCallSummaries(content).length + (textBlocks(content).trim() === "" ? 0 : 1);
}

function messageTimestamp(message: unknown): number | undefined {
	return hasKey(message, "timestamp") && typeof message.timestamp === "number" ? message.timestamp : undefined;
}

/** One message's full rendering, or undefined when it contributes nothing (incl. our own advisories). */
function renderMessage(m: unknown): string | undefined {
	if (!hasKey(m, "role") || typeof m.role !== "string") return undefined;
	const role = m.role;
	const content = hasKey(m, "content") ? m.content : undefined;
	if (role === "assistant") {
		const text = textBlocks(content).trim();
		const segs: string[] = [];
		if (text) segs.push(`ASSISTANT: ${text}`);
		for (const c of toolCallSummaries(content)) segs.push(`  → tool ${c}`);
		return segs.length > 0 ? segs.join("\n") : undefined;
	}
	if (role === "user") {
		const text = textBlocks(content).trim();
		if (text.startsWith(ADVISORY_TAG)) return undefined; // skip our own advisory injections
		return text ? `USER: ${text}` : undefined;
	}
	if (role === "toolResult") {
		const name = hasKey(m, "toolName") && typeof m.toolName === "string" ? m.toolName : "tool";
		return `RESULT[${name}]: ${textBlocks(content).trim()}`;
	}
	if (role === "developer") {
		const text = textBlocks(content).trim();
		return text ? `DEV: ${text}` : undefined;
	}
	return undefined;
}

/** Messages on the branch, oldest first; non-message entries (compaction markers, labels, …) are skipped. */
function branchMessages(entries: ReadonlyArray<unknown>): unknown[] {
	const out: unknown[] = [];
	for (const e of entries) {
		if (hasKey(e, "type") && e.type === "message" && hasKey(e, "message")) out.push(e.message);
	}
	return out;
}

/**
 * Messages a run reviews. `full` = every branch message; `window` = those stamped after
 * `after`. `tail` is the message that triggered a mid-run review: `message_end` persistence
 * is queued concurrently with the event, so it is appended when the branch lacks it yet.
 */
function selectMessages(entries: ReadonlyArray<unknown>, scope: Scope, after: number, tail: unknown): unknown[] {
	const all = branchMessages(entries);
	const tailStamp = messageTimestamp(tail);
	if (tail !== undefined && tailStamp !== undefined && !all.some(m => messageTimestamp(m) === tailStamp)) all.push(tail);
	if (scope === "full") return all;
	return all.filter(m => (messageTimestamp(m) ?? 0) > after);
}

/** Full, untruncated rendering of the given messages, oldest first. */
function renderTranscript(messages: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const m of messages) {
		const part = renderMessage(m);
		if (part !== undefined) parts.push(part);
	}
	return parts.join("\n");
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

/** Model a chat watchdog without `model` reviews with: the advisor role chain, else the session model. */
function defaultReviewerModel(ctx: ExtensionContext): Model | undefined {
	for (const role of ["@advisor", "advisor", "@slow"]) {
		const model = ctx.models?.resolve?.(role);
		if (model) return model;
	}
	return ctx.models?.current?.();
}

/** Reviewer model + thinking level: explicit `model` (honoring `:effort`), else the `advisor` role. */
function resolveReviewer(ctx: ExtensionContext, spec: ChatWatchdog): { model: Model; thinkingLevel: string } | null {
	if (!spec.model) {
		const model = defaultReviewerModel(ctx);
		return model ? { model, thinkingLevel: "off" } : null;
	}
	const { base, effort } = splitEffort(spec.model);
	const model = resolveModelSpec(ctx, base);
	return model ? { model, thinkingLevel: effort ?? "off" } : null;
}

function buildReviewPrompt(guidance: string, transcript: string): string {
	return (
		`You are a code-review WATCHDOG silently observing another AI coding agent ("the primary agent") as it works in this repository. ` +
		`You are NOT the primary agent; do not perform its task.\n\n` +
		`Your review priorities:\n${guidance || "(no specific priorities configured; apply general senior-engineer judgment)"}\n\n` +
		`You may use your read-only tools to inspect the workspace and verify a concern before raising it. Investigate briefly; never rewrite the code.\n\n` +
		`Below is the primary agent's transcript (oldest first, newest last). Judge only whether the LATEST work has a problem worth flagging.\n\n` +
		`Reply format — obey EXACTLY:\n` +
		`- If nothing is worth flagging, reply with the single word: PASS\n` +
		`- Otherwise reply with two lines:\n` +
		`SEVERITY: <nit|concern|blocker>\n` +
		`<one concise, concrete note, at most ~80 words, citing specific files/symbols/lines>\n\n` +
		`Do not restate the transcript. Do not add anything else.\n\n` +
		`TRANSCRIPT:\n"""\n${transcript}\n"""`
	);
}

function interpretVerdict(answer: string, delivery: DeliverAs): Verdict | null {
	const trimmed = answer.trim();
	if (trimmed === "") return null;
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (/^(pass|ok|lgtm|none)\b/i.test(firstLine)) return { kind: "pass" };
	const sev = trimmed.match(/severity\s*:\s*(nit|concern|blocker)/i);
	const severity = sev ? sev[1].toLowerCase() : "concern";
	let note = trimmed.replace(/^\s*severity\s*:\s*(nit|concern|blocker)\s*/i, "").trim();
	if (note === "") note = trimmed;
	return { kind: "advice", severity, note, delivery };
}

type RunOutcome = "done" | "failed" | "timeout";

async function withTimeout(ctx: ExtensionContext, work: Promise<unknown>, ms: number): Promise<RunOutcome> {
	const settled = work.then(
		(): RunOutcome => "done",
		(): RunOutcome => "failed",
	);
	if (typeof ctx.setTimeout !== "function") return settled;
	let timer: unknown;
	const outcome = await Promise.race([
		settled,
		new Promise<RunOutcome>(res => {
			timer = ctx.setTimeout(() => res("timeout"), ms);
		}),
	]);
	if (timer !== undefined && typeof ctx.clearTimer === "function") ctx.clearTimer(timer);
	return outcome;
}

/** Runs one reviewer session over the transcript. Never throws; failures → null. */
async function runReviewer(pi: ExtensionAPI, ctx: ExtensionContext, spec: ChatWatchdog, transcript: string): Promise<Verdict | null> {
	const reviewer = resolveReviewer(ctx, spec);
	if (!reviewer) {
		pi.logger?.warn?.(`watchdog "${spec.name}": no reviewer model resolved (model=${spec.model ?? "@advisor"}) — skipping`);
		return null;
	}
	let deltas = "";
	let finalMessages: unknown;
	let outcome: RunOutcome = "failed";
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
			outcome = await withTimeout(ctx, session.prompt(buildReviewPrompt(spec.guidance, transcript)), REVIEW_TIMEOUT_MS);
		} finally {
			unsubscribe();
			await session.dispose().catch(() => undefined);
		}
	} catch (error) {
		pi.logger?.warn?.(`watchdog "${spec.name}": reviewer run failed`, { error: String(error) });
		return null;
	}
	// A timed-out or failed prompt may have streamed partial text; it is not a verdict.
	if (outcome !== "done") {
		pi.logger?.warn?.(`watchdog "${spec.name}": reviewer ${outcome === "timeout" ? "timed out" : "failed"} — skipping`);
		return null;
	}

	const msgs = Array.isArray(finalMessages) ? finalMessages : [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!hasKey(m, "role") || m.role !== "assistant") continue;
		if (hasKey(m, "stopReason") && m.stopReason === "error") return null; // provider failure ≠ verdict
		break;
	}
	return interpretVerdict(deltas.trim() || lastAssistantText(finalMessages), spec.delivery);
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

/** Native Jev answers a typed choice, not a chat message. The injected text is the chosen option's author-written prompt. */
async function runJev(pi: ExtensionAPI, ctx: ExtensionContext, spec: JevWatchdog, transcript: string): Promise<Verdict | null> {
	// Match by judgment API, not catalog kind: a custom `models.yml` provider declared with
	// `api: typesafe` keeps the default `chat` kind unless the provider is named `typesafe`.
	const model = ctx.modelRegistry.getAvailable("all").find(
		candidate => candidate.provider === spec.judge.provider && candidate.id === spec.judge.modelId,
	);
	if (!model || !isJudgmentApi(model.api)) {
		pi.logger?.warn?.(`watchdog "${spec.name}": native judge ${spec.judge.provider}/${spec.judge.modelId} unavailable — skipping`);
		return null;
	}
	const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal });
		if (!apiKey) {
			pi.logger?.warn?.(`watchdog "${spec.name}": native judge credentials unavailable — skipping`);
			return null;
		}
		const headers = await ctx.modelRegistry.resolveModelHeaders(model, signal);
		const judge = new TypeSafeJudge({
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			api: model.api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
			headers,
		});
		const criteria: Record<string, string | null> = {};
		for (const option of spec.options) criteria[option.label] = option.criteria;
		const result = await judge.judge({
			state: { guidance: spec.guidance, transcript },
			questions: { review: { type: "choice", instructions: spec.instructions, criteria } },
		}, { signal });
		if (result.usage.cost.total === 0) {
			// Extensions resolve only omp's host packages (pi-agent-core, pi-ai, pi-coding-agent,
			// pi-natives, pi-tui, pi-utils), so catalog `calculateCost` is unreachable here.
			// Judgments report only input/output tokens; price them at the model's base rates.
			const cost = result.usage.cost;
			cost.input = (model.cost.input / 1_000_000) * result.usage.input;
			cost.output = (model.cost.output / 1_000_000) * result.usage.output;
			cost.total = cost.input + cost.output;
		}
		pi.logger?.info?.(`watchdog "${spec.name}": native judge usage`, {
			provider: result.provider,
			model: result.model,
			input: result.usage.input,
			output: result.usage.output,
			cost: result.usage.cost.total,
		});
		const choice = result.answers.review.choice;
		const picked = spec.options.find(option => option.label === choice);
		if (!picked) {
			pi.logger?.warn?.(`watchdog "${spec.name}": native judge returned an unconfigured choice — skipping`);
			return null;
		}
		switch (picked.outcome.kind) {
			case "silent":
				return { kind: "pass" };
			case "inject":
				return { kind: "advice", severity: picked.label, note: picked.outcome.prompt, delivery: picked.outcome.delivery };
		}
	} catch (error) {
		pi.logger?.warn?.(`watchdog "${spec.name}": native judge failed — skipping`, {
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

// --- extension registration -------------------------------------------------

type RunState = { readonly kind: "idle" } | { readonly kind: "running"; readonly flushAfter: boolean };

/** Per-watchdog runtime state; each watchdog counts, runs and caps on its own. */
type WatchdogState = {
	/** Latest parse of the watchdog's file; replaced in place when the roster is re-read. */
	spec: WatchdogSpec;
	/** Watched actions since this watchdog's last run started; restored as the actions after the cursor. */
	pending: number;
	/** Newest message timestamp covered by the last review that reached a verdict; persisted per file. */
	cursor: number;
	run: RunState;
	/** Advisories delivered since the last compaction; restored from the branch; compared against `maxPerContext`. */
	sent: number;
};

/** Session-scoped switch for one watchdog file, persisted as a custom session entry. */
const OVERRIDE_ENTRY_TYPE = "mouriya.omp.watchdog-agent.override";
type SessionOverride = { readonly filePath: string; readonly enabled: boolean | null };

function parseOverride(data: unknown): SessionOverride | null {
	if (!hasKey(data, "filePath") || typeof data.filePath !== "string" || !hasKey(data, "enabled")) return null;
	const enabled = data.enabled;
	if (enabled !== null && typeof enabled !== "boolean") return null;
	return { filePath: data.filePath, enabled };
}

/** Session overrides in effect on the given branch: the last entry per file wins; `null` clears. */
function overridesFromBranch(entries: ReadonlyArray<unknown>): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "custom" || !hasKey(e, "customType") || e.customType !== OVERRIDE_ENTRY_TYPE) continue;
		const parsed = parseOverride(hasKey(e, "data") ? e.data : undefined);
		if (!parsed) continue;
		if (parsed.enabled === null) out.delete(parsed.filePath);
		else out.set(parsed.filePath, parsed.enabled);
	}
	return out;
}

/** Window cursor of one watchdog file, persisted after each review that reaches a verdict. */
const CURSOR_ENTRY_TYPE = "mouriya.omp.watchdog-agent.cursor";
type CursorEntry = { readonly filePath: string; readonly cursor: number };

/** Cursors in effect on the given branch: the last entry per file wins. */
function cursorsFromBranch(entries: ReadonlyArray<unknown>): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of entries) {
		if (!hasKey(e, "type") || e.type !== "custom" || !hasKey(e, "customType") || e.customType !== CURSOR_ENTRY_TYPE) continue;
		const data = hasKey(e, "data") ? e.data : undefined;
		if (!hasKey(data, "filePath") || typeof data.filePath !== "string" || !hasKey(data, "cursor") || typeof data.cursor !== "number") continue;
		out.set(data.filePath, data.cursor);
	}
	return out;
}

/** Attribute-safe watchdog name, as written into the injected `<watchdog name="…">` tag. */
function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Custom message type of `nextTurn` deliveries (stored as `custom_message` session entries). */
const NEXT_TURN_CUSTOM_TYPE = "watchdog";

/** Findings of the named watchdog injected on the branch since its last compaction: user messages, and the `watchdog` custom messages `nextTurn` delivers. */
function deliveredSinceCompaction(entries: ReadonlyArray<unknown>, name: string): number {
	const marker = `<watchdog name="${escapeAttr(name)}"`;
	let count = 0;
	for (const e of entries) {
		if (!hasKey(e, "type")) continue;
		if (e.type === "compaction") {
			count = 0;
			continue;
		}
		let content: unknown;
		if (e.type === "custom_message" && hasKey(e, "customType") && e.customType === NEXT_TURN_CUSTOM_TYPE) {
			content = hasKey(e, "content") ? e.content : undefined;
		} else if (e.type === "message" && hasKey(e, "message") && hasKey(e.message, "role") && e.message.role === "user") {
			content = hasKey(e.message, "content") ? e.message.content : undefined;
		} else {
			continue;
		}
		count += textBlocks(content).split(marker).length - 1;
	}
	return count;
}

/** Watched actions on the branch stamped after the cursor. */
function actionsAfter(entries: ReadonlyArray<unknown>, cursor: number): number {
	let count = 0;
	for (const m of branchMessages(entries)) {
		if ((messageTimestamp(m) ?? 0) > cursor) count += countActions(m);
	}
	return count;
}

type Toggle = "on" | "off";
type ToggleScope = "session" | "global";

/** `/watchdog` arguments after parsing. */
type WatchdogCommand =
	| { readonly kind: "list" }
	| { readonly kind: "toggle"; readonly toggle: Toggle; readonly name: string; readonly scope: ToggleScope }
	| { readonly kind: "add"; readonly requirement: string }
	| { readonly kind: "rm"; readonly name: string }
	/** `rest` is `<name> [change]`; the name may contain spaces, so it is split against the roster. */
	| { readonly kind: "edit"; readonly rest: string }
	| { readonly kind: "invalid"; readonly reason: string };

const WATCHDOG_USAGE =
	"usage: /watchdog [list] | on|off <name> [session|global] | add <requirement> | edit <name> [change] | rm <name>";

function parseWatchdogCommand(args: string): WatchdogCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = (tokens[0] ?? "list").toLowerCase();
	const rest = args.trim().slice(sub.length).trim();
	switch (sub) {
		case "list":
			return tokens.length <= 1 ? { kind: "list" } : { kind: "invalid", reason: WATCHDOG_USAGE };
		case "add":
			return rest === "" ? { kind: "invalid", reason: "usage: /watchdog add <requirement> — describe what the watchdog should catch" } : { kind: "add", requirement: rest };
		case "rm":
			return rest === "" ? { kind: "invalid", reason: "usage: /watchdog rm <name>" } : { kind: "rm", name: rest };
		case "edit":
			return rest === "" ? { kind: "invalid", reason: "usage: /watchdog edit <name> [change]" } : { kind: "edit", rest };
		case "on":
		case "off": {
			const words = tokens.slice(1);
			const last = words.at(-1)?.toLowerCase();
			const scope: ToggleScope = last === "global" ? "global" : "session";
			const nameTokens = last === "global" || last === "session" ? words.slice(0, -1) : words;
			if (nameTokens.length === 0) return { kind: "invalid", reason: WATCHDOG_USAGE };
			return { kind: "toggle", toggle: sub, name: nameTokens.join(" "), scope };
		}
		default:
			return { kind: "invalid", reason: WATCHDOG_USAGE };
	}
}

/** Project root for new project-level watchdogs: the nearest git root above cwd (not past home), else cwd. */
function projectRoot(cwd: string): string {
	const home = homedir();
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === home) return resolve(cwd);
		dir = parent;
	}
}

/** Hashline `edit` file headers (`[path#TAG]`) and `MV` destinations; other edit modes carry `path`. */
const EDIT_PATH_PATTERN = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]|^MV\s+"?([^"\n]+?)"?\s*$/gm;

/** Absolute `WATCHDOG-*.md` paths a successful `write` or `edit` call touched. */
function touchedWatchdogFiles(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const raw: string[] = [];
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") raw.push(input.path);
	if (toolName === "edit" && typeof input.input === "string") {
		for (const m of input.input.matchAll(EDIT_PATH_PATTERN)) raw.push(m[1] ?? m[2]);
	}
	const files = new Set<string>();
	for (const path of raw) {
		const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
		const absolute = resolve(cwd, expanded);
		if (WATCHDOG_FILE_PATTERN.test(basename(absolute))) files.add(absolute);
	}
	return [...files];
}

/** Facts every `/watchdog add|edit` draft depends on. */
type DraftContext = {
	readonly projectDir: string;
	readonly globalDir: string;
	/** Every discovered watchdog; names in use. */
	readonly existing: readonly WatchdogSpec[];
	/** `provider/id` the chat reviewer resolves to without `model`, or null when nothing resolves. */
	readonly defaultModel: string | null;
};

const WATCHDOG_INTRO =
	"A watchdog is a reviewer that runs alongside a watched agent: every few actions it reads that agent's transcript, judges only the latest work against the file's guidance, and injects a short `<watchdog name=… severity=…>` note into the watched session when the work falls short; otherwise it stays silent. Each watchdog is one file `WATCHDOG-<Label>.md`: a frontmatter block between `---` fences (one `key: value` per line, keys case-insensitive, every value on a single line) followed by a markdown body.";

const EXPECTED_BEHAVIOUR =
	"Expected behaviour, concretely: which session or agent is watched; when a review runs (after how many actions, plus once at the end of each run); what transcript it reads; what it flags and what it deliberately lets pass; one or two example notes it would inject, written as it would write them; how and when a note reaches the watched agent; how many notes per context; which model does the reviewing and that every review costs a model call; and what it cannot see or do.";

const NO_ASK = "Do not use the `ask` tool: every setting has a value or a default, so every draft is complete and the user only names what to change.";

const WRITE_STATUS =
	"The `write`/`edit` result then carries this watchdog's status line from the watchdog extension; if it says the file is not recognised or not searched, fix that and write again.";

/** Settings, defaults, Jev rules and names in use, shared by the add and edit prompts. */
function settingsReference(draft: DraftContext, exclude: string | null): string {
	const others = draft.existing.filter(spec => spec.filePath !== exclude);
	const existing = others.length === 0
		? "(none)"
		: others.map(spec => `- ${spec.name} — target ${spec.targets.join(",")} — ${spec.filePath}`).join("\n");
	const defaultModel = draft.defaultModel ?? "nothing resolves now, so reviews would be skipped until a model is pinned";
	return `Settings (frontmatter keys in backticks):
- Location — default project: \`${draft.projectDir}/WATCHDOG-<Label>.md\`, active in sessions started anywhere inside this project. Global: \`${draft.globalDir}/WATCHDOG-<Label>.md\`, active in every project.
- Label and \`name\` — default: a short PascalCase label derived from the requirement; \`name\` defaults to the label, so omit the \`name\` line. \`/watchdog on|off|edit|rm\` address it by name, so it must not clash with another watchdog.
- \`target\` (required) — default \`main\`, the user's top-level session. Also: an agent name such as \`task:mid\` or \`mentor:default\`; \`subagents\` for every subagent; \`*\` for every session; or a comma-separated list.
- Backend — default chat reviewer: an extension-free model session with tools reads the transcript and answers PASS or a severity (\`nit\`, \`concern\`, \`blocker\`) with one note of at most ~80 words citing files, symbols or lines. Alternative Jev judge (see below): no tools, picks one of the options the file declares and injects that option's prewritten text.
- \`model\` (chat only) — default: omit the line, and the reviewer uses the \`@advisor\` role, then \`advisor\`, then \`@slow\`, then the session model; right now that is ${defaultModel}. Pin with \`provider/model\` or \`provider/model:effort\`; a pinned model that does not resolve skips every review rather than falling back.
- \`tools\` (chat only) — default \`read, grep, glob\`. Allowed: read, grep, glob, ast_grep, web_search, edit, write, bash, eval; edit, write, bash and eval let the reviewer change the workspace, so grant them only on request.
- \`delivery\` — default \`aside\`: while the watched agent runs, the note lands at its next step boundary without interrupting; when it is idle, the note starts a new turn. \`steer\` interrupts the current run; \`followUp\` queues the note after the current run; \`nextTurn\` holds it until the user's next real prompt (a subagent's next turn) and is lost if the session restarts first.
- \`every\` — default 30: watched actions between reviews, counting each tool call and each non-empty text reply; a run that ends with fewer leftover actions is reviewed once more at its end.
- \`scope\` — default \`full\`: every review reads the whole branch. \`window\`: only messages since the previous review reached a verdict, which keeps long sessions cheap but loses older context.
- \`maxPerContext\` — default: omit, unlimited. A number caps notes per context; once capped, no reviews run until the next compaction resets the count.
- \`enabled\` — default: omit, on.
- Body (chat) — the review priorities: what to flag and what to let pass, concrete enough that PASS is the common answer.

Jev judge, only when the user picks it: \`judge: provider/model\` (for example \`typesafe/jev-latest\`) replaces \`model\` and \`tools\`, and no \`:effort\` suffix is allowed. The body is required and is the judgment criterion. Optional \`instructions\` line. Declare at least two options as \`option.<label>: <criteria>\` (labels: lowercase letters, digits, \`_\`, \`-\`; an empty criteria means the label says it all). \`option.<label>.prompt: <text>\` is injected verbatim when Jev picks that label, and at least one option needs it; options without a prompt are silent passes. \`option.<label>.delivery\` overrides \`delivery\` for one prompted option. The severity shown is the picked label.

Write only \`target\` and the lines whose values differ from their defaults; omitted lines take the defaults above.

Other watchdogs (names in use):
${existing}`;
}

function buildAddPrompt(requirement: string, draft: DraftContext): string {
	return `<watchdog-add>
The user ran \`/watchdog add\` to add a watchdog. Their requirement, verbatim:
"""
${requirement}
"""

${WATCHDOG_INTRO}

Settle the file with the user in chat rounds. ${NO_ASK}

1. Draft. Fill every setting below: take a value from the requirement when it states or clearly implies one, otherwise keep the default. Reply with, in this order:
   - ${EXPECTED_BEHAVIOUR}
   - A settings table with every setting: value, source (\`requirement\` or \`default\`), and a one-line effect, so the user can change any setting by name.
   - The full file content and its absolute path.
   - One closing line asking which settings to change, or for confirmation to write it.
   Write nothing to disk in this round.
2. Revise. When the user names changes, apply them and reply again in the shape of step 1, marking the changed values. A reply that only changes settings is not a confirmation.
3. Write. Only after the user explicitly confirms the latest draft, create the file with \`write\`. Never overwrite an existing file; if the path exists, choose another label and say so. ${WRITE_STATUS} End with one short paragraph on what happens from now on and how to switch it off (\`/watchdog off <name>\` for this session, \`/watchdog off <name> global\` for good).

${settingsReference(draft, null)}
</watchdog-add>`;
}

function buildEditPrompt(spec: WatchdogSpec, current: string, requirement: string | null, draft: DraftContext): string {
	const request = requirement === null
		? "They named no change yet."
		: `The change they want, verbatim:\n"""\n${requirement}\n"""`;
	return `<watchdog-edit>
The user ran \`/watchdog edit\` to change the watchdog \`${spec.name}\` at \`${spec.filePath}\`. ${request}

Current file content, verbatim:
"""
${current}
"""

${WATCHDOG_INTRO}

Settle the change with the user in chat rounds. ${NO_ASK}

1. Draft. Start from the current file and apply the requested change; every setting the request does not touch keeps its current value, and a line the file omits keeps its default. With no change named, the draft is the current file as it is. Reply with, in this order:
   - What changes compared with the current behaviour, then the full expected behaviour after the change. ${EXPECTED_BEHAVIOUR}
   - A settings table with every setting: current value, new value, source (\`current\`, \`requirement\`, or \`default\` for a line the file omits), and a one-line effect, so the user can change any setting by name.
   - The full new file content and its absolute path.
   - One closing line asking which settings to change, or for confirmation to write it.
   Write nothing to disk in this round.
2. Revise. When the user names changes, apply them and reply again in the shape of step 1, marking the changed values. A reply that only changes settings is not a confirmation.
3. Write. Only after the user explicitly confirms the latest draft, rewrite the file at its current path. A location or label change writes the new file, then removes the old one, and the new path must not already exist. ${WRITE_STATUS} End with one short paragraph on what happens from now on.

${settingsReference(draft, spec.filePath)}
</watchdog-edit>`;
}

export default function watchdogAgent(pi: ExtensionAPI): void {
	let identity: Identity | null = null;
	let cwd = process.cwd();
	/** Every discovered watchdog file, enabled or not, whatever its target. */
	let roster: WatchdogSpec[] = [];
	let overrides = new Map<string, boolean>();
	/** Runtime state of the watchdogs active in this session, keyed by file path. */
	let states = new Map<string, WatchdogState>();
	/** The loaded session's branch; source of restored cursors, cap counts and pending actions. */
	let branchOf: () => ReadonlyArray<unknown> = () => [];
	/** `nextTurn` findings waiting for the next user prompt (a subagent's next turn). */
	let nextTurnQueue: string[] = [];
	/** Set by a user prompt; consumed by the turn it starts. */
	let userTurnArmed = false;

	const targetsHere = (spec: WatchdogSpec): boolean => identity !== null && matchesIdentity(spec, identity);
	const effectiveEnabled = (spec: WatchdogSpec): boolean => overrides.get(spec.filePath) ?? spec.enabled;

	/** Re-read every watchdog file and rebuild the active set, keeping state of watchdogs that stay active. */
	const refresh = (warn: boolean): void => {
		const specs: WatchdogSpec[] = [];
		for (const file of discoverWatchdogFiles(cwd)) {
			const parsed = parseWatchdogFile(file);
			if (parsed.kind === "ok") specs.push(parsed.spec);
			else if (warn) pi.logger?.warn?.(`watchdog "${file}": ${parsed.reason}`);
		}
		roster = specs;
		const next = new Map<string, WatchdogState>();
		const branch = branchOf();
		const cursors = cursorsFromBranch(branch);
		for (const spec of specs) {
			if (!targetsHere(spec) || !effectiveEnabled(spec)) continue;
			const prev = states.get(spec.filePath);
			if (prev) {
				prev.spec = spec;
				next.set(spec.filePath, prev);
				continue;
			}
			const cursor = cursors.get(spec.filePath) ?? 0;
			next.set(spec.filePath, {
				spec,
				pending: actionsAfter(branch, cursor),
				cursor,
				run: { kind: "idle" },
				sent: deliveredSinceCompaction(branch, spec.name),
			});
		}
		states = next;
	};

	const logActive = (): void => {
		if (!identity) return;
		const who = identity.kind === "main" ? "main" : `subagent "${identity.agent}"`;
		const active = [...states.values()].map(s => `${s.spec.name}(every=${s.spec.every}, scope=${s.spec.scope})`);
		pi.logger?.info?.(`watchdog: ${active.length} watchdog(s) active for ${who}${active.length > 0 ? ` — ${active.join(", ")}` : ""}`);
	};

	/** Session boundary: identity, overrides and the active set are rebuilt; state is restored from the branch. */
	const load = (ctx: ExtensionContext): void => {
		identity = resolveIdentity(ctx);
		cwd = ctx.cwd;
		branchOf = () => ctx.sessionManager.getBranch();
		overrides = overridesFromBranch(branchOf());
		states = new Map();
		nextTurnQueue = [];
		userTurnArmed = false;
		refresh(true);
		logActive();
	};

	const deliver = (state: WatchdogState, verdict: Verdict): void => {
		if (verdict.kind !== "advice") return;
		const spec = state.spec;
		if (verdict.note.trim() === "" || state.sent >= spec.maxPerContext) return;
		const text = `<watchdog name="${escapeAttr(spec.name)}" severity="${verdict.severity}">\n${verdict.note}\n</watchdog>`;
		if (verdict.delivery === "nextTurn") nextTurnQueue.push(text);
		else pi.sendUserMessage(text, { deliverAs: verdict.delivery, attribution: "agent" });
		state.sent += 1;
		pi.logger?.info?.(`watchdog "${spec.name}": ${verdict.severity} → ${verdict.delivery === "nextTurn" ? "queued for next turn" : "delivered"} (${state.sent}/${Number.isFinite(spec.maxPerContext) ? spec.maxPerContext : "∞"})`);
	};

	/** Advance and persist the window cursor once a review covering up to `reviewed` reached a verdict. */
	const advanceCursor = (state: WatchdogState, reviewed: number): void => {
		if (reviewed <= state.cursor) return;
		state.cursor = reviewed;
		pi.appendEntry<CursorEntry>(CURSOR_ENTRY_TYPE, { filePath: state.spec.filePath, cursor: reviewed });
	};

	/** Start one review now; never awaited by the caller, so the watched agent keeps running. */
	const start = (state: WatchdogState, ctx: ExtensionContext, tail: unknown): void => {
		const spec = state.spec;
		state.pending = 0;
		if (state.sent >= spec.maxPerContext) return;
		const messages = selectMessages(ctx.sessionManager.getBranch(), spec.scope, state.cursor, tail);
		let reviewed = state.cursor;
		for (const m of messages) reviewed = Math.max(reviewed, messageTimestamp(m) ?? 0);
		const transcript = renderTranscript(messages);
		if (transcript.trim() === "") {
			advanceCursor(state, reviewed);
			return;
		}
		state.run = { kind: "running", flushAfter: false };
		const review = spec.kind === "jev" ? runJev(pi, ctx, spec, transcript) : runReviewer(pi, ctx, spec, transcript);
		// A session boundary, branch move or switch-off removed this state; its finding is stale.
		const live = (): boolean => states.get(spec.filePath) === state;
		void review.then(
			verdict => {
				// No verdict = failed review: the cursor stays, so the next run covers this range again.
				if (!live() || verdict === null) return;
				advanceCursor(state, reviewed);
				deliver(state, verdict);
			},
			() => undefined,
		).finally(() => {
			if (!live()) return;
			const flush = state.run.kind === "running" && state.run.flushAfter;
			state.run = { kind: "idle" };
			if (state.pending >= state.spec.every || (flush && state.pending > 0)) start(state, ctx, undefined);
		});
	};

	/** One line per watchdog file for `/watchdog list`. */
	const describe = (spec: WatchdogSpec): string => {
		const override = overrides.get(spec.filePath);
		const state = !targetsHere(spec) ? "not for this session" : effectiveEnabled(spec) ? "ON" : "OFF";
		const session = override === undefined ? "—" : override ? "on" : "off";
		const backend = spec.kind === "jev" ? `jev ${spec.judge.provider}/${spec.judge.modelId}` : `chat ${spec.model ?? "@advisor"}`;
		return `${spec.name}: ${state} · global ${spec.enabled ? "on" : "off"} · session ${session} · target ${spec.targets.join(",")} · every ${spec.every} · scope ${spec.scope} · ${backend}\n  ${spec.filePath}`;
	};

	/** Status line a `write`/`edit` result carries for a watchdog file it touched. */
	const fileStatus = (path: string): string => {
		if (!existsSync(path)) return `watchdog file ${path}: removed; no watchdog loads from it.`;
		const parsed = parseWatchdogFile(path);
		if (parsed.kind === "invalid") return `watchdog file ${path}: NOT recognised (${parsed.reason}); it is ignored until fixed.`;
		if (!roster.some(spec => spec.filePath === path)) {
			return `watchdog file ${path}: valid but not searched from ${cwd}; watchdogs load from ${agentDir()} and from <dir>/ or <dir>/.omp/ for each dir between ${cwd} and its git root.`;
		}
		const spec = parsed.spec;
		const active = !targetsHere(spec) ? "not active in this session (its target excludes it)" : effectiveEnabled(spec) ? "active in this session now" : "switched off in this session";
		return `watchdog file ${path}: recognised, ${active}.\n${describe(spec)}`;
	};

	/** The one discovered watchdog with this name (case-insensitive), or the error to show. */
	const findByName = (name: string): { readonly kind: "found"; readonly spec: WatchdogSpec } | { readonly kind: "error"; readonly text: string } => {
		const matches = roster.filter(spec => spec.name.toLowerCase() === name.toLowerCase());
		if (matches.length === 0) return { kind: "error", text: `watchdog "${name}" not found (see /watchdog list)` };
		if (matches.length > 1) {
			return { kind: "error", text: `watchdog name "${name}" is ambiguous; give each file a unique \`name:\`:\n${matches.map(s => `  ${s.filePath}`).join("\n")}` };
		}
		return { kind: "found", spec: matches[0] };
	};

	/**
	 * Split `/watchdog edit` arguments into the longest discovered name they start with and the
	 * requested change (null when none follows). Null when no name matches.
	 */
	const splitEditTarget = (rest: string): { readonly name: string; readonly change: string | null } | null => {
		const lower = rest.toLowerCase();
		let best = "";
		for (const spec of roster) {
			const name = spec.name.toLowerCase();
			if (name.length <= best.length || !lower.startsWith(name)) continue;
			if (lower.length === name.length || /\s/.test(lower[name.length])) best = name;
		}
		if (best === "") return null;
		const change = rest.slice(best.length).trim();
		return { name: rest.slice(0, best.length), change: change === "" ? null : change };
	};

	/** The model prompt for `/watchdog add|edit`, or the error to show instead. */
	const draftPrompt = (
		command: Extract<WatchdogCommand, { kind: "add" | "edit" }>,
		ctx: ExtensionContext,
	): { readonly kind: "prompt"; readonly text: string } | { readonly kind: "error"; readonly text: string } => {
		refresh(false);
		const model = defaultReviewerModel(ctx);
		const draft: DraftContext = {
			projectDir: join(projectRoot(cwd), ".omp"),
			globalDir: agentDir(),
			existing: roster,
			defaultModel: model ? `${model.provider}/${model.id}` : null,
		};
		switch (command.kind) {
			case "add":
				return { kind: "prompt", text: buildAddPrompt(command.requirement, draft) };
			case "edit": {
				const target = splitEditTarget(command.rest);
				if (target === null) return { kind: "error", text: `no watchdog named at the start of "${command.rest}" (see /watchdog list)` };
				const found = findByName(target.name);
				if (found.kind === "error") return found;
				let current: string;
				try {
					current = readFileSync(found.spec.filePath, "utf8");
				} catch (error) {
					return { kind: "error", text: `cannot read ${found.spec.filePath}: ${error instanceof Error ? error.message : String(error)}` };
				}
				return { kind: "prompt", text: buildEditPrompt(found.spec, current, target.change, draft) };
			}
		}
	};

	/** `/watchdog rm`: delete the file after the user confirms, and drop this session's override of it. */
	const remove = async (name: string, ctx: ExtensionContext): Promise<{ readonly level: "info" | "error"; readonly text: string }> => {
		refresh(false);
		const found = findByName(name);
		if (found.kind === "error") return { level: "error", text: found.text };
		const spec = found.spec;
		const confirmed = await ctx.ui.confirm(`Delete watchdog "${spec.name}"?`, `${describe(spec)}\n\nThe file is deleted from disk.`);
		if (!confirmed) return { level: "info", text: `watchdog "${spec.name}" kept` };
		try {
			unlinkSync(spec.filePath);
		} catch (error) {
			return { level: "error", text: `cannot delete ${spec.filePath}: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (overrides.delete(spec.filePath)) pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled: null });
		refresh(false);
		return { level: "info", text: `watchdog "${spec.name}" deleted (${spec.filePath})` };
	};

	const toggle = (command: Extract<WatchdogCommand, { kind: "toggle" }>): { readonly level: "info" | "error"; readonly text: string } => {
		const found = findByName(command.name);
		if (found.kind === "error") return { level: "error", text: found.text };
		const spec = found.spec;
		const enabled = command.toggle === "on";
		switch (command.scope) {
			case "session": {
				if (!targetsHere(spec)) {
					return { level: "error", text: `watchdog "${spec.name}" does not target this session (target ${spec.targets.join(",")}); use \`global\`` };
				}
				overrides.set(spec.filePath, enabled);
				pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled });
				refresh(false);
				return { level: "info", text: `watchdog "${spec.name}" ${command.toggle} for this session` };
			}
			case "global": {
				let raw: string;
				try {
					raw = readFileSync(spec.filePath, "utf8");
				} catch (error) {
					return { level: "error", text: `cannot read ${spec.filePath}: ${error instanceof Error ? error.message : String(error)}` };
				}
				const updated = setFrontmatterEnabled(raw, enabled);
				if (updated === null) return { level: "error", text: `${spec.filePath} has no frontmatter` };
				try {
					if (updated !== raw) writeFileSync(spec.filePath, updated);
				} catch (error) {
					return { level: "error", text: `cannot write ${spec.filePath}: ${error instanceof Error ? error.message : String(error)}` };
				}
				// The file is now the switch; a session override would keep shadowing it here.
				if (overrides.delete(spec.filePath)) pi.appendEntry<SessionOverride>(OVERRIDE_ENTRY_TYPE, { filePath: spec.filePath, enabled: null });
				refresh(false);
				return { level: "info", text: `watchdog "${spec.name}" ${command.toggle} globally (${spec.filePath})` };
			}
		}
	};

	pi.registerCommand("watchdog", {
		description: "List, add, edit, remove or switch watchdogs: /watchdog [list] | add <requirement> | edit <name> [change] | rm <name> | on|off <name> [session|global]",
		getArgumentCompletions: prefix => {
			refresh(false);
			const lower = prefix.toLowerCase();
			if (!/\s/.test(prefix)) {
				const subs = [
					{ value: "list", label: "list", description: "all watchdog files and their state" },
					{ value: "on ", label: "on", description: "switch a watchdog on" },
					{ value: "off ", label: "off", description: "switch a watchdog off" },
					{ value: "add ", label: "add", description: "draft a new watchdog with the model from a requirement" },
					{ value: "edit ", label: "edit", description: "revise a watchdog with the model" },
					{ value: "rm ", label: "rm", description: "delete a watchdog file (asks first)" },
				];
				return subs.filter(s => s.value.startsWith(lower));
			}
			const sub = lower.split(/\s+/)[0];
			const items: { value: string; label: string; description: string }[] = [];
			const names = new Set<string>();
			for (const spec of roster) {
				if (names.has(spec.name.toLowerCase())) continue;
				names.add(spec.name.toLowerCase());
				switch (sub) {
					case "on":
					case "off": {
						const scopes: ToggleScope[] = targetsHere(spec) ? ["session", "global"] : ["global"];
						for (const scope of scopes) {
							const value = `${sub} ${spec.name} ${scope}`;
							if (!value.toLowerCase().startsWith(lower)) continue;
							const now = !targetsHere(spec) ? "not for this session" : effectiveEnabled(spec) ? "now ON" : "now OFF";
							const where = scope === "session" ? "this session only" : `writes enabled: ${sub === "on"} to the file`;
							items.push({ value, label: `${spec.name} ${scope}`, description: `${where} · ${now}` });
						}
						break;
					}
					case "edit":
					case "rm": {
						const value = sub === "edit" ? `edit ${spec.name} ` : `rm ${spec.name}`;
						if (value.toLowerCase().startsWith(lower)) items.push({ value, label: spec.name, description: spec.filePath });
						break;
					}
					default:
						return null;
				}
			}
			return items;
		},
		handler: async (args, ctx) => {
			if (identity === null) load(ctx);
			const command = parseWatchdogCommand(args);
			switch (command.kind) {
				case "list": {
					refresh(false);
					ctx.ui.notify(roster.length === 0 ? "no WATCHDOG-*.md files found" : roster.map(describe).join("\n"), "info");
					return;
				}
				case "invalid":
					ctx.ui.notify(command.reason, "error");
					return;
				case "toggle": {
					const result = toggle(command);
					pi.logger?.info?.(`watchdog command: ${result.text}`);
					logActive();
					ctx.ui.notify(result.text, result.level);
					return;
				}
				case "add":
				case "edit": {
					const prompt = draftPrompt(command, ctx);
					if (prompt.kind === "error") {
						ctx.ui.notify(prompt.text, "error");
						return;
					}
					// Extension-authored like every injected message here, so user-prompt-inject never mistakes it for the user's words.
					pi.sendUserMessage(prompt.text, ctx.isIdle() ? { attribution: "agent" } : { deliverAs: "followUp", attribution: "agent" });
					return;
				}
				case "rm": {
					const result = await remove(command.name, ctx);
					pi.logger?.info?.(`watchdog command: ${result.text}`);
					logActive();
					ctx.ui.notify(result.text, result.level);
					return;
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => load(ctx));
	pi.on("session_switch", (_event, ctx) => load(ctx));
	// Branch and tree moves swap the working transcript: overrides, cursors and cap counts are
	// re-read from the new branch, and findings in flight about the old one are dropped.
	pi.on("session_branch", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));

	// A write or edit of a WATCHDOG-*.md (the last step of `/watchdog add`, or any hand edit) is
	// picked up at once, and the tool result tells the model whether the file is recognised.
	pi.on("tool_result", event => {
		if (event.isError) return;
		const files = touchedWatchdogFiles(event.toolName, event.input, cwd);
		if (files.length === 0) return;
		refresh(true);
		logActive();
		return { content: [...event.content, { type: "text", text: files.map(fileStatus).join("\n") }] };
	});

	// Compaction starts a new context on the same transcript: only the per-context budget
	// (`maxPerContext` count) resets. Accumulated actions, the `window` cursor and
	// in-flight reviews carry over.
	pi.on("session_compact", () => {
		for (const state of states.values()) {
			state.sent = 0;
		}
	});

	// `nextTurn` findings wait for a real user prompt: interactive or RPC input that is not a
	// slash command arms the turn it starts. A subagent has no user, so its next turn delivers.
	pi.on("input", event => {
		if (event.source !== "extension" && !event.text.trimStart().startsWith("/")) userTurnArmed = true;
	});
	pi.on("before_agent_start", () => {
		const armed = userTurnArmed;
		userTurnArmed = false;
		if (nextTurnQueue.length === 0 || (identity?.kind === "main" && !armed)) return;
		const content = nextTurnQueue.join("\n\n");
		nextTurnQueue = [];
		return { message: { customType: NEXT_TURN_CUSTOM_TYPE, content, display: true, attribution: "agent" } };
	});

	pi.on("message_end", (event, ctx) => {
		// A session that had no file at start (identity unknown) is retried lazily.
		if (identity === null) load(ctx);
		const actions = countActions(event.message);
		if (actions === 0) return;
		for (const state of states.values()) {
			state.pending += actions;
			if (state.run.kind === "idle" && state.pending >= state.spec.every) start(state, ctx, event.message);
		}
	});

	pi.on("agent_end", (event, ctx) => {
		if (identity === null) load(ctx);
		if (event.willContinue === true) return; // auto-continuation, not a settled run.
		for (const state of states.values()) {
			if (state.pending === 0) continue;
			if (state.run.kind === "idle") start(state, ctx, undefined);
			else state.run = { kind: "running", flushAfter: true };
		}
	});
}

// Pure-logic seam for out-of-harness verification (mirrors lang-nag's __testables).
// The model-calling paths (runReviewer, runJev) still require a live session and are not exposed.
export function __testables() {
	return {
		parseFrontmatter,
		setFrontmatterEnabled,
		parseWatchdogFile,
		parseWatchdogCommand,
		overridesFromBranch,
		toList,
		matchesIdentity,
		interpretVerdict,
		countActions,
		selectMessages,
		renderTranscript,
		splitEffort,
		normalizeDelivery,
		parsePositiveInt,
		normalizeScope,
		discoverWatchdogFiles,
	};
}
