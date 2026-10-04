import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// append-system-model — APPEND_SYSTEM.md, but per model.
//
// WHY THIS EXISTS. OMP's APPEND_SYSTEM.md / SYSTEM.md / SYSTEM_TEMPLATE.md and
// the rulebook cannot be conditioned on the session model or provider, so a
// correction meant for one model family reaches every model.
//
// FILE. `<agent dir>/APPEND_SYSTEM_MODEL.md` (~/.omp/agent by default,
// profile-aware through getAgentDir). One file, several blocks; each block is a
// `---`-fenced YAML header followed by a body that runs to the next `---` line:
//
//   ---
//   model: opus
//   provider: ^anthropic$
//   ---
//   Appended only for Opus served by Anthropic.
//   ---
//   model: "(gpt-5|o3)"
//   ---
//   Appended for GPT-5 and o3 from any provider.
//
// Header keys (at least one):
//   model     JavaScript regex tested against the model id (`claude-opus-5-5`).
//   provider  JavaScript regex tested against the provider id (`anthropic`).
// Patterns are unanchored (`RegExp.test`); write `^`/`$` to anchor, and quote a
// pattern YAML would otherwise interpret. A block applies when every key it
// sets matches; all applying blocks are appended in file order as one extra
// system-prompt block. A bare `---` line always opens a header, so a body
// cannot contain one (use `***` for a rule).
//
// TIMING. `before_agent_start`, in the main session and in every subagent, each
// matched against its own model. The file is re-read per prompt, so edits and
// `/model` switches apply from the next prompt. A model switched mid-run by
// auto-retry keeps the blocks chosen when the prompt started.
//
// FAILURE POLICY. A missing file injects nothing silently; an unreadable file
// warns on every prompt. A malformed file degrades to "no injection" plus a
// warning, repeated only when the error changes or a valid read intervened.
// The prompt is never blocked.
// ============================================================================

const FILE_NAME = "APPEND_SYSTEM_MODEL.md";
const FENCE = /^---[ \t]*$/;

type MatchField = "model" | "provider";

interface Constraint {
	readonly field: MatchField;
	readonly pattern: RegExp;
}

interface Block {
	readonly constraints: readonly [Constraint, ...Constraint[]];
	readonly body: string;
}

type Parsed = { readonly kind: "ok"; readonly blocks: readonly Block[] } | { readonly kind: "invalid"; readonly reason: string };

type Header =
	| { readonly kind: "ok"; readonly constraints: readonly [Constraint, ...Constraint[]] }
	| { readonly kind: "invalid"; readonly reason: string };

function parseHeader(text: string): Header {
	let data: unknown;
	try {
		data = Bun.YAML.parse(text);
	} catch (error) {
		return { kind: "invalid", reason: `invalid YAML header: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		return { kind: "invalid", reason: "header must set `model` and/or `provider`" };
	}
	const constraints: Constraint[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key !== "model" && key !== "provider") {
			return { kind: "invalid", reason: `unknown header key \`${key}\` (allowed: model, provider)` };
		}
		if (typeof value !== "string" || value.trim() === "") {
			return { kind: "invalid", reason: `\`${key}\` must be a non-empty regex string` };
		}
		try {
			constraints.push({ field: key, pattern: new RegExp(value) });
		} catch (error) {
			return {
				kind: "invalid",
				reason: `\`${key}\` is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	const [first, ...rest] = constraints;
	if (first === undefined) return { kind: "invalid", reason: "header must set `model` and/or `provider`" };
	return { kind: "ok", constraints: [first, ...rest] };
}

function parseFile(source: string): Parsed {
	// Segment i starts after the i-th fence; segment 0 is whatever precedes the first fence.
	const segments: { start: number; lines: string[] }[] = [{ start: 1, lines: [] }];
	source
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.forEach((line, index) => {
			if (FENCE.test(line)) segments.push({ start: index + 2, lines: [] });
			else segments[segments.length - 1]!.lines.push(line);
		});

	const [preamble, ...rest] = segments;
	if (preamble!.lines.some(line => line.trim() !== "")) {
		return { kind: "invalid", reason: "line 1: content before the first `---` header" };
	}
	if (rest.length % 2 !== 0) {
		return {
			kind: "invalid",
			reason: `line ${rest[rest.length - 1]!.start - 1}: \`---\` opens a header that is never closed (a body cannot contain a bare \`---\` line)`,
		};
	}

	const blocks: Block[] = [];
	for (let i = 0; i < rest.length; i += 2) {
		const line = rest[i]!.start - 1;
		const header = parseHeader(rest[i]!.lines.join("\n"));
		if (header.kind === "invalid") return { kind: "invalid", reason: `line ${line}: ${header.reason}` };
		const body = rest[i + 1]!.lines.join("\n").trim();
		if (body === "") return { kind: "invalid", reason: `line ${line}: block has an empty body` };
		blocks.push({ constraints: header.constraints, body });
	}
	return { kind: "ok", blocks };
}

export default function appendSystemModel(pi: ExtensionAPI): void {
	/** Last parse failure already logged, so a broken file warns once per reason. */
	let warnedReason: string | null = null;

	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const file = join(getAgentDir(), FILE_NAME);
		let source: string;
		try {
			source = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			pi.logger.warn(`append-system-model: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const parsed = parseFile(source);
		switch (parsed.kind) {
			case "invalid":
				if (warnedReason !== parsed.reason) {
					warnedReason = parsed.reason;
					pi.logger.warn(`append-system-model: ${file}: ${parsed.reason}; not injecting`);
				}
				return;
			case "ok": {
				warnedReason = null;
				const values: Record<MatchField, string> = { model: model.id, provider: model.provider };
				const bodies = parsed.blocks
					.filter(block => block.constraints.every(c => c.pattern.test(values[c.field])))
					.map(block => block.body);
				if (bodies.length === 0) return;
				return { systemPrompt: [...event.systemPrompt, bodies.join("\n\n")] };
			}
			default: {
				const unreachable: never = parsed;
				return unreachable;
			}
		}
	});
}
