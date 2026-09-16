import {
	createAgentSession,
	SessionManager,
	z,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";

// ============================================================================
// doc-polish — an omp extension that restructures a markdown/plaintext document
// for engineer readability WITHOUT changing its meaning, then emits a
// before/after/review document.
//
// Callable by the model (`polish_doc` tool) and by a human (`/polish-doc`
// slash command). The parameter is the path to a `.md`/`.txt` file (one or
// more).
//
// Three sub-agents, each its own restricted, in-memory `createAgentSession`
// bound to an explicit `provider/model:effort` spec and reusing the host's
// providers/models via `ctx.modelRegistry`:
//
//   1. Split agent   — standard subagent, tools = [read, write] only. Its
//                      prompt carries NO document text, only the task. It reads
//                      the file itself and writes a JSON split index (blocks
//                      with original line ranges + full keyword glossary).
//                      Everything after the split is program behavior.
//   2. Polish agent  — no tools. Receives batched blocks (<=5000 code points,
//                      never truncated) plus only the glossary terms relevant
//                      to the batch; returns polished blocks + keyword-change
//                      records. Its text output is captured by the program.
//   3. Check agent   — no tools. Per regrouped block, judges whether the
//                      rewrite preserved meaning. Defaults to the split model
//                      when its own spec is omitted.
// ============================================================================

const BATCH_LIMIT = 5000; // code points per polish request; a block over this goes alone, never truncated.
const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

type Model = NonNullable<CreateAgentSessionOptions["model"]>;
type ResolvedModel = { model: Model; thinkingLevel?: string; spec: string };

type SplitBlock = { index: number; startLine: number; endLine: number; title: string; text: string };
type PolishBlock = { sourceIndices: number[]; polished: string };
type KeywordChange = { term: string; changed: boolean; to: string; reason: string };
type PolishResult = { blocks: PolishBlock[]; changes: KeywordChange[]; diagnostics: string[] };

type Group = {
	sourceIndices: number[];
	original: string;
	polished: string;
	startLine: number;
	endLine: number;
	review: string;
};

// --- boundary schemas (parse untrusted sub-agent JSON) ----------------------

const splitSchema = z.object({
	blocks: z
		.array(
			z.object({
				index: z.number().int(),
				startLine: z.number().int().min(1),
				endLine: z.number().int().min(1),
				title: z.string().optional().default(""),
			}),
		)
		.min(1),
	keywords: z.array(z.string()).default(() => []),
});

const polishSchema = z.object({
	blocks: z
		.array(
			z.object({
				sourceIndices: z.array(z.number().int()).min(1),
				polished: z.string(),
			}),
		)
		.default(() => []),
	keywordChanges: z
		.array(
			z.object({
				term: z.string(),
				changed: z.boolean().optional().default(false),
				to: z.string().optional().default(""),
				reason: z.string().optional().default(""),
			}),
		)
		.default(() => []),
});

const configSchema = z.object({
	splitModel: z.string().optional(),
	polishModel: z.string().optional(),
	checkModel: z.string().optional(),
	concurrency: z.number().int().min(1).optional(),
});

type DocPolishConfig = { splitModel?: string; polishModel?: string; checkModel?: string; concurrency?: number };

// Optional predefined model config. A `doc-polish.json` in the caller's cwd (wins)
// or next to this extension supplies default model specs and concurrency; explicit
// tool/command arguments still override it.
function loadConfig(cwd: string): DocPolishConfig {
	for (const path of [join(cwd, "doc-polish.json"), join(import.meta.dir, "doc-polish.json")]) {
		if (!existsSync(path)) continue;
		try {
			return configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			// Malformed config file: ignore and fall through to the next candidate / defaults.
		}
	}
	return {};
}

// --- model resolution -------------------------------------------------------

function splitEffort(spec: string): { base: string; effort?: string } {
	const trimmed = spec.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const suffix = trimmed.slice(colon + 1);
		if (THINKING_LEVELS[suffix] === true) return { base: trimmed.slice(0, colon), effort: suffix };
	}
	return { base: trimmed };
}

