import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { DeveloperMessage } from "@oh-my-pi/pi-ai";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ============================================================================
// user-prompt-inject — show chosen subagents what the human actually asked.
//
// WHY THIS EXISTS. A mentor or discussant only knows what its advisee tells
// it, so it can only echo the advisee's framing back. This extension renders a
// `PROMPT-INJECT-*.md` template with the root main session's user prompts and
// hands it to the targeted subagents on every model call. OMP has no native
// way to do this: `before_subagent_spawn` can only reroute the model or block,
// and `before_agent_start` does not fire when an idle or parked subagent is
// woken by an IRC message (`write agent://<id>`).
//
// FILE FORMAT. `PROMPT-INJECT-<label>.md`, discovered like `WATCHDOG-*.md`:
//   - user level:  <agent dir>/PROMPT-INJECT-*.md          (~/.omp/agent by default)
//   - repo level:  <dir>/PROMPT-INJECT-*.md and <dir>/.omp/PROMPT-INJECT-*.md,
//                  walking from cwd up to the git root.
// Frontmatter (between `---` fences):
//   target:  mentor:default, discuss:steady   # required; agent names or `*` (every subagent)
//   name:    user-goal                        # optional; defaults to the file label
//   enabled: true                             # optional; default true
// Body = template. `user_prompt` is the root session's user prompts in
// chronological order (0 = first):
//   {{user_prompt[0]}}    first prompt;   {{user_prompt[-1]}} latest;
//   {{user_prompt[-3]}}   third from the latest;
//   {{user_prompt[3:e]}}  slice, end-exclusive, `e` = end; bounds may be negative.
// A scalar out of range renders empty; slice bounds clamp. A slice renders each
// element as `<user_prompt index="N">…</user_prompt>` (N = 0-based position),
// one per line block. Any other `{{user_prompt…}}` form makes the file invalid
// (skipped with a warning). Prompt text is inserted verbatim, never re-expanded.
//
// SOURCE. The root is found by walking `ctx.agent.parentId` through the
// process agent registry to the `kind: "main"` ref. Its prompts are the user
// messages on the root session's current branch (`getBranch()` keeps
// pre-compaction entries) with `attribution: "user"` and not `synthetic`.
// Attribution is set by whoever sends the message, so extensions that inject
// user-role messages must send them with `attribution: "agent"`.
//
// RUNTIME. Files are read at session start, so edits apply to the next spawned
// subagent. On every `context` event (each model call, including IRC wakes) a
// targeted subagent gets one request-only developer message, placed first,
// holding every matching rendered template as
// `<user-prompt-inject name=…>…</user-prompt-inject>`. Nothing is written to the
// session. Main sessions are never targeted.
//
// FAILURE POLICY. Malformed files, a missing root, or a disposed root session
// degrade to "no injection" plus a warning; the model call is never blocked.
// ============================================================================

const FILE_PATTERN = /^PROMPT-INJECT-.+\.md$/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** Any `{{ user_prompt … }}` occurrence; the inner text is parsed separately. */
const PLACEHOLDER_PATTERN = /\{\{\s*(user_prompt\b[^}]*?)\s*\}\}/g;
const SCALAR_PATTERN = /^user_prompt\[\s*(-?\d+)\s*\]$/;
const SLICE_PATTERN = /^user_prompt\[\s*(-?\d+)\s*:\s*(-?\d+|e)\s*\]$/;

type SliceEnd = { readonly kind: "end" } | { readonly kind: "index"; readonly value: number };

type Segment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "scalar"; readonly index: number }
	| { readonly kind: "slice"; readonly start: number; readonly end: SliceEnd };

type TargetSet = { readonly kind: "all" } | { readonly kind: "names"; readonly names: ReadonlySet<string> };

type InjectSpec = {
	readonly name: string;
	readonly targets: TargetSet;
	readonly segments: readonly Segment[];
	readonly filePath: string;
};

