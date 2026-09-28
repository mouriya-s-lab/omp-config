import {
	createAgentSession,
	SessionManager,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { TypeSafeJudge, isJudgmentApi } from "@oh-my-pi/pi-ai";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
// independently with its own counter, cursor, dedupe set and cap. The counter
// accumulates the watched agent's actions: each assistant tool call and each
// assistant text reply counts as one. When a watchdog's counter reaches
// `every`, it runs immediately (mid-run), and its finding is injected as soon as
// the review finishes, whatever state the agent is in. When the agent's run
// settles (`agent_end`, non-continuation) with a nonzero counter below
// `every`, the watchdog runs once for the remainder. `scope: full` reviews the
// whole branch; `scope: window` reviews only messages after the watchdog's
// previous run. The transcript is never truncated. Chat reviewers use a
// tool-capable `createAgentSession`; native Jev uses `Judge.judge` and only
// selects one configured option whose prewritten prompt (if any) is injected.
// Findings go through `sendUserMessage`; repeats are de-duplicated and, when
// `maxPerContext` is set, bounded per watchdog per context. Each compaction
// starts a new context: the dedupe set and cap count reset, nothing else does.
//
// COMMANDS. `/watchdog [list]` lists every discovered file with its global
// (`enabled`) and session state. `/watchdog on|off <name> [session|global]`
// switches one watchdog: `session` (default) records a session custom entry that
// shadows the file for this session only and follows the session branch;
// `global` rewrites the file's `enabled` line and drops this session's override.
// Subcommands, names and scopes are offered as argument completions.
//
// FAILURE POLICY. Every failure path (no match, unresolved model, judge
// unavailable, reviewer error/timeout, malformed file) degrades to "no note".
// Explicit native judge selection never falls back to a chat model. The
// extension never blocks, mutates, or corrupts a primary turn.
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

/** Parse one `WATCHDOG-*.md` (enabled or not); returns null when invalid, targetless, or unreadable. */
function parseWatchdogFile(path: string, warn?: (message: string) => void): WatchdogSpec | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const { fields, body } = parseFrontmatter(raw);
	const enabled = fields.enabled === undefined || /^(true|yes|on|1)$/i.test(unquote(fields.enabled));
	const targets = fields.target ? toList(fields.target) : [];
	if (targets.length === 0) return null;

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
		const reject = (reason: string): null => {
			warn?.(`watchdog "${path}": ${reason}`);
			return null;
		};
		if (fields.model !== undefined || fields.tools !== undefined || fields.note !== undefined || !common.guidance ||
			slash <= 0 || slash === judge.length - 1 || THINKING_SUFFIXES[judge.slice(judge.lastIndexOf(":") + 1).toLowerCase()] === true) {
			return reject("judge requires provider/model and a nonempty body; model, tools, note and thinking suffixes are not allowed");
		}
		const parsed = parseJevOptions(fields, delivery);
		if (parsed.kind === "invalid") return reject(parsed.reason);
		const instructions = unquote(fields.instructions ?? "");
		return {
			...common,
			kind: "jev",
			judge: { provider: judge.slice(0, slash), modelId: judge.slice(slash + 1) },
			instructions: instructions || DEFAULT_JEV_INSTRUCTIONS,
			options: parsed.options,
		};
	}
	return {
		...common,
		kind: "chat",
		model: fields.model ? unquote(fields.model) : undefined,
		tools: tools.length > 0 ? tools : [...DEFAULT_TOOLS],
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

/** Reviewer model + thinking level: explicit `model` (honoring `:effort`), else the `advisor` role. */
function resolveReviewer(ctx: ExtensionContext, spec: ChatWatchdog): { model: Model; thinkingLevel: string } | null {
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
async function runReviewer(pi: ExtensionAPI, ctx: ExtensionContext, spec: ChatWatchdog, transcript: string): Promise<Verdict | null> {
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

function normalizeNote(note: string): string {
	return note.toLowerCase().replace(/\s+/g, " ").trim();
}

// --- extension registration -------------------------------------------------

type RunState = { readonly kind: "idle" } | { readonly kind: "running"; readonly flushAfter: boolean };

/** Per-watchdog runtime state; each watchdog counts, runs, dedupes and caps on its own. */
type WatchdogState = {
	/** Latest parse of the watchdog's file; replaced in place when the roster is re-read. */
	spec: WatchdogSpec;
	/** Watched actions since this watchdog's last run started. */
	pending: number;
	/** Newest message timestamp covered by the last run (`window` scope cursor). */
	cursor: number;
	run: RunState;
	/** Advisories delivered since the last compaction (or branch/tree reset); compared against `maxPerContext`. */
	sent: number;
	/** Normalized advisory texts delivered since the last compaction (or branch/tree reset). */
	readonly notes: Set<string>;
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

type Toggle = "on" | "off";
type ToggleScope = "session" | "global";

/** `/watchdog` arguments after parsing. */
type WatchdogCommand =
	| { readonly kind: "list" }
	| { readonly kind: "toggle"; readonly toggle: Toggle; readonly name: string; readonly scope: ToggleScope }
	| { readonly kind: "invalid"; readonly reason: string };

const WATCHDOG_USAGE = "usage: /watchdog [list] | /watchdog on|off <name> [session|global]";

function parseWatchdogCommand(args: string): WatchdogCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = (tokens[0] ?? "list").toLowerCase();
	if (sub === "list") return tokens.length <= 1 ? { kind: "list" } : { kind: "invalid", reason: WATCHDOG_USAGE };
	if (sub !== "on" && sub !== "off") return { kind: "invalid", reason: WATCHDOG_USAGE };
	const rest = tokens.slice(1);
	const last = rest.at(-1)?.toLowerCase();
	const scope: ToggleScope = last === "global" ? "global" : "session";
	const nameTokens = last === "global" || last === "session" ? rest.slice(0, -1) : rest;
	if (nameTokens.length === 0) return { kind: "invalid", reason: WATCHDOG_USAGE };
	return { kind: "toggle", toggle: sub, name: nameTokens.join(" "), scope };
}

export default function watchdogAgent(pi: ExtensionAPI): void {
	let identity: Identity | null = null;
	let cwd = process.cwd();
	/** Every discovered watchdog file, enabled or not, whatever its target. */
	let roster: WatchdogSpec[] = [];
	let overrides = new Map<string, boolean>();
	/** Runtime state of the watchdogs active in this session, keyed by file path. */
	let states = new Map<string, WatchdogState>();

	const targetsHere = (spec: WatchdogSpec): boolean => identity !== null && matchesIdentity(spec, identity);
	const effectiveEnabled = (spec: WatchdogSpec): boolean => overrides.get(spec.filePath) ?? spec.enabled;

	/** Re-read every watchdog file and rebuild the active set, keeping state of watchdogs that stay active. */
	const refresh = (warn: boolean): void => {
		const specs: WatchdogSpec[] = [];
		for (const file of discoverWatchdogFiles(cwd)) {
			const spec = parseWatchdogFile(file, warn ? message => pi.logger?.warn?.(message) : undefined);
			if (spec) specs.push(spec);
		}
		roster = specs;
		const next = new Map<string, WatchdogState>();
		for (const spec of specs) {
			if (!targetsHere(spec) || !effectiveEnabled(spec)) continue;
			const prev = states.get(spec.filePath);
			if (prev) prev.spec = spec;
			next.set(spec.filePath, prev ?? { spec, pending: 0, cursor: 0, run: { kind: "idle" }, sent: 0, notes: new Set<string>() });
		}
		states = next;
	};

	const logActive = (): void => {
		if (!identity) return;
		const who = identity.kind === "main" ? "main" : `subagent "${identity.agent}"`;
		const active = [...states.values()].map(s => `${s.spec.name}(every=${s.spec.every}, scope=${s.spec.scope})`);
		pi.logger?.info?.(`watchdog: ${active.length} watchdog(s) active for ${who}${active.length > 0 ? ` — ${active.join(", ")}` : ""}`);
	};

	/** Session boundary: identity, overrides and the active set are rebuilt; all runtime state starts over. */
	const load = (ctx: ExtensionContext): void => {
		identity = resolveIdentity(ctx);
		cwd = ctx.cwd;
		overrides = overridesFromBranch(ctx.sessionManager.getBranch());
		states = new Map();
		refresh(true);
		logActive();
	};

	const deliver = (state: WatchdogState, verdict: Verdict | null): void => {
		if (!verdict || verdict.kind !== "advice") return;
		const spec = state.spec;
		const key = normalizeNote(verdict.note);
		if (key === "" || state.notes.has(key) || state.sent >= spec.maxPerContext) return;
		state.notes.add(key);
		const safeName = spec.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const text = `<watchdog name="${safeName}" severity="${verdict.severity}">\n${verdict.note}\n</watchdog>`;
		pi.sendUserMessage(text, { deliverAs: verdict.delivery, attribution: "agent" });
		state.sent += 1;
		pi.logger?.info?.(`watchdog "${spec.name}": ${verdict.severity} → delivered (${state.sent}/${Number.isFinite(spec.maxPerContext) ? spec.maxPerContext : "∞"})`);
	};

	/** Start one review now; never awaited by the caller, so the watched agent keeps running. */
	const start = (state: WatchdogState, ctx: ExtensionContext, tail: unknown): void => {
		const spec = state.spec;
		state.pending = 0;
		if (state.sent >= spec.maxPerContext) return;
		const messages = selectMessages(ctx.sessionManager.getBranch(), spec.scope, state.cursor, tail);
		for (const m of messages) state.cursor = Math.max(state.cursor, messageTimestamp(m) ?? 0);
		const transcript = renderTranscript(messages);
		if (transcript.trim() === "") return;
		state.run = { kind: "running", flushAfter: false };
		const review = spec.kind === "jev" ? runJev(pi, ctx, spec, transcript) : runReviewer(pi, ctx, spec, transcript);
		// A session boundary, branch move or switch-off removed this state; its finding is stale.
		const live = (): boolean => states.get(spec.filePath) === state;
		void review.then(
			verdict => {
				if (live()) deliver(state, verdict);
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

	const toggle = (command: Extract<WatchdogCommand, { kind: "toggle" }>): { readonly level: "info" | "error"; readonly text: string } => {
		const matches = roster.filter(spec => spec.name.toLowerCase() === command.name.toLowerCase());
		if (matches.length === 0) return { level: "error", text: `watchdog "${command.name}" not found (see /watchdog list)` };
		if (matches.length > 1) {
			return { level: "error", text: `watchdog name "${command.name}" is ambiguous; give each file a unique \`name:\`:\n${matches.map(s => `  ${s.filePath}`).join("\n")}` };
		}
		const spec = matches[0];
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
		description: "List watchdogs or switch one on/off for this session or globally: /watchdog [list] | on|off <name> [session|global]",
		getArgumentCompletions: prefix => {
			refresh(false);
			const lower = prefix.toLowerCase();
			if (!/\s/.test(prefix)) {
				const subs = [
					{ value: "list", label: "list", description: "all watchdog files and their state" },
					{ value: "on ", label: "on", description: "switch a watchdog on" },
					{ value: "off ", label: "off", description: "switch a watchdog off" },
				];
				return subs.filter(s => s.value.startsWith(lower));
			}
			const sub = lower.split(/\s+/)[0];
			if (sub !== "on" && sub !== "off") return null;
			const items: { value: string; label: string; description: string }[] = [];
			const names = new Set<string>();
			for (const spec of roster) {
				if (names.has(spec.name.toLowerCase())) continue;
				names.add(spec.name.toLowerCase());
				const scopes: ToggleScope[] = targetsHere(spec) ? ["session", "global"] : ["global"];
				for (const scope of scopes) {
					const value = `${sub} ${spec.name} ${scope}`;
					if (!value.toLowerCase().startsWith(lower)) continue;
					const now = !targetsHere(spec) ? "not for this session" : effectiveEnabled(spec) ? "now ON" : "now OFF";
					const where = scope === "session" ? "this session only" : `writes enabled: ${sub === "on"} to the file`;
					items.push({ value, label: `${spec.name} ${scope}`, description: `${where} · ${now}` });
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
			}
		},
	});

	pi.on("session_start", (_event, ctx) => load(ctx));
	pi.on("session_switch", (_event, ctx) => load(ctx));
	// Branch and tree moves swap the working transcript: overrides are re-read from the new branch,
	// every cursor, counter and cap starts over, and findings in flight about the old one are dropped.
	pi.on("session_branch", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));
	// Compaction starts a new context on the same transcript: only the per-context budget
	// (`maxPerContext` count and dedupe set) resets. Accumulated actions, the `window` cursor and
	// in-flight reviews carry over.
	pi.on("session_compact", () => {
		for (const state of states.values()) {
			state.sent = 0;
			state.notes.clear();
		}
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
		normalizeNote,
		discoverWatchdogFiles,
	};
}