function findInRegistry(ctx: ExtensionContext, base: string): Model | undefined {
	const available = ctx.modelRegistry?.getAvailable?.() ?? [];
	return (
		available.find((m: Model) => `${m.provider}/${m.id}` === base) ??
		available.find((m: Model) => m.id === base)
	);
}

// Accepts a `provider/model:effort` spec, or a comma-separated fallback chain;
// returns the first candidate that resolves to an available model.
function resolveModelSpec(ctx: ExtensionContext, spec: string): ResolvedModel {
	for (const candidate of spec.split(",").map(s => s.trim()).filter(Boolean)) {
		const { base, effort } = splitEffort(candidate);
		const model = ctx.models?.resolve?.(base) ?? findInRegistry(ctx, base);
		if (model) return { model, thinkingLevel: effort, spec: candidate };
	}
	throw new Error(`doc-polish: no available model resolved for "${spec}"`);
}

function defaultModelSpec(ctx: ExtensionContext): string {
	const current = ctx.models?.current?.();
	if (current) return `${current.provider}/${current.id}`;
	const first = ctx.modelRegistry?.getAvailable?.()?.[0];
	if (first) return `${first.provider}/${first.id}`;
	throw new Error("doc-polish: no model available to run sub-agents");
}

// Raised when `doc-polish.json` names a model absent from the model list. Both entry
// points convert it into an agent-facing message rather than a hard failure.
class DocPolishConfigError extends Error {}

// Raised when a sub-agent request keeps failing at runtime after retries. Surfaced
// as a readable, self-contained error — distinct from the pre-run config gate.
class DocPolishRuntimeError extends Error {}

// Existence check only — resolves against the model registry, never sends a request.
// A comma fallback chain counts as present when any candidate resolves.
function modelExists(ctx: ExtensionContext, spec: string): boolean {
	return spec
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)
		.some(candidate => {
			const { base } = splitEffort(candidate);
			return (ctx.models?.resolve?.(base) ?? findInRegistry(ctx, base)) !== undefined;
		});
}

function configModelIssueMessage(invalid: { role: string; spec: string }[]): string {
	const list = invalid.map(i => `- \`${i.role}\`: \`${i.spec}\``).join("\n");
	return [
		"doc-polish 本次调用直接中止、未做任何润色（不是挂起，没有可恢复的状态；修正后需重新调用）：配置文件 `doc-polish.json` 里的这些模型不在当前可用模型列表中",
		"（仅核对模型列表是否存在，未发送任何测试请求）：",
		list,
		"",
		"请先向用户解释这三个模型设置各自的作用，再把决定权交给用户，不要自行替换或猜测：",
		"- `splitModel`（拆分）：读取文档、按相关性切成小块、标注每块在原文的起止行号、抽取关键词词表；需要 read+write 工具能力。",
		"- `polishModel`（润色）：在不改变原意的前提下，把每个批次重排/润色成工程师更易读的文本，并给出词表变更；无工具。",
		"- `checkModel`（校验）：对合并后的每个编组判断语义是否保持、如何理解；无工具。未设置时回退到 `splitModel`。",
		"",
		"把选择权交给用户：可改用某个可用模型、修改 `doc-polish.json`、或调用时显式传入模型参数；用户确认后再重试（`omp models` 可查看可用模型）。",
	].join("\n");
}

// --- sub-agent runner (createAgentSession, reusing host providers) ----------

function extractAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			return m.content
				.filter((b: { type?: string }) => b?.type === "text")
				.map((b: { text?: string }) => b.text ?? "")
				.join("");
		}
	}
	return "";
}

const SUBAGENT_MAX_ATTEMPTS = 3;

type SubSessionOptions = {
	resolved: ResolvedModel;
	role: string;
	toolNames: string[];
	prompt: string;
	agentId: string;
	cwd: string;
};