type SpecParse =
	| { readonly kind: "ok"; readonly spec: InjectSpec }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string };

type RootPrompts =
	| { readonly kind: "ok"; readonly prompts: readonly string[] }
	| { readonly kind: "missing"; readonly reason: string };

// --- discovery + parsing ----------------------------------------------------

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".omp", "agent");
}

/** User agent dir + every dir from cwd up to (and including) the git root, plus each `.omp`. */
function discoverFiles(cwd: string): string[] {
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
		for (const n of names.sort()) {
			if (!FILE_PATTERN.test(n)) continue;
			const p = join(d, n);
			if (seen.has(p)) continue;
			seen.add(p);
			files.push(p);
		}
	}
	return files;
}

function unquote(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "").trim();
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
	const m = raw.match(FRONTMATTER_PATTERN);
	if (!m) return null;
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
 * `target` value → target set. Agent names contain `:` (`mentor:default`), so
 * the value is split on commas only; `[a, b]` brackets are accepted.
 */
function parseTargets(value: string): TargetSet | null {
	let s = value.trim();
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	const items = s
		.split(",")
		.map(x => unquote(x).toLowerCase())
		.filter(x => x !== "");
	if (items.length === 0) return null;
	if (items.includes("*")) return { kind: "all" };
	return { kind: "names", names: new Set(items) };
}

type TemplateParse =
	| { readonly kind: "ok"; readonly segments: readonly Segment[] }
	| { readonly kind: "invalid"; readonly reason: string };

function parseTemplate(body: string): TemplateParse {
	const segments: Segment[] = [];
	let last = 0;
	for (const m of body.matchAll(PLACEHOLDER_PATTERN)) {
		const at = m.index ?? 0;
		if (at > last) segments.push({ kind: "text", text: body.slice(last, at) });
		const expr = m[1].replace(/\s+/g, "");
		const scalar = expr.match(SCALAR_PATTERN);
		const slice = expr.match(SLICE_PATTERN);
		if (scalar) {
			segments.push({ kind: "scalar", index: Number(scalar[1]) });
		} else if (slice) {
			const end: SliceEnd = slice[2] === "e" ? { kind: "end" } : { kind: "index", value: Number(slice[2]) };
			segments.push({ kind: "slice", start: Number(slice[1]), end });
		} else {
			return { kind: "invalid", reason: `unsupported placeholder "${m[0]}" (use user_prompt[i] or user_prompt[a:b], b may be e)` };
		}
		last = at + m[0].length;
	}
	if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });
	return { kind: "ok", segments };
}

function parseSpecFile(path: string): SpecParse {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", reason: `unreadable: ${String(error)}` };
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return { kind: "invalid", reason: "missing frontmatter" };
	const { fields, body } = parsed;
	if (fields.enabled !== undefined && !/^(true|yes|on|1)$/i.test(unquote(fields.enabled))) return { kind: "disabled" };
	const targets = fields.target ? parseTargets(fields.target) : null;
	if (!targets) return { kind: "invalid", reason: "missing target" };
	const template = body.trim();
	if (template === "") return { kind: "invalid", reason: "empty body" };
	const segments = parseTemplate(template);
	if (segments.kind === "invalid") return segments;
	const label = basename(path).replace(/^PROMPT-INJECT-/i, "").replace(/\.md$/i, "");
	return {
		kind: "ok",
		spec: {
			name: fields.name ? unquote(fields.name) : label,
			targets,
			segments: segments.segments,
			filePath: path,
		},
	};
}

// --- rendering ----------------------------------------------------------------

/** Python-style index normalisation for slice bounds: negative counts from the end, then clamp to [0, length]. */
function clampBound(bound: number, length: number): number {
	const n = bound < 0 ? length + bound : bound;
	return Math.min(Math.max(n, 0), length);
}