// One attempt: a fresh restricted, in-memory session bound to the resolved model.
async function runSubSessionOnce(ctx: ExtensionContext, opts: SubSessionOptions): Promise<string> {
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		modelRegistry: ctx.modelRegistry,
		model: opts.resolved.model,
		thinkingLevel: opts.resolved.thinkingLevel as never,
		sessionManager: SessionManager.inMemory(),
		toolNames: opts.toolNames,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		agentId: opts.agentId,
	});
	let deltas = "";
	let finalMessages: unknown;
	const unsubscribe = session.subscribe((event: { type: string; assistantMessageEvent?: { type?: string; delta?: string }; isTerminal?: boolean; messages?: unknown }) => {
		if (event.type === "message_update") {
			const a = event.assistantMessageEvent;
			if (a?.type === "text_delta" && typeof a.delta === "string") deltas += a.delta;
		} else if (event.type === "agent_end" && event.isTerminal !== false) {
			finalMessages = event.messages;
		}
	});
	try {
		await session.prompt(opts.prompt);
	} finally {
		unsubscribe();
		await session.dispose();
	}
	// A provider failure (403, rate limit, etc.) does not throw out of prompt(); it
	// lands as an assistant turn with stopReason "error". Re-surface it as a throw so
	// runSubSession's retry and readable-error path engage, instead of the caller
	// mistaking an empty result for a merely unparseable one.
	const msgs = Array.isArray(finalMessages) ? finalMessages : [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (m?.role !== "assistant") continue;
		if (m.stopReason === "error") throw new Error(m.errorMessage || "模型返回错误（stopReason=error）");
		break;
	}
	const text = deltas.trim();
	return text || extractAssistantText(finalMessages).trim();
}

// Real runtime consumption: a genuinely failing request is retried up to
// SUBAGENT_MAX_ATTEMPTS times; still failing, it throws a readable, self-contained
// error. A response that merely fails to parse is handled by the caller, not here.
async function runSubSession(ctx: ExtensionContext, opts: SubSessionOptions): Promise<string> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= SUBAGENT_MAX_ATTEMPTS; attempt++) {
		try {
			return await runSubSessionOnce(ctx, opts);
		} catch (err) {
			lastError = err;
			if (attempt < SUBAGENT_MAX_ATTEMPTS) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 400 * attempt);
				await promise;
			}
		}
	}
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new DocPolishRuntimeError(
		`doc-polish：${opts.role}子代理（模型 \`${opts.resolved.spec}\`）连续 ${SUBAGENT_MAX_ATTEMPTS} 次调用失败，未成功：${detail}`,
	);
}

// --- JSON parsing (tolerant of code fences) ---------------------------------

function extractJson(raw: string): string {
	let text = raw.trim();
	// Strip an outer code fence ONLY when the whole payload is fenced. Never match a
	// fence that appears inside the JSON — a `polished` string may itself contain a
	// ```mermaid``` block, and a greedy fence match would slice out its body.
	if (text.startsWith("```")) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		if (text.endsWith("```")) text = text.slice(0, -3);
		text = text.trim();
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

// --- batching ---------------------------------------------------------------

function codePoints(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

// Pack blocks into batches of <=BATCH_LIMIT code points without truncation.
// A block that alone exceeds the limit becomes its own batch.
function batchBlocks(blocks: SplitBlock[]): SplitBlock[][] {
	const batches: SplitBlock[][] = [];
	let current: SplitBlock[] = [];
	let size = 0;
	for (const block of blocks) {
		const blockSize = codePoints(block.text);
		if (current.length > 0 && size + blockSize > BATCH_LIMIT) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += blockSize;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function relevantKeywords(keywords: string[], batchText: string): string[] {
	const haystack = batchText.toLowerCase();
	return keywords.filter(k => k.trim().length > 0 && haystack.includes(k.toLowerCase()));
}

const DEFAULT_CONCURRENCY = 6;

// Structured concurrency: run `fn` over `items` with at most `limit` in flight,
// await them all, and return results in input order. Splitting the document is
// what makes this parallelism possible; the ordered result lets the caller
// reassemble and write strictly by index.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
	const workers = Array.from({ length: width }, async () => {
		for (let i = next++; i < items.length; i = next++) {
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// --- regroup (union-find over source indices linked by polished blocks) -----

function regroup(blocks: SplitBlock[], polished: PolishBlock[]): Group[] {
	const byIndex = new Map(blocks.map(b => [b.index, b]));
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	for (const b of blocks) parent.set(b.index, b.index);
	// polished text keyed by the representative source index of each polished block
	const polishedByRep = new Map<number, string[]>();
	for (const pb of polished) {
		const known = pb.sourceIndices.filter(i => byIndex.has(i));
		if (known.length === 0) continue;
		const rep0 = known[0];
		for (const i of known.slice(1)) {
			const a = find(rep0);
			const b = find(i);
			if (a !== b) parent.set(a, b);
		}
	}
	// attach polished text to each block's group root
	for (const pb of polished) {
		const known = pb.sourceIndices.filter(i => byIndex.has(i));
		if (known.length === 0) continue;
		const root = find(known[0]);
		const list = polishedByRep.get(root) ?? [];
		list.push(pb.polished);
		polishedByRep.set(root, list);
	}
	const groupsByRoot = new Map<number, number[]>();
	for (const b of blocks) {
		const root = find(b.index);
		const list = groupsByRoot.get(root) ?? [];
		list.push(b.index);
		groupsByRoot.set(root, list);
	}
	const groups: Group[] = [];
	for (const [root, indices] of groupsByRoot) {
		const sorted = indices.sort((a, b) => a - b);
		const members = sorted.map(i => byIndex.get(i)!);
		const original = members.map(m => m.text).join("\n\n");
		const polishedText = (polishedByRep.get(root) ?? []).join("\n\n").trim() || "(润色未覆盖此块)";
		groups.push({
			sourceIndices: sorted,
			original,
			polished: polishedText,
			startLine: Math.min(...members.map(m => m.startLine)),
			endLine: Math.max(...members.map(m => m.endLine)),
			review: "",
		});
	}
	return groups.sort((a, b) => a.sourceIndices[0] - b.sourceIndices[0]);
}

// --- prompts ----------------------------------------------------------------

function splitPrompt(absOriginal: string, absOut: string, kind: string, lineCount: number): string {
	return [
		"You are a document STRUCTURING pass. Do NOT rewrite, translate, or polish — only segment and index.",
		"",
		"Steps:",
		`1. Use the read tool to read the file at: ${absOriginal}`,
		`   It is a ${kind} document with ${lineCount} lines.`,
		"2. Segment it into small paragraph-sized blocks grouped by topical relevance.",
		"   Blocks are contiguous, non-overlapping, in original order, and together cover every",
		"   non-empty line from start to end.",
		"3. Extract the COMPLETE keyword glossary: every salient domain term, name, and identifier",
		"   in the document, deduplicated.",
		`4. Use the write tool to write ONLY the following JSON (no prose) to: ${absOut}`,
		"",
		"JSON schema:",
		'{ "blocks": [ { "index": <int 0-based ascending>, "startLine": <1-based inclusive>,',
		'  "endLine": <1-based inclusive>, "title": "<short topic label>" } ],',
		'  "keywords": ["term", ...] }',
		"",
		"Rules: startLine/endLine reference the ORIGINAL file's line numbers. Do NOT include block",
		"text (the program reads it from the offsets). Do not alter the document. After the write",
		"tool succeeds, stop.",
	].join("\n");
}

function polishPrompt(batch: SplitBlock[], keywords: string[]): string {
	const blockText = batch
		.map(b => `[index ${b.index}] (${b.title || "untitled"})\n${b.text}`)
		.join("\n\n");
	return [
		"You are an engineering-focused editor. Rewrite the provided content for a software-engineer",
		"reader: clearer structure, tighter prose, better paragraph ordering WITHIN the provided",
		"content — while PRESERVING the original meaning exactly. Do not add or drop information.",
		"Keep the same language as the source.",
		"",
		"You MAY merge adjacent blocks when it improves readability; when you do, list ALL merged",
		"source indices in that output block. Cover every provided source index exactly once across",
		"all output blocks, in ascending source-index order.",
		"",
		"Return ONLY JSON (no prose, no code fence):",
		'{ "blocks": [ { "sourceIndices": [<int>...], "polished": "<rewritten text>" } ],',
		'  "keywordChanges": [ { "term": "<glossary term>", "changed": true, "to": "<new term if changed>", "reason": "<short, only when changed>" } ] }',
		'For each glossary term you touched, set "changed" to true or false; when false, omit "to" and "reason".',
		"",
		keywords.length > 0 ? `Relevant glossary: ${keywords.join(", ")}` : "Relevant glossary: (none)",
		"",
		"Source blocks:",
		blockText,
	].join("\n");
}

function checkPrompt(original: string, polished: string): string {
	return [
		"Compare a SOURCE passage with its REWRITE. Decide whether the meaning is preserved.",
		"Output a concise review (2–5 sentences) in the SAME language as the text: state whether",
		"meaning is preserved, flag any added/removed/altered claims, and note how a reader should",
		"understand the rewrite. Do NOT rewrite the text.",
		"",
		"--- SOURCE ---",
		original,
		"",
		"--- REWRITE ---",
		polished,
	].join("\n");
}

// --- core pipeline ----------------------------------------------------------

type Progress = (message: string) => void;

async function polishOneFile(
	ctx: ExtensionContext,
	absPath: string,
	models: { split: ResolvedModel; polish: ResolvedModel; check: ResolvedModel },
	progress: Progress,
	concurrency: number,
): Promise<string> {
	const ext = extname(absPath).toLowerCase();
	if (ext !== ".md" && ext !== ".txt") {
		throw new Error(`doc-polish: expected a .md or .txt file, got "${absPath}"`);
	}
	if (!existsSync(absPath) || !statSync(absPath).isFile()) {
		throw new Error(`doc-polish: file not found: ${absPath}`);
	}
	const originalText = readFileSync(absPath, "utf8");
	const originalLines = originalText.split("\n");

	// /tmp workspace: copy the original, build the review beside it.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const workspace = join("/tmp", "doc-polish", `${stamp}-${basename(absPath, ext)}`);
	mkdirSync(workspace, { recursive: true });
	const originalCopy = join(workspace, `original${ext}`);
	copyFileSync(absPath, originalCopy);
	const splitOut = join(workspace, "split.json");
	const reviewPath = join(workspace, "review.md");

	// 1. Split agent (standard subagent: read + write only, no document text in prompt).
	progress(`[${basename(absPath)}] 拆分中…`);
	await runSubSession(ctx, {
		resolved: models.split,
		role: "拆分",
		toolNames: ["read", "write"],
		prompt: splitPrompt(absPath, splitOut, ext === ".md" ? "Markdown" : "plain-text", originalLines.length),
		agentId: `docpolish-split-${stamp}`,
		cwd: workspace,
	});
	if (!existsSync(splitOut)) {
		throw new Error(`doc-polish: split agent did not write ${splitOut}`);
	}
	const splitParsed = splitSchema.parse(JSON.parse(extractJson(readFileSync(splitOut, "utf8"))));

	// Derive AUTHORITATIVE block text from the original file's line ranges.
	const blocks: SplitBlock[] = splitParsed.blocks
		.map((b, i) => {
			const start = Math.max(1, Math.min(b.startLine, originalLines.length));
			const end = Math.max(start, Math.min(b.endLine, originalLines.length));
			return {
				index: Number.isInteger(b.index) ? b.index : i,
				startLine: start,
				endLine: end,
				title: b.title ?? "",
				text: originalLines.slice(start - 1, end).join("\n").trim(),
			};
		})
		.filter(b => b.text.length > 0)
		.sort((a, b) => a.startLine - b.startLine);
	if (blocks.length === 0) throw new Error("doc-polish: split produced no usable blocks");
	const keywords = splitParsed.keywords;

	// 2. Batch, then polish every batch concurrently (structured concurrency:
	//    launch all, await all, reassemble by batch order). Splitting the document
	//    is precisely what lets the blocks be analyzed in parallel.
	const batches = batchBlocks(blocks);
	let polished = 0;
	const batchResults = await mapLimit<SplitBlock[], PolishResult>(batches, concurrency, async (batch, i) => {
		const batchText = batch.map(b => b.text).join("\n");
		const kws = relevantKeywords(keywords, batchText);
		const raw = await runSubSession(ctx, {
			resolved: models.polish,
			role: "润色",
			toolNames: [],
			prompt: polishPrompt(batch, kws),
			agentId: `docpolish-polish-${stamp}-${i}`,
			cwd: workspace,
		});
		progress(`[${basename(absPath)}] 润色 ${++polished}/${batches.length}…`);
		try {
			const p = polishSchema.parse(JSON.parse(extractJson(raw)));
			return { blocks: p.blocks, changes: p.keywordChanges, diagnostics: [] };
		} catch (err) {
			// Fall back to a 1:1 identity mapping for this batch so the pipeline still completes.
			return {
				blocks: batch.map(b => ({ sourceIndices: [b.index], polished: `(润色输出解析失败) ${b.text}` })),
				changes: [],
				diagnostics: [`批次 ${i + 1} 润色输出解析失败（raw ${[...raw].length} 字，${JSON.stringify(raw.slice(0, 120))}）：${String(err)}`],
			};
		}
	});
	const polishedBlocks: PolishBlock[] = batchResults.flatMap(r => r.blocks);
	const keywordChanges: KeywordChange[] = batchResults.flatMap(r => r.changes);
	const diagnostics: string[] = batchResults.flatMap(r => r.diagnostics);

	// 3. Regroup (detect merges via sourceIndices), then meaning-check every group
	//    concurrently; assign the reviews back by index.
	const groups = regroup(blocks, polishedBlocks);
	let checked = 0;
	const reviews = await mapLimit<Group, string>(groups, concurrency, async (g, i) => {
		const review = await runSubSession(ctx, {
			resolved: models.check,
			role: "校验",
			toolNames: [],
			prompt: checkPrompt(g.original, g.polished),
			agentId: `docpolish-check-${stamp}-${i}`,
			cwd: workspace,
		});
		progress(`[${basename(absPath)}] 校验 ${++checked}/${groups.length}…`);
		return review;
	});
	reviews.forEach((review, i) => {
		groups[i].review = review;
	});

	// 4. Write the before/after/review document.
	writeFileSync(reviewPath, renderReview(absPath, originalCopy, models, keywordChanges, groups, diagnostics), "utf8");
	return reviewPath;
}

function renderReview(
	source: string,
	originalCopy: string,
	models: { split: ResolvedModel; polish: ResolvedModel; check: ResolvedModel },
	keywordChanges: KeywordChange[],
	groups: Group[],
	diagnostics: string[],
): string {
	const lines: string[] = [];
	lines.push(`# 润色评审：${basename(source)}`);
	lines.push("");
	lines.push(`- 源文件：\`${source}\``);
	lines.push(`- 原文副本：\`${originalCopy}\``);
	lines.push(`- 生成时间：${new Date().toISOString()}`);
	lines.push(`- 拆分模型：\`${models.split.spec}\``);
	lines.push(`- 润色模型：\`${models.polish.spec}\``);
	lines.push(`- 校验模型：\`${models.check.spec}\``);
	lines.push("");
	lines.push("## 词表变更记录");
	const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
	const rows = keywordChanges
		.filter(c => c.term.trim())
		.map(c => ({
			term: c.term,
			to: c.to,
			reason: c.reason,
			isChanged: c.changed === true || (c.to.trim().length > 0 && c.to.trim() !== c.term.trim()),
		}))
		.sort((a, b) => Number(b.isChanged) - Number(a.isChanged));
	if (rows.length === 0) {
		lines.push("（无）");
	} else {
		lines.push("| 词条 | 是否变更 | 变更后 | 理由 |");
		lines.push("|---|---|---|---|");
		for (const c of rows) {
			lines.push(`| \`${cell(c.term)}\` | ${c.isChanged ? "是" : "否"} | ${c.isChanged ? cell(c.to) : ""} | ${c.isChanged ? cell(c.reason) : ""} |`);
		}
	}
	if (diagnostics.length > 0) {
		lines.push("");
		lines.push("### 处理告警");
		for (const d of diagnostics) lines.push(`- ${cell(d)}`);
	}
	lines.push("");
	groups.forEach((g, i) => {
		lines.push(`## 段落 ${i + 1}（原文块 ${g.sourceIndices.join(", ")}，第 ${g.startLine}–${g.endLine} 行）`);
		if (g.sourceIndices.length > 1) lines.push(`> 合并了 ${g.sourceIndices.length} 个原始块。`);
		lines.push("");
		lines.push("### 改之前");
		lines.push("");
		lines.push(g.original);
		lines.push("");
		lines.push("### 改之后");
		lines.push("");
		lines.push(g.polished);
		lines.push("");
		lines.push("### 点评");
		lines.push("");
		lines.push(g.review.trim() || "（校验未返回）");
		lines.push("");
	});
	return lines.join("\n");
}

// --- shared entry used by both the tool and the slash command ---------------

type PolishOptions = {
	paths: string[];
	splitModel?: string;
	polishModel?: string;
	checkModel?: string;
	concurrency?: number;
};

async function polishDocuments(
	ctx: ExtensionContext,
	options: PolishOptions,
	progress: Progress,
): Promise<{ source: string; review: string }[]> {
	const config = loadConfig(ctx.cwd);
	const invalidConfigModels = (
		[
			["splitModel", config.splitModel],
			["polishModel", config.polishModel],
			["checkModel", config.checkModel],
		] as const
	)
		.filter(([, spec]) => spec !== undefined && !modelExists(ctx, spec))
		.map(([role, spec]) => ({ role, spec: spec as string }));
	if (invalidConfigModels.length > 0) throw new DocPolishConfigError(configModelIssueMessage(invalidConfigModels));
	const fallback = defaultModelSpec(ctx);
	const splitSpec = options.splitModel ?? config.splitModel;
	const models = {
		split: resolveModelSpec(ctx, splitSpec ?? fallback),
		polish: resolveModelSpec(ctx, options.polishModel ?? config.polishModel ?? fallback),
		check: resolveModelSpec(ctx, options.checkModel ?? config.checkModel ?? splitSpec ?? fallback),
	};
	const concurrency = options.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;
	const results: { source: string; review: string }[] = [];
	for (const p of options.paths) {
		const abs = isAbsolute(p) ? p : resolvePath(ctx.cwd, p);
		const review = await polishOneFile(ctx, abs, models, progress, concurrency);
		results.push({ source: abs, review });
	}
	return results;
}

// Result text handed to an agent consumer — an LLM tool result, or (for the
// human slash command) the current session's main agent. Frames the rewrite as
// a reference direction the caller must evaluate, not an authoritative edit.
function buildAgentResultText(results: { source: string; review: string }[]): string {
	const list = results.map(r => `- ${basename(r.source)}: ${r.review}`).join("\n");
	return [
		`已生成 ${results.length} 份润色评审（改之前 / 改之后 / 点评），文件路径：`,
		list,
		"",
		"用途说明：这些评审是参考方向，不是权威结论。其中的“改之后”只是对该段的一种可选重写，",
		"“点评”给出该改写是否偏离原意、应如何理解。请阅读评审文件，逐段自行判断哪些改写值得采纳、",
		"以何种方式融入，而不是直接用改写替换原文。",
	].join("\n");
}

// --- extension registration -------------------------------------------------

export default function docPolish(pi: ExtensionAPI): void {
	const zod = pi.zod;

	pi.setLabel("Doc Polish");

	pi.registerTool({
		name: "polish_doc",
		label: "Polish Doc",
		description:
			"Restructure a .md/.txt document for engineer readability WITHOUT changing its meaning, " +
			"then emit a before/after/review file under /tmp/doc-polish and RETURN its path. Splits the " +
			"document with a read+write sub-agent, polishes batched paragraphs (<=5000 code points, never " +
			"truncated) with tool-less sub-agents in parallel, regroups merged paragraphs, then meaning-checks each " +
			"group. Models are given as full `provider/model:effort` specs; each defaults to the current " +
			"session model. The '改之后' rewrite is a REFERENCE direction, not an authoritative result: the " +
			"caller must read the review and decide what, if anything, to adopt.",
		parameters: zod.object({
			paths: zod
				.array(zod.string())
				.min(1)
				.describe("Absolute or cwd-relative paths to .md or .txt files (one sub-agent pipeline per file)."),
			splitModel: zod
				.string()
				.optional()
				.describe("Split agent model, full `provider/model:effort` spec. Defaults to the current session model."),
			polishModel: zod
				.string()
				.optional()
				.describe("Polish agent model, full `provider/model:effort` spec. Defaults to the current session model."),
			checkModel: zod
				.string()
				.optional()
				.describe("Meaning-check agent model, full `provider/model:effort` spec. Defaults to the split model."),
			concurrency: zod
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Max parallel polish/check sub-agents (structured concurrency: blocks analyzed in parallel, written by index). Defaults to 6."),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const progress: Progress = message =>
				onUpdate?.({ content: [{ type: "text", text: message }] });
			try {
				const results = await polishDocuments(ctx as ExtensionContext, params as PolishOptions, progress);
				return {
					content: [{ type: "text", text: buildAgentResultText(results) }],
					details: { results, reviewPaths: results.map(r => r.review), reference: true },
				};
			} catch (err) {
				if (err instanceof DocPolishConfigError) {
					return { content: [{ type: "text", text: err.message }], details: { configError: true } };
				}
				if (err instanceof DocPolishRuntimeError) {
					return { content: [{ type: "text", text: err.message }], details: { runtimeError: true }, isError: true };
				}
				throw err;
			}
		},
	});

	pi.registerCommand("polish-doc", {
		description: "润色文档：/polish-doc <path.md|path.txt> [更多路径…]",
		handler: async (args, ctx) => {
			const paths = args.trim().split(/\s+/).filter(Boolean);
			if (paths.length === 0) {
				ctx.ui.notify("用法：/polish-doc <path.md|path.txt> [更多路径…]", "warn");
				return;
			}
			ctx.ui.notify(`doc-polish：开始处理 ${paths.length} 个文件，完成后把结果交给主 agent…`, "info");
			try {
				const results = await polishDocuments(
					ctx as unknown as ExtensionContext,
					{ paths },
					message => ctx.ui.setStatus?.("doc-polish", message),
				);
				// Human invocation differs from an LLM tool call: deliver the result to the
				// current session's main agent as fresh input (it decides how to use the
				// reference), rather than displaying it to the human.
				void pi.sendUserMessage(buildAgentResultText(results));
			} catch (err) {
				if (err instanceof DocPolishConfigError) {
					void pi.sendUserMessage(err.message);
				} else if (err instanceof DocPolishRuntimeError) {
					ctx.ui.notify(err.message, "error");
				} else {
					ctx.ui.notify(`doc-polish 失败：${String(err)}`, "error");
				}
			}
		},
	});
}