function renderSegment(segment: Segment, prompts: readonly string[]): string {
	switch (segment.kind) {
		case "text":
			return segment.text;
		case "scalar": {
			const i = segment.index < 0 ? prompts.length + segment.index : segment.index;
			return i >= 0 && i < prompts.length ? prompts[i] : "";
		}
		case "slice": {
			const start = clampBound(segment.start, prompts.length);
			const end = segment.end.kind === "end" ? prompts.length : clampBound(segment.end.value, prompts.length);
			const parts: string[] = [];
			for (let i = start; i < end; i++) parts.push(`<user_prompt index="${i}">\n${prompts[i]}\n</user_prompt>`);
			return parts.join("\n");
		}
		default: {
			const unreachable: never = segment;
			return unreachable;
		}
	}
}

function renderSpec(spec: InjectSpec, prompts: readonly string[]): string {
	const body = spec.segments.map(s => renderSegment(s, prompts)).join("");
	const name = spec.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<user-prompt-inject name="${name}">\n${body}\n</user-prompt-inject>`;
}

// --- root prompt source -------------------------------------------------------

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	return texts.join("\n");
}

/** Walk the spawn tree from this subagent to the root main session and read its user prompts. */
function rootPrompts(ctx: ExtensionContext): RootPrompts {
	const registry = AgentRegistry.global();
	const visited = new Set<string>();
	let id = ctx.agent.parentId;
	while (id !== undefined) {
		if (visited.has(id)) return { kind: "missing", reason: `parent cycle at ${id}` };
		visited.add(id);
		const ref = registry.get(id);
		if (!ref) return { kind: "missing", reason: `ancestor ${id} not in registry` };
		if (ref.kind === "main") {
			if (!ref.session) return { kind: "missing", reason: `root ${id} has no live session` };
			const prompts: string[] = [];
			for (const entry of ref.session.sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true) continue;
				const text = messageText(message.content).trim();
				if (text !== "") prompts.push(text);
			}
			return { kind: "ok", prompts };
		}
		id = ref.parentId;
	}
	return { kind: "missing", reason: "no main ancestor" };
}

// --- extension --------------------------------------------------------------

function targets(spec: InjectSpec, agentName: string): boolean {
	switch (spec.targets.kind) {
		case "all":
			return true;
		case "names":
			return spec.targets.names.has(agentName);
		default: {
			const unreachable: never = spec.targets;
			return unreachable;
		}
	}
}

export default function userPromptInject(pi: ExtensionAPI): void {
	/** Specs targeting this session; empty for main sessions and non-targets. */
	let active: InjectSpec[] = [];
	/** Last root-resolution failure already logged, so a broken chain warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		active = [];
		warnedReason = null;
		if (ctx.agent.kind !== "sub") return;
		for (const path of discoverFiles(ctx.cwd)) {
			const parsed = parseSpecFile(path);
			switch (parsed.kind) {
				case "ok":
					if (targets(parsed.spec, ctx.agent.name)) active.push(parsed.spec);
					break;
				case "disabled":
					break;
				case "invalid":
					pi.logger.warn(`user-prompt-inject: skipping ${path}: ${parsed.reason}`);
					break;
				default: {
					const unreachable: never = parsed;
					return unreachable;
				}
			}
		}
		if (active.length > 0) {
			pi.logger.info(`user-prompt-inject: ${ctx.agent.name} (${ctx.agent.id}) ← ${active.map(s => s.name).join(", ")}`);
		}
	});

	pi.on("context", (event, ctx) => {
		if (active.length === 0) return;
		const root = rootPrompts(ctx);
		if (root.kind === "missing") {
			if (warnedReason !== root.reason) {
				warnedReason = root.reason;
				pi.logger.warn(`user-prompt-inject: ${ctx.agent.id}: ${root.reason}; not injecting`);
			}
			return;
		}
		const text = active.map(spec => renderSpec(spec, root.prompts)).join("\n\n");
		const message: DeveloperMessage = {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: event.messages[0]?.timestamp ?? Date.now(),
		};
		return { messages: [message, ...event.messages] };
	});
}
