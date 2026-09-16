import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { FileType, glob, grep, GrepOutputMode } from "@oh-my-pi/pi-natives";
import type { GlobMatch, GrepMatch } from "@oh-my-pi/pi-natives";
import {
	AgentRegistry,
	MAIN_AGENT_ID,
	type AgentRef,
	type ExtensionAPI,
	type ExtensionContext,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { resolveLocalRoot, type LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const COLLAPSE_THRESHOLD = 8;
const SUMMARY_LIMIT = 120;
const SUMMARY_PREFIX_BYTES = 8 * 1024;
const SUMMARY_GREP_COLUMNS = 400;
const SUMMARY_KEYS = ["summary", "report", "report_path", "review", "verdict", "assessment", "advice", "status", "findings"] as const;
const STRUCTURED_SUMMARY_KEYS = ["implementation", "result", "outcome", "conclusion", "notes"] as const;
const SUMMARY_SCAN_LIMIT = 64;
const SIDECAR_SUMMARY_PATTERN = '"(?:summary|report|report_path|review|verdict|assessment|advice|status|findings)"\\s*:';
/**
 * Matches the first-line session header JSON object emitted by OMP into
 * each `*.jsonl` transcript (`{"type":"session","id":"…","timestamp":…}`).
 * `grep` in `headersFor` uses this to pull just the header line rather
 * than reading whole files; a hit is parsed by `parseSessionHeader`.
 */
const SESSION_HEADER_PATTERN = '"type"\\s*:\\s*"session"';
/**
 * Matches the `session_init` record OMP writes after the header line;
 * `headersFor` greps it to recover the spawned agent flavor
 * (`"agent":"task:low"`), parsed by `parseSessionInitAgent`.
 */
const SESSION_INIT_PATTERN = '"type"\\s*:\\s*"session_init"';

const contextParams = z.object({
	op: z.enum(["list", "show"]),
	id: z.string().optional(),
	all: z.boolean().optional(),
});

type ContextParams = z.infer<typeof contextParams>;
type CtxToolDetails = {
	op: ContextParams["op"];
	count: number;
	shown?: number;
	hidden?: number;
	subtree?: string;
};

type ContextKind = "main" | "sub";
type ContextStatus = AgentRef["status"] | "on disk" | "live";

type SummaryCell = { readonly kind: "none" } | { readonly kind: "text"; readonly text: string };

type FileMetadata = {
	readonly mtimeMs: number;
	readonly size: number;
};

type SpawnHeader = {
	readonly sessionId?: string;
	readonly timestampMs?: number;
	readonly agent?: string;
};

type TaskCounts = {
	done: number;
	total: number;
};

type TimelineEntry = {
	readonly text: string;
	readonly atMs: number;
	readonly blocked?: string;
};

type TaskTimeline = {
	readonly done: readonly TimelineEntry[];
	readonly open: readonly TimelineEntry[];
};

type TaskLogEvent =
	| { tool: "todo"; op: "init" | "start" | "done" | "drop" | "block" | "unblock" | "append" | "rm" | "view"; detail: string; atMs: number }
	| { tool: "goal"; op: "create" | "get" | "resume" | "complete" | "drop"; detail: string; atMs: number };

type CurrentSessionState = {
	id: string;
	kind: ContextKind;
	status: ContextStatus;
	lastTimestampMs?: number;
	latestCompaction?: CompactionEntry;
	firstUserPrompt?: string;
};

type NodeData = {
	readonly summary: SummaryCell;
	readonly handoff: string;
	readonly tasks?: TaskCounts;
	readonly timeline?: TaskTimeline;
};

type ContextNode = {
	readonly id: string;
	readonly kind: ContextKind;
	readonly status: ContextStatus;
	readonly parentId?: string;
	readonly spawnedAtMs?: number;
	readonly spawnHeaderId?: string;
	readonly lastActivityMs?: number;
	readonly flavor?: string;
	readonly summary: SummaryCell;
	readonly tasks?: TaskCounts;
	readonly handoff: string;
	readonly timeline?: TaskTimeline;
	readonly file?: string;
	readonly children: readonly ContextNode[];
};

type ContextDraft = {
	readonly id: string;
	readonly kind: ContextKind;
	readonly status: ContextStatus;
	parentId?: string;
	readonly spawnedAtMs?: number;
	readonly spawnHeaderId?: string;
	readonly lastActivityMs?: number;
	readonly file?: string;
	readonly flavor?: string;
	readonly children: ContextDraft[];
};

type TranscriptCacheEntry = FileMetadata & {
	readonly header: SpawnHeader;
	readonly data: NodeData;
};

type SidecarCacheEntry = FileMetadata & {
	readonly summary: SummaryCell;
	readonly empty: boolean;
	readonly handoffChecked: boolean;
	readonly handoff?: string;
};

type TaskLogCacheEntry = FileMetadata & {
	readonly counts: TaskCounts;
	readonly timeline: TaskTimeline;
};

type TranscriptSource = {
	readonly id: string;
	readonly file: string;
	readonly relativePath: string;
	readonly metadata: FileMetadata;
	readonly header: SpawnHeader;
	readonly ref?: AgentRef;
	readonly directoryParentId?: string;
};

type RegistrySource = {
	readonly id: string;
	readonly file?: string;
	readonly relativePath?: string;
	readonly metadata?: FileMetadata;
	readonly header: SpawnHeader;
	readonly ref?: AgentRef;
	readonly directoryParentId?: string;
};

type ContextSource = TranscriptSource | RegistrySource;

type Inventory = {
	readonly localRoot: string;
	readonly artifactRoot: string | undefined;
	readonly current: CurrentSessionState;
	readonly currentCompactionHandoff: string;
	readonly sidecars: FileSnapshot;
	readonly taskLogs: FileSnapshot;
	readonly root: ContextDraft;
	readonly byId: ReadonlyMap<string, ContextDraft>;
};

type FileSnapshot = {
	readonly metadataByPath: ReadonlyMap<string, FileMetadata>;
	readonly relativeByPath: ReadonlyMap<string, string>;
};

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type JsonObject = Record<string, unknown>;

const transcriptCache = new Map<string, TranscriptCacheEntry>();
const sidecarCache = new Map<string, SidecarCacheEntry>();
const taskLogCache = new Map<string, TaskLogCacheEntry>();

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const timestamp = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseJsonValue(text: string): unknown | undefined {
	const trimmed = text.trim().replace(/^\uFEFF/, "");
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function parseJsonObject(line: string): JsonObject | undefined {
	const value = parseJsonValue(line);
	return isRecord(value) ? value : undefined;
}

function textField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit = SUMMARY_LIMIT): string {
	const normalized = oneLine(value);
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}
type SummaryScanState = {
	visited: number;
};

function firstUsableString(value: unknown, maxDepth: number, state: SummaryScanState = { visited: 0 }): string | undefined {
	if (state.visited >= SUMMARY_SCAN_LIMIT) return undefined;
	state.visited += 1;
	const direct = textField(value);
	if (direct) return direct;
	if (maxDepth <= 0 || (!Array.isArray(value) && !isRecord(value))) return undefined;
	const children = Array.isArray(value) ? value : Object.values(value);
	for (const child of children) {
		const text = firstUsableString(child, maxDepth - 1, state);
		if (text) return text;
	}
	return undefined;
}

function summaryTextValue(value: unknown): string | undefined {
	const text = textField(value);
	if (text) return text;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return firstUsableString(value, 2);
}

function summaryTextFromJson(value: unknown): string | undefined {
	const direct = textField(value);
	if (direct) return direct;
	if (Array.isArray(value)) return firstUsableString(value, 2);
	if (!isRecord(value)) return summaryTextValue(value);
	for (const key of SUMMARY_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		const text = summaryTextValue(value[key]);
		if (text) return text;
	}
	for (const key of STRUCTURED_SUMMARY_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		const text = summaryTextValue(value[key]);
		if (text) return text;
	}
	const state: SummaryScanState = { visited: 0 };
	for (const item of Object.values(value)) {
		if (state.visited >= SUMMARY_SCAN_LIMIT) break;
		state.visited += 1;
		const text = textField(item);
		if (text) return text;
	}
	for (const item of Object.values(value)) {
		if (state.visited >= SUMMARY_SCAN_LIMIT) break;
		state.visited += 1;
		if (!Array.isArray(item)) continue;
		for (const child of item) {
			if (state.visited >= SUMMARY_SCAN_LIMIT) break;
			state.visited += 1;
			const text = textField(child);
			if (text) return text;
		}
	}
	for (const item of Object.values(value)) {
		if (state.visited >= SUMMARY_SCAN_LIMIT) break;
		const text = firstUsableString(item, 2, state);
		if (text) return text;
	}
	return undefined;
}
function summaryCellFromText(value: string): SummaryCell {
	const parsed = parseJsonValue(value);
	if (parsed !== undefined) {
		const jsonSummary = summaryTextFromJson(parsed);
		return jsonSummary ? { kind: "text", text: truncate(jsonSummary) } : { kind: "none" };
	}
	const firstLine = value
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line.length > 0);
	return firstLine ? { kind: "text", text: truncate(firstLine) } : { kind: "none" };
}

function summaryCellFromLine(line: string): SummaryCell | undefined {
	const parsed = parseJsonValue(line);
	if (parsed !== undefined) {
		const text = summaryTextFromJson(parsed);
		return text ? { kind: "text", text: truncate(text) } : { kind: "none" };
	}
	const match = /"(summary|report|report_path|review|verdict|assessment|advice|status|findings)"\s*:\s*(.*?)(?:,\s*)?$/.exec(line.trim());
	if (!match) return undefined;
	const key = match[1]!;
	const rawValue = match[2]!.trim();
	let value: unknown = rawValue;
	try {
		value = JSON.parse(rawValue) as unknown;
	} catch {
		if (rawValue.startsWith('"')) {
			value = rawValue.slice(1).replace(/"$/, "");
		} else if (rawValue.startsWith("'")) {
			value = rawValue.slice(1).replace(/'$/, "");
		}
	}
	const text = summaryTextFromJson({ [key]: value });
	return text ? { kind: "text", text: truncate(text) } : { kind: "none" };
}

function asPath(value: string | null | undefined): string | undefined {
	return value ? path.resolve(value) : undefined;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
	return left !== undefined && right !== undefined && asPath(left) === asPath(right);
}

function isWithin(child: string, root: string): boolean {
	const resolvedChild = path.resolve(child);
	const resolvedRoot = path.resolve(root);
	return resolvedChild === resolvedRoot || resolvedChild.startsWith(`${resolvedRoot}${path.sep}`);
}

function safeAgentIdFromFile(file: string): string | undefined {
	const name = path.basename(file);
	if (!name.endsWith(".jsonl")) return undefined;
	const id = name.slice(0, -".jsonl".length);
	return id.length > 0 ? id : undefined;
}

function normalizedRelativePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function absoluteFromRelative(root: string, relativePath: string): string {
	return path.resolve(root, ...normalizedRelativePath(relativePath).split("/"));
}

function idFromRelativePath(relativePath: string): string | undefined {
	const name = path.posix.basename(normalizedRelativePath(relativePath));
	if (!name.endsWith(".jsonl")) return undefined;
	const id = name.slice(0, -".jsonl".length);
	return id.length > 0 ? id : undefined;
}

function parentDirectoryId(relativePath: string): string | undefined {
	const directory = path.posix.dirname(normalizedRelativePath(relativePath));
	if (directory === ".") return undefined;
	const parent = path.posix.basename(directory);
	return parent.length > 0 ? parent : undefined;
}

function localOptionsFor(ctx: ExtensionContext): LocalProtocolOptions {
	return (
		ctx.localProtocolOptions ?? {
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		}
	);
}

function artifactRootFor(ctx: ExtensionContext, options: LocalProtocolOptions): string | undefined {
	const configured = options.getArtifactsDir?.();
	return asPath(configured ?? ctx.sessionManager.getArtifactsDir());
}

function refsFromRegistry(): AgentRef[] {
	try {
		return AgentRegistry.global().list().filter(ref => ref.kind !== "advisor");
	} catch {
		return [];
	}
}

function refSessionFile(ref: AgentRef): string | undefined {
	return asPath(ref.sessionFile ?? ref.session?.sessionFile);
}

function currentRefFor(ctx: ExtensionContext, refs: readonly AgentRef[]): AgentRef | undefined {
	const sessionFile = asPath(ctx.sessionManager.getSessionFile());
	const bySessionObject = refs.find(ref => ref.session?.sessionManager === ctx.sessionManager);
	if (bySessionObject) return bySessionObject;
	if (sessionFile) {
		const byFile = refs.find(ref => samePath(refSessionFile(ref), sessionFile));
		if (byFile) return byFile;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	return refs.find(ref => ref.session?.sessionManager.getSessionId() === sessionId);
}

function inferCurrentId(ctx: ExtensionContext, root: string | undefined, ref: AgentRef | undefined): string {
	if (ref) return ref.id;
	const sessionFile = asPath(ctx.sessionManager.getSessionFile());
	if (sessionFile && root && isWithin(sessionFile, root)) return safeAgentIdFromFile(sessionFile) ?? MAIN_AGENT_ID;
	return MAIN_AGENT_ID;
}

function inferCurrentKind(ctx: ExtensionContext, root: string | undefined, ref: AgentRef | undefined): ContextKind {
	if (ref) return ref.kind === "main" ? "main" : "sub";
	const sessionFile = asPath(ctx.sessionManager.getSessionFile());
	return sessionFile && root && isWithin(sessionFile, root) ? "sub" : "main";
}

function registryDescriptor(
	ref: AgentRef | undefined,
	fallbackKind: ContextKind,
	fallbackStatus: ContextStatus,
	fallbackParentId: string | undefined,
): { kind: ContextKind; status: ContextStatus; parentId?: string } {
	return {
		kind: ref ? (ref.kind === "main" ? "main" : "sub") : fallbackKind,
		status: ref?.status ?? fallbackStatus,
		parentId: ref?.parentId ?? fallbackParentId,
	};
}

function metadataFromMatch(match: GlobMatch): FileMetadata {
	const mtimeMs = typeof match.mtime === "number" && Number.isFinite(match.mtime) ? match.mtime : 0;
	const size = typeof match.size === "number" && Number.isFinite(match.size) ? match.size : 0;
	return { mtimeMs, size };
}

function sameMetadata(left: FileMetadata | undefined, right: FileMetadata | undefined): boolean {
	return left !== undefined && right !== undefined && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function nativeGlob(root: string | undefined, pattern: string): Promise<GlobMatch[]> {
	if (!root) return [];
	try {
		const result = await glob({
			pattern,
			path: root,
			fileType: FileType.File,
			hidden: true,
			gitignore: false,
			sortByMtime: true,
			cache: true,
		});
		return result.matches;
	} catch {
		return [];
	}
}

function snapshotsFromMatches(root: string | undefined, matches: readonly GlobMatch[]): FileSnapshot {
	const metadataByPath = new Map<string, FileMetadata>();
	const relativeByPath = new Map<string, string>();
	if (!root) return { metadataByPath, relativeByPath };
	for (const match of matches) {
		const relativePath = normalizedRelativePath(match.path);
		const file = absoluteFromRelative(root, relativePath);
		if (!isWithin(file, root)) continue;
		metadataByPath.set(file, metadataFromMatch(match));
		relativeByPath.set(file, relativePath);
	}
	return { metadataByPath, relativeByPath };
}

function parseSessionHeader(line: string): SpawnHeader {
	const parsed = parseJsonObject(line);
	if (!parsed || parsed.type !== "session") return {};
	const sessionId = textField(parsed.id);
	const timestampMs = parseTimestamp(parsed.timestamp);
	return {
		sessionId,
		timestampMs,
	};
}

function parseSessionInitAgent(line: string): string | undefined {
	const parsed = parseJsonObject(line);
	if (!parsed || parsed.type !== "session_init") return undefined;
	return textField(parsed.agent);
}

async function headersFor(
	root: string | undefined,
	matches: readonly GlobMatch[],
): Promise<ReadonlyMap<string, SpawnHeader>> {
	const active = matches.filter(match => !path.posix.basename(normalizedRelativePath(match.path)).startsWith("__advisor"));
	if (!root || active.length === 0) return new Map();
	const cachedHeaders = new Map<string, SpawnHeader>();
	let allFresh = true;
	for (const match of active) {
		const relativePath = normalizedRelativePath(match.path);
		const file = absoluteFromRelative(root, relativePath);
		const cached = transcriptCache.get(file);
		const metadata = metadataFromMatch(match);
		if (!cached || !sameMetadata(cached, metadata)) {
			allFresh = false;
			continue;
		}
		cachedHeaders.set(relativePath, cached.header);
	}
	if (allFresh) return cachedHeaders;
	try {
		const [sessionResult, initResult] = await Promise.all([
			grep({
				pattern: SESSION_HEADER_PATTERN,
				path: root,
				glob: "*.jsonl",
				mode: GrepOutputMode.Content,
				maxCountPerFile: 1,
				gitignore: false,
				hidden: true,
			}),
			grep({
				pattern: SESSION_INIT_PATTERN,
				path: root,
				glob: "*.jsonl",
				mode: GrepOutputMode.Content,
				maxCountPerFile: 1,
				gitignore: false,
				hidden: true,
			}),
		]);
		const agents = new Map<string, string>();
		for (const match of initResult.matches) {
			const relativePath = normalizedRelativePath(match.path);
			if (path.posix.basename(relativePath).startsWith("__advisor")) continue;
			const agent = parseSessionInitAgent(match.line);
			if (agent) agents.set(relativePath, agent);
		}
		const headers = new Map<string, SpawnHeader>();
		for (const match of sessionResult.matches) {
			const relativePath = normalizedRelativePath(match.path);
			if (path.posix.basename(relativePath).startsWith("__advisor")) continue;
			const base = parseSessionHeader(match.line);
			const agent = agents.get(relativePath);
			headers.set(relativePath, agent ? { ...base, agent } : base);
		}
		for (const [relativePath, agent] of agents) {
			if (!headers.has(relativePath)) headers.set(relativePath, { agent });
		}
		return headers;
	} catch {
		return cachedHeaders;
	}
}

function pruneTranscriptCache(activeFiles: ReadonlySet<string>): void {
	for (const file of transcriptCache.keys()) {
		if (!activeFiles.has(file)) transcriptCache.delete(file);
	}
}

function sourceFromTranscript(
	root: string,
	match: GlobMatch,
	header: SpawnHeader,
): TranscriptSource | undefined {
	const relativePath = normalizedRelativePath(match.path);
	if (path.posix.basename(relativePath).startsWith("__advisor")) return undefined;
	const id = idFromRelativePath(relativePath);
	if (!id) return undefined;
	return {
		id,
		file: absoluteFromRelative(root, relativePath),
		relativePath,
		metadata: metadataFromMatch(match),
		header,
		directoryParentId: parentDirectoryId(relativePath),
	};
}

function createsCycle(id: string, parentId: string, parents: ReadonlyMap<string, string | undefined>): boolean {
	const seen = new Set<string>();
	let current: string | undefined = parentId;
	while (current) {
		if (current === id || seen.has(current)) return true;
		seen.add(current);
		current = parents.get(current);
	}
	return false;
}

function dottedParentId(id: string, knownIds: ReadonlySet<string>): string | undefined {
	let separator = id.lastIndexOf(".");
	while (separator > 0) {
		const candidate = id.slice(0, separator);
		if (knownIds.has(candidate)) return candidate;
		separator = id.lastIndexOf(".", separator - 1);
	}
	return undefined;
}

function candidateParentId(source: ContextSource, knownIds: ReadonlySet<string>): string | undefined {
	if (source.ref?.parentId) return source.ref.parentId;
	if (source.directoryParentId) return source.directoryParentId;
	return dottedParentId(source.id, knownIds);
}

function siblingCompare(left: ContextDraft, right: ContextDraft): number {
	const leftSpawned = left.spawnedAtMs;
	const rightSpawned = right.spawnedAtMs;
	if (leftSpawned === undefined && rightSpawned !== undefined) return 1;
	if (leftSpawned !== undefined && rightSpawned === undefined) return -1;
	if (leftSpawned !== undefined && rightSpawned !== undefined && leftSpawned !== rightSpawned) return leftSpawned - rightSpawned;
	const leftHeaderId = left.spawnHeaderId;
	const rightHeaderId = right.spawnHeaderId;
	if (leftHeaderId === undefined && rightHeaderId !== undefined) return 1;
	if (leftHeaderId !== undefined && rightHeaderId === undefined) return -1;
	if (leftHeaderId !== undefined && rightHeaderId !== undefined) {
		const headerOrder = leftHeaderId.localeCompare(rightHeaderId);
		if (headerOrder !== 0) return headerOrder;
	}
	return left.id.localeCompare(right.id);
}

function sortDraftChildren(node: ContextDraft): void {
	node.children.sort(siblingCompare);
	for (const child of node.children) sortDraftChildren(child);
}

function mergeSource(
	sources: Map<string, ContextSource>,
	id: string,
	value: ContextSource,
): void {
	const previous = sources.get(id);
	sources.set(id, {
		id,
		file: value.file ?? previous?.file,
		relativePath: value.relativePath ?? previous?.relativePath,
		metadata: value.metadata ?? previous?.metadata,
		header: value.header.sessionId || value.header.timestampMs !== undefined ? value.header : previous?.header ?? {},
		ref: value.ref ?? previous?.ref,
		directoryParentId: value.directoryParentId ?? previous?.directoryParentId,
	});
}

function makeDrafts(
	current: CurrentSessionState,
	sources: ReadonlyMap<string, ContextSource>,
): { root: ContextDraft; byId: ReadonlyMap<string, ContextDraft> } {
	const root: ContextDraft = {
		id: current.id,
		kind: current.kind,
		status: current.status,
		spawnedAtMs: undefined,
		lastActivityMs: current.lastTimestampMs,
		children: [],
	};
	const drafts = new Map<string, ContextDraft>([[root.id, root]]);
	const knownIds = new Set<string>([root.id, ...sources.keys()]);
	const parents = new Map<string, string | undefined>();
	for (const source of sources.values()) {
		if (source.id === root.id) continue;
		const descriptor = registryDescriptor(source.ref, "sub", "on disk", candidateParentId(source, knownIds));
		const spawnedAtMs = source.header.timestampMs ?? source.ref?.createdAt;
		const lastActivityMs = [source.metadata?.mtimeMs, source.ref?.lastActivity].reduce<number | undefined>(
			(latest, value) => (value !== undefined && (latest === undefined || value > latest) ? value : latest),
			undefined,
		);
		const draft: ContextDraft = {
			id: source.id,
			kind: descriptor.kind,
			status: descriptor.status,
			parentId: descriptor.parentId,
			spawnedAtMs,
			spawnHeaderId: source.header.sessionId,
			lastActivityMs,
			file: source.file,
			flavor: source.ref?.history?.agent ?? source.header.agent,
			children: [],
		};
		drafts.set(source.id, draft);
	}
	for (const source of sources.values()) {
		if (source.id === root.id) continue;
		const draft = drafts.get(source.id);
		if (!draft) continue;
		const preferredParent = draft.parentId;
		const parentForTree =
			preferredParent && drafts.has(preferredParent) && preferredParent !== source.id && !createsCycle(source.id, preferredParent, parents)
				? preferredParent
				: root.id;
		parents.set(source.id, parentForTree);
		draft.parentId = parentForTree;
		drafts.get(parentForTree)!.children.push(draft);
	}
	sortDraftChildren(root);
	return { root, byId: drafts };
}

async function readTextFile(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

async function readPrefixTextFile(file: string): Promise<string | undefined> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(file, "r");
		const bytes = new Uint8Array(SUMMARY_PREFIX_BYTES);
		const result = await handle.read(bytes, 0, bytes.length, 0);
		return new TextDecoder().decode(bytes.subarray(0, result.bytesRead));
	} catch {
		return undefined;
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

function extractTextContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map(item => {
			if (!isRecord(item) || item.type !== "text") return "";
			return textField(item.text) ?? "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractUserPrompt(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const text = extractTextContent(message.content);
	return text.trim().length > 0 ? text : undefined;
}

function latestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

function firstUserPrompt(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const prompt = extractUserPrompt(entry.message);
		if (prompt) return prompt;
	}
	return undefined;
}

function fileOperationCount(value: unknown): number | undefined {
	if (Array.isArray(value)) return value.length;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
	return undefined;
}

function compactionDetails(entry: CompactionEntry): { readFiles?: number; modifiedFiles?: number } {
	if (!isRecord(entry.details)) return {};
	return {
		readFiles: fileOperationCount(entry.details.readFiles),
		modifiedFiles: fileOperationCount(entry.details.modifiedFiles),
	};
}

function isRemoteCompactionPlaceholder(value: string | undefined): boolean {
	if (!value) return false;
	return /remote compaction/i.test(value.trim());
}

function compactionCountsSuffix(entry: CompactionEntry): string {
	const details = compactionDetails(entry);
	const counts: string[] = [];
	if (details.readFiles !== undefined) counts.push(`read ${details.readFiles} files`);
	if (details.modifiedFiles !== undefined) counts.push(`modified ${details.modifiedFiles} files`);
	return counts.length > 0 ? ` (${counts.join(", ")})` : "";
}

function compactionSummary(entry: CompactionEntry): SummaryCell {
	const shortSummary = textField(entry.shortSummary);
	const summary = textField(entry.summary);
	const preferred = shortSummary ?? summary;
	if (!preferred) return { kind: "none" };
	if (isRemoteCompactionPlaceholder(shortSummary) || isRemoteCompactionPlaceholder(summary)) {
		const suffix = compactionCountsSuffix(entry);
		return { kind: "text", text: truncate(`${preferred}${suffix}`) };
	}
	return { kind: "text", text: truncate(preferred) };
}

function compactionHandoff(entry: CompactionEntry): string {
	const summary = textField(entry.summary) ?? textField(entry.shortSummary) ?? "(none)";
	if (isRemoteCompactionPlaceholder(entry.summary) || isRemoteCompactionPlaceholder(entry.shortSummary)) {
		const suffix = compactionCountsSuffix(entry);
		return suffix ? `${summary}${suffix}` : summary;
	}
	return summary;
}

function sidecarPath(directory: string, id: string, extension: ".md" | ".json"): string | undefined {
	const candidate = path.resolve(directory, `${id}${extension}`);
	return isWithin(candidate, directory) ? candidate : undefined;
}

function sidecarCandidates(node: ContextDraft, artifactRoot: string | undefined, localRoot: string): readonly string[] {
	const directory = node.file ? path.dirname(node.file) : artifactRoot ?? localRoot;
	const markdown = sidecarPath(directory, node.id, ".md");
	const json = sidecarPath(directory, node.id, ".json");
	return [markdown, json].filter((candidate): candidate is string => candidate !== undefined);
}

function sidecarMatchByPath(root: string | undefined, matches: readonly GrepMatch[]): ReadonlyMap<string, GrepMatch> {
	const result = new Map<string, GrepMatch>();
	if (!root) return result;
	for (const match of matches) {
		const relativePath = normalizedRelativePath(match.path);
		const file = path.isAbsolute(relativePath) ? path.resolve(relativePath) : absoluteFromRelative(root, relativePath);
		if (isWithin(file, root)) result.set(file, match);
	}
	return result;
}

async function sidecarSummaryMatches(root: string | undefined, extensions: readonly ("md" | "json")[]): Promise<ReadonlyMap<string, GrepMatch>> {
	if (!root || extensions.length === 0) return new Map();
	const results = await Promise.all(
		extensions.map(async extension => {
			try {
				return await grep({
					pattern: SIDECAR_SUMMARY_PATTERN,
					path: root,
					glob: `*.${extension}`,
					mode: GrepOutputMode.Content,
					maxCountPerFile: 1,
					maxColumns: SUMMARY_GREP_COLUMNS,
					gitignore: false,
					hidden: true,
				});
			} catch {
				return { matches: [] as GrepMatch[] };
			}
		}),
	);
	const result = new Map<string, GrepMatch>();
	for (const output of results) {
		for (const [file, match] of sidecarMatchByPath(root, output.matches).entries()) result.set(file, match);
	}
	return result;
}

async function deriveSidecarSummary(file: string, metadata: FileMetadata, match: GrepMatch | undefined): Promise<SidecarCacheEntry> {
	if (match) {
		const fromLine = summaryCellFromLine(match.line);
		if (fromLine?.kind === "text") {
			return { ...metadata, summary: fromLine, empty: false, handoffChecked: false };
		}
	}
	const prefix = await readPrefixTextFile(file);
	const summary: SummaryCell = prefix === undefined ? { kind: "none" } : summaryCellFromText(prefix);
	return {
		...metadata,
		summary,
		empty: prefix === undefined || prefix.trim().length === 0,
		handoffChecked: false,
	};
}

function cachedSidecar(file: string, metadata: FileMetadata | undefined): SidecarCacheEntry | undefined {
	const cached = sidecarCache.get(file);
	return cached && sameMetadata(cached, metadata) ? cached : undefined;
}

async function sidecarSummaryFor(
	candidates: readonly string[],
	snapshots: FileSnapshot,
	matches: ReadonlyMap<string, GrepMatch>,
): Promise<SummaryCell> {
	for (const file of candidates) {
		const metadata = snapshots.metadataByPath.get(file);
		if (!metadata) continue;
		const existing = cachedSidecar(file, metadata);
		const entry = existing ?? (await deriveSidecarSummary(file, metadata, matches.get(file)));
		if (!existing) sidecarCache.set(file, entry);
		if (!entry.empty) return entry.summary;
	}
	return { kind: "none" };
}

function taskLogPath(localRoot: string, id: string): string {
	return path.resolve(localRoot, "task-log", `${id}.md`);
}

async function taskLogFor(
	localRoot: string,
	id: string,
	snapshots: FileSnapshot,
): Promise<{ counts: TaskCounts | undefined; timeline: TaskTimeline | undefined }> {
	const file = taskLogPath(localRoot, id);
	const metadata = snapshots.metadataByPath.get(file);
	if (!metadata) return { counts: undefined, timeline: undefined };
	const cached = taskLogCache.get(file);
	if (cached && sameMetadata(cached, metadata)) return { counts: cached.counts, timeline: cached.timeline };
	const text = await readTextFile(file);
	if (text === undefined) return { counts: undefined, timeline: undefined };
	const counts = taskLogCounts(text);
	const timeline = taskLogTimeline(text);
	taskLogCache.set(file, { ...metadata, counts, timeline });
	return { counts, timeline };
}

function parseLogTimestamp(date: string, time: string): number {
	// Task-log timestamps are already local wall time (see ctx-tasklog
	// `formatLocalTimestamp`); parsing without a suffix keeps them in the
	// same local zone. Non-matching lines are already filtered upstream.
	const parsed = Date.parse(`${date}T${time}`);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseTaskLogEvent(line: string): TaskLogEvent | undefined {
	const match = /^-\s+(\S+)\s+(\S+)\s+(todo|goal)\s+([a-z]+):\s*(.*)$/i.exec(line.trim());
	if (!match) return undefined;
	const atMs = parseLogTimestamp(match[1]!, match[2]!);
	const tool = match[3]?.toLowerCase();
	const op = match[4]?.toLowerCase();
	const detail = match[5] ?? "";
	if (tool === "todo") {
		if (
			op === "init" ||
			op === "start" ||
			op === "done" ||
			op === "drop" ||
			op === "block" ||
			op === "unblock" ||
			op === "append" ||
			op === "rm" ||
			op === "view"
		) {
			return { tool, op, detail, atMs };
		}
		return undefined;
	}
	if (tool === "goal" && (op === "create" || op === "get" || op === "resume" || op === "complete" || op === "drop")) {
		return { tool, op, detail, atMs };
	}
	return undefined;
}

function taskTarget(detail: string): string | undefined {
	const match = /"((?:\\.|[^"\\])*)"/.exec(detail);
	return match?.[1]?.replace(/\\(["\\])/g, "$1");
}

function taskInitCount(detail: string): number | undefined {
	const match = /\/\s*(\d+)\s+tasks?\b/i.exec(detail);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function taskAppendCount(detail: string): number | undefined {
	const match = /\+\s*(\d+)\b/.exec(detail);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function taskPhaseName(detail: string): string | undefined {
	if (!/^phase\s+/i.test(detail.trim())) return undefined;
	return taskTarget(detail);
}

function isAllTasks(detail: string): boolean {
	const normalized = detail.trim().toLowerCase();
	return normalized === "all tasks" || normalized === '"all tasks"';
}

function taskLogCounts(content: string): TaskCounts {
	let total = 0;
	let done = 0;
	const phaseCounts = new Map<string, number>();
	const taskStates = new Map<string, "open" | "done" | "dropped">();
	for (const line of content.split(/\r?\n/)) {
		const event = parseTaskLogEvent(line);
		if (!event || event.tool !== "todo") continue;
		switch (event.op) {
			case "init": {
				const count = taskInitCount(event.detail);
				if (count === undefined) break;
				total = count;
				done = 0;
				phaseCounts.clear();
				taskStates.clear();
				break;
			}
			case "append": {
				const count = taskAppendCount(event.detail);
				if (count === undefined) break;
				total += count;
				const phase = taskPhaseName(event.detail);
				if (phase) phaseCounts.set(phase, (phaseCounts.get(phase) ?? 0) + count);
				break;
			}
			case "start":
			case "block":
			case "unblock": {
				const target = taskTarget(event.detail);
				if (target && !taskStates.has(target)) taskStates.set(target, "open");
				break;
			}
			case "done": {
				if (isAllTasks(event.detail)) {
					done = total;
					break;
				}
				const target = taskTarget(event.detail);
				if (target) {
					const previous = taskStates.get(target);
					if (previous !== "done") done += 1;
					taskStates.set(target, "done");
				} else {
					done += 1;
				}
				break;
			}
			case "drop": {
				const target = taskTarget(event.detail);
				if (target) taskStates.set(target, "dropped");
				break;
			}
			case "rm": {
				if (isAllTasks(event.detail)) {
					total = 0;
					done = 0;
					phaseCounts.clear();
					taskStates.clear();
					break;
				}
				const target = taskTarget(event.detail);
				if (!target) break;
				if (/^phase\s+/i.test(event.detail.trim())) {
					const removed = phaseCounts.get(target);
					if (removed !== undefined) {
						total = Math.max(0, total - removed);
						done = Math.min(done, total);
						phaseCounts.delete(target);
					}
					break;
				}
				const previous = taskStates.get(target);
				if (previous === "done") done = Math.max(0, done - 1);
				if (previous !== undefined) total = Math.max(0, total - 1);
				taskStates.delete(target);
				break;
			}
			case "view":
				break;
		}
	}
	return { done: Math.min(done, total), total: Math.max(total, 0) };
}

function parseBlockReason(detail: string): string | undefined {
	const match = /"\s*\(([^)]+)\)\s*$/.exec(detail.trim());
	return match?.[1]?.trim();
}

type InternalTaskState = {
	status: "done" | "open" | "removed";
	atMs: number;
	blocked?: string;
};

/**
 * Materializes the per-task latest state from a task-log so the timeline
 * shows what actually got done vs. what is still open, with each task
 * appearing once. Updates (block/unblock, re-start) and removals
 * (rm, drop) collapse into the latest observable state; removed and
 * dropped tasks are elided from the rendered timeline.
 *
 * `init` clears everything since it replaces the whole task list.
 * `append` carries no task names (only a count) so it cannot seed
 * entries here; those tasks surface once they are touched.
 * `done all tasks` marks every non-removed task done at that moment.
 */
export function taskLogTimeline(content: string): TaskTimeline {
	const tasks = new Map<string, InternalTaskState>();
	for (const line of content.split(/\r?\n/)) {
		const event = parseTaskLogEvent(line);
		if (!event || event.tool !== "todo") continue;
		switch (event.op) {
			case "init":
				tasks.clear();
				break;
			case "append":
			case "view":
				break;
			case "start":
			case "unblock": {
				const target = taskTarget(event.detail);
				if (!target) break;
				const prev = tasks.get(target);
				if (prev?.status === "done" || prev?.status === "removed") break;
				tasks.set(target, { status: "open", atMs: event.atMs });
				break;
			}
			case "block": {
				const target = taskTarget(event.detail);
				if (!target) break;
				const prev = tasks.get(target);
				if (prev?.status === "done" || prev?.status === "removed") break;
				tasks.set(target, { status: "open", atMs: event.atMs, blocked: parseBlockReason(event.detail) });
				break;
			}
			case "done": {
				if (isAllTasks(event.detail)) {
					for (const [key, value] of tasks) {
						if (value.status !== "removed") tasks.set(key, { status: "done", atMs: event.atMs });
					}
					break;
				}
				const target = taskTarget(event.detail);
				if (!target) break;
				tasks.set(target, { status: "done", atMs: event.atMs });
				break;
			}
			case "drop":
			case "rm": {
				if (isAllTasks(event.detail)) {
					tasks.clear();
					break;
				}
				const target = taskTarget(event.detail);
				if (!target) break;
				tasks.set(target, { status: "removed", atMs: event.atMs });
				break;
			}
		}
	}
	const done: TimelineEntry[] = [];
	const open: TimelineEntry[] = [];
	for (const [text, state] of tasks) {
		if (state.status === "done") done.push({ text, atMs: state.atMs });
		else if (state.status === "open") open.push({ text, atMs: state.atMs, blocked: state.blocked });
	}
	done.sort((a, b) => a.atMs - b.atMs);
	open.sort((a, b) => a.atMs - b.atMs);
	return { done, open };
}

async function subagentHandoff(
	directory: string,
	id: string,
	snapshots: FileSnapshot,
): Promise<{ summary: SummaryCell; handoff: string }> {
	const candidates = [sidecarPath(directory, id, ".md"), sidecarPath(directory, id, ".json")].filter(
		(candidate): candidate is string => candidate !== undefined,
	);
	for (const file of candidates) {
		const metadata = snapshots.metadataByPath.get(file);
		if (!metadata) continue;
		const cached = cachedSidecar(file, metadata);
		if (cached?.handoffChecked) {
			if (cached.handoff !== undefined) return { summary: cached.summary, handoff: cached.handoff };
			if (!cached.empty) return { summary: cached.summary, handoff: "(none)" };
			continue;
		}
		const text = await readTextFile(file);
		if (text === undefined) continue;
		const summary = summaryCellFromText(text);
		if (file.endsWith(".md") && text.trim().length > 0) {
			sidecarCache.set(file, { ...metadata, summary, empty: false, handoffChecked: true, handoff: text });
			return { summary, handoff: text };
		}
		if (file.endsWith(".json")) {
			const handoff = summary.kind === "text" ? summary.text : "(none)";
			sidecarCache.set(file, { ...metadata, summary, empty: text.trim().length === 0, handoffChecked: true, handoff });
			return { summary, handoff };
		}
		sidecarCache.set(file, { ...metadata, summary, empty: true, handoffChecked: true });
	}
	return { summary: { kind: "none" }, handoff: "(none)" };
}

async function buildInventory(ctx: ExtensionContext): Promise<Inventory> {
	const options = localOptionsFor(ctx);
	const localRoot = path.resolve(resolveLocalRoot(options));
	const artifactRoot = artifactRootFor(ctx, options);
	const refs = refsFromRegistry();
	const currentRef = currentRefFor(ctx, refs);
	const currentId = inferCurrentId(ctx, artifactRoot, currentRef);
	const currentKind = inferCurrentKind(ctx, artifactRoot, currentRef);
	const currentStatus: ContextStatus = currentRef?.status ?? "live";
	const currentEntries = ctx.sessionManager.getBranch();
	const currentCompaction = latestCompaction(currentEntries);
	const currentLastEntryTimestamp = currentEntries.reduce<number | undefined>((latest, entry) => {
		const timestamp = parseTimestamp(entry.timestamp);
		return timestamp !== undefined && (latest === undefined || timestamp > latest) ? timestamp : latest;
	}, undefined);
	const currentState: CurrentSessionState = {
		id: currentId,
		kind: currentKind,
		status: currentStatus,
		lastTimestampMs: [currentLastEntryTimestamp, currentRef?.lastActivity].reduce<number | undefined>(
			(latest, value) => (value !== undefined && (latest === undefined || value > latest) ? value : latest),
			undefined,
		),
		latestCompaction: currentCompaction,
		firstUserPrompt: firstUserPrompt(currentEntries),
	};
	const taskRoot = path.resolve(localRoot, "task-log");
	const [transcriptMatches, sidecarMatches, taskMatches] = await Promise.all([
		nativeGlob(artifactRoot, "**/*.jsonl"),
		nativeGlob(artifactRoot, "**/*.{md,json}"),
		nativeGlob(taskRoot, "*.md"),
	]);
	const headers = await headersFor(artifactRoot, transcriptMatches);
	const transcriptSnapshots = snapshotsFromMatches(artifactRoot, transcriptMatches);
	const sidecars = snapshotsFromMatches(artifactRoot, sidecarMatches);
	const taskLogs = snapshotsFromMatches(taskRoot, taskMatches);
	const activeFiles = new Set(transcriptSnapshots.metadataByPath.keys());
	pruneTranscriptCache(activeFiles);
	const sources = new Map<string, ContextSource>();
	if (artifactRoot) {
		for (const match of transcriptMatches) {
			const relativePath = normalizedRelativePath(match.path);
			const header = headers.get(relativePath) ?? {};
			const source = sourceFromTranscript(artifactRoot, match, header);
			if (!source) continue;
			const previous = transcriptCache.get(source.file);
			const cached = previous && sameMetadata(previous, source.metadata) ? previous : undefined;
			if (!cached) {
				transcriptCache.set(source.file, {
					...source.metadata,
					header,
					data: { summary: { kind: "none" }, handoff: "(none)" },
				});
			} else if (cached.header.sessionId !== header.sessionId || cached.header.timestampMs !== header.timestampMs) {
				transcriptCache.set(source.file, { ...cached, header });
			}
			mergeSource(sources, source.id, source);
		}
	}
	for (const ref of refs) {
		if (ref.id === currentId) continue;
		const file = refSessionFile(ref);
		if (file && artifactRoot && !isWithin(file, artifactRoot)) continue;
		if (!file && !artifactRoot) continue;
		const relativePath = file && artifactRoot && isWithin(file, artifactRoot) ? normalizedRelativePath(path.relative(artifactRoot, file)) : undefined;
		mergeSource(sources, ref.id, {
			id: ref.id,
			file: file && artifactRoot && isWithin(file, artifactRoot) ? file : undefined,
			relativePath,
			header: sources.get(ref.id)?.header ?? {},
			ref,
			directoryParentId: relativePath ? parentDirectoryId(relativePath) : undefined,
		});
	}
	const tree = makeDrafts(currentState, sources);
	return {
		localRoot,
		artifactRoot,
		current: currentState,
		currentCompactionHandoff: currentCompaction ? compactionHandoff(currentCompaction) : "(none)",
		sidecars,
		taskLogs,
		root: tree.root,
		byId: tree.byId,
	};
}

function sidecarNeeds(
	nodes: readonly ContextDraft[],
	inventory: Inventory,
): { files: readonly string[]; extensions: readonly ("md" | "json")[] } {
	const files = new Set<string>();
	const extensions = new Set<"md" | "json">();
	for (const node of nodes) {
		if (node.id === inventory.current.id) continue;
		for (const file of sidecarCandidates(node, inventory.artifactRoot, inventory.localRoot)) {
			const metadata = inventory.sidecars.metadataByPath.get(file);
			if (!metadata) continue;
			const cached = cachedSidecar(file, metadata);
			if (cached) continue;
			files.add(file);
			extensions.add(file.endsWith(".json") ? "json" : "md");
		}
	}
	return { files: [...files], extensions: [...extensions] };
}

function currentNodeData(inventory: Inventory): NodeData {
	const summary: SummaryCell = inventory.current.latestCompaction
		? compactionSummary(inventory.current.latestCompaction)
		: inventory.current.firstUserPrompt
			? { kind: "text", text: truncate(inventory.current.firstUserPrompt) }
			: { kind: "none" };
	return { summary, handoff: "(none)" };
}

function materialize(node: ContextDraft, data: ReadonlyMap<string, NodeData>): ContextNode {
	const nodeData = data.get(node.id) ?? { summary: { kind: "none" } as SummaryCell, handoff: "(none)" };
	return {
		id: node.id,
		kind: node.kind,
		status: node.status,
		parentId: node.parentId,
		spawnedAtMs: node.spawnedAtMs,
		spawnHeaderId: node.spawnHeaderId,
		lastActivityMs: node.lastActivityMs,
		summary: nodeData.summary,
		tasks: nodeData.tasks,
		handoff: nodeData.handoff,
		timeline: nodeData.timeline,
		file: node.file,
		flavor: node.flavor,
		children: node.children.map(child => materialize(child, data)),
	};
}

function flattenDraft(root: ContextDraft): Array<{ node: ContextDraft; depth: number }> {
	const result: Array<{ node: ContextDraft; depth: number }> = [];
	const visit = (node: ContextDraft, depth: number): void => {
		result.push({ node, depth });
		for (const child of node.children) visit(child, depth + 1);
	};
	visit(root, 0);
	return result;
}

function flattenNode(root: ContextNode): Array<{ node: ContextNode; depth: number }> {
	const result: Array<{ node: ContextNode; depth: number }> = [];
	const visit = (node: ContextNode, depth: number): void => {
		result.push({ node, depth });
		for (const child of node.children) visit(child, depth + 1);
	};
	visit(root, 0);
	return result;
}

function findDraft(root: ContextDraft, requestedId: string): ContextDraft | undefined {
	const flattened = flattenDraft(root);
	return flattened.find(entry => entry.node.id === requestedId)?.node ?? flattened.find(entry => entry.node.id.toLowerCase() === requestedId.toLowerCase())?.node;
}

function parentChain(root: ContextNode, requestedId: string): readonly string[] {
	const chain: string[] = [];
	const byId = new Map(flattenNode(root).map(entry => [entry.node.id, entry.node]));
	const target = byId.get(requestedId) ?? [...byId.values()].find(node => node.id.toLowerCase() === requestedId.toLowerCase());
	let current = target;
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		chain.unshift(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return chain;
}

function relativeLast(timestampMs: number | undefined): string | undefined {
	if (timestampMs === undefined || !Number.isFinite(timestampMs)) return undefined;
	const date = new Date(timestampMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderNodeLine(node: ContextNode, depth: number, collapsedCount?: number): string {
	const fields = [`**${node.id}**`, `${node.flavor ?? node.kind}/${node.status}`];
	if (node.tasks) fields.push(`${node.tasks.done}/${node.tasks.total}`);
	const last = relativeLast(node.lastActivityMs);
	if (last) fields.push(last);
	if (node.summary.kind === "text") fields.push(node.summary.text);
	const line = `${"  ".repeat(depth)}- ${fields.join(" · ")}`;
	return collapsedCount === undefined ? line : `${line} · +${collapsedCount} — ctx list ${node.id}`;
}

type FlavorClass = "main" | "task" | "other";

function classifyContext(node: ContextDraft): FlavorClass {
	if (node.kind === "main") return "main";
	if (node.id.endsWith(".thinking-translator-trace")) return "other";
	const flavor = node.flavor;
	if (flavor === "task" || (flavor?.startsWith("task:") ?? false)) return "task";
	return "other";
}

function cloneDraft(node: ContextDraft, children: ContextDraft[]): ContextDraft {
	return {
		id: node.id,
		kind: node.kind,
		status: node.status,
		parentId: node.parentId,
		spawnedAtMs: node.spawnedAtMs,
		spawnHeaderId: node.spawnHeaderId,
		lastActivityMs: node.lastActivityMs,
		file: node.file,
		flavor: node.flavor,
		children,
	};
}

function cloneSubtree(node: ContextDraft): ContextDraft {
	return cloneDraft(node, node.children.map(cloneSubtree));
}

function pruneChildren(
	node: ContextDraft,
	isVisible: (candidate: ContextDraft) => boolean,
): { children: ContextDraft[]; hidden: number } {
	const out: ContextDraft[] = [];
	let hidden = 0;
	for (const child of node.children) {
		const sub = pruneChildren(child, isVisible);
		if (isVisible(child)) {
			out.push(cloneDraft(child, sub.children));
			hidden += sub.hidden;
		} else {
			hidden += 1 + sub.hidden;
			out.push(...sub.children);
		}
	}
	return { children: out, hidden };
}

function descendantCount<T extends { readonly children: readonly T[] }>(node: T): number {
	let count = node.children.length;
	for (const child of node.children) count += descendantCount(child);
	return count;
}

function planRender(root: ContextDraft, threshold: number): { rendered: ContextDraft[]; collapsed: Set<string> } {
	const rendered: ContextDraft[] = [];
	const collapsed = new Set<string>();
	const visit = (node: ContextDraft, isRoot: boolean): void => {
		rendered.push(node);
		if (!isRoot && node.children.length > 0 && descendantCount(node) > threshold) {
			collapsed.add(node.id);
			return;
		}
		for (const child of node.children) visit(child, false);
	};
	visit(root, true);
	return { rendered, collapsed };
}

function renderList(
	root: ContextNode,
	options: { collapsed: ReadonlySet<string>; hiddenCount: number; viewRootId: string; isSubtree: boolean },
): string {
	const lines = [options.isSubtree ? `# Contexts · subtree ${options.viewRootId}` : "# Contexts", ""];
	const visit = (node: ContextNode, depth: number): void => {
		const collapsed = options.collapsed.has(node.id);
		lines.push(renderNodeLine(node, depth, collapsed ? descendantCount(node) : undefined));
		if (collapsed) return;
		for (const child of node.children) visit(child, depth + 1);
	};
	visit(root, 0);
	if (options.hiddenCount > 0) {
		lines.push("", `_Hidden ${options.hiddenCount} internal context(s) (mentor/discuss/trace). \`ctx list all=true\` to include them._`);
	}
	if (options.isSubtree) {
		lines.push("", "_\`ctx list\` for the whole tree._");
	}
	return lines.join("\n");
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function formatTimelineTime(atMs: number): string {
	if (!Number.isFinite(atMs) || atMs === 0) return "—";
	const date = new Date(atMs);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function renderTimeline(timeline: TaskTimeline | undefined): string {
	if (!timeline || (timeline.done.length === 0 && timeline.open.length === 0)) return "(none)";
	const lines: string[] = [];
	lines.push(`### Completed (${timeline.done.length})`);
	if (timeline.done.length === 0) lines.push("- (none)");
	else for (const entry of timeline.done) lines.push(`- ${formatTimelineTime(entry.atMs)} · ${entry.text}`);
	lines.push("");
	lines.push(`### Open (${timeline.open.length})`);
	if (timeline.open.length === 0) lines.push("- (none)");
	else for (const entry of timeline.open) {
		const blocked = entry.blocked ? ` · blocked: ${entry.blocked}` : "";
		lines.push(`- ${formatTimelineTime(entry.atMs)} · ${entry.text}${blocked}`);
	}
	return lines.join("\n");
}

function renderShow(node: ContextNode, breadcrumb: readonly string[]): string {
	return [
		`# Context ${node.id}`,
		"",
		`Breadcrumb: ${breadcrumb.join(" > ") || node.id}`,
		"",
		"## Handoff",
		"",
		node.handoff,
		"",
		"## Tasks",
		"",
		renderTimeline(node.timeline),
		"",
		`Transcript: history://${node.id}`,
	].join("\n");
}

async function hydrateData(inventory: Inventory, nodes: readonly ContextDraft[]): Promise<Map<string, NodeData>> {
	const data = new Map<string, NodeData>();
	data.set(inventory.current.id, currentNodeData(inventory));
	const needs = sidecarNeeds(nodes, inventory);
	const sidecarMatches = await sidecarSummaryMatches(inventory.artifactRoot, needs.extensions);
	for (const node of nodes) {
		const summary =
			node.id === inventory.current.id
				? data.get(node.id)!.summary
				: await sidecarSummaryFor(sidecarCandidates(node, inventory.artifactRoot, inventory.localRoot), inventory.sidecars, sidecarMatches);
		const taskLog = await taskLogFor(inventory.localRoot, node.id, inventory.taskLogs);
		const value: NodeData = {
			summary,
			handoff: "(none)",
			tasks: taskLog.counts,
			timeline: taskLog.timeline,
		};
		data.set(node.id, value);
		if (node.file) {
			const cached = transcriptCache.get(node.file);
			if (cached) transcriptCache.set(node.file, { ...cached, data: value });
		}
	}
	return data;
}

async function hydrateShow(inventory: Inventory, target: ContextDraft): Promise<ContextNode> {
	const data = new Map<string, NodeData>();
	data.set(inventory.current.id, currentNodeData(inventory));
	const taskLog = await taskLogFor(inventory.localRoot, target.id, inventory.taskLogs);
	if (target.id === inventory.current.id) {
		data.set(target.id, {
			summary: data.get(target.id)!.summary,
			handoff: inventory.currentCompactionHandoff,
			tasks: taskLog.counts,
			timeline: taskLog.timeline,
		});
	} else {
		const directory = target.file ? path.dirname(target.file) : inventory.artifactRoot ?? inventory.localRoot;
		const handoff = await subagentHandoff(directory, target.id, inventory.sidecars);
		data.set(target.id, {
			summary: handoff.summary,
			handoff: handoff.handoff,
			tasks: taskLog.counts,
			timeline: taskLog.timeline,
		});
		if (target.file) {
			const cached = transcriptCache.get(target.file);
			if (cached) transcriptCache.set(target.file, { ...cached, data: data.get(target.id)! });
		}
	}
	return materialize(inventory.root, data);
}

/**
 * `ctx list` rendering as a plain string, for callers that need the
 * same text the tool produces but from outside the tool call path
 * (e.g. ctx-post-compact-hint injecting the tree right after a
 * compaction boundary). Keeps the tool as the single source of truth
 * for how the list is built and rendered.
 *
 * Default view hides internal contexts (mentor/discuss/trace),
 * showing the current session and its `task` subagents; `all` includes
 * everything. `id` expands the subtree rooted at that context. Returns
 * `undefined` only when `id` is given but not found, so the caller can
 * error with the set of known ids.
 */
export async function renderCtxListText(
	ctx: ExtensionContext,
	options: { id?: string; all?: boolean } = {},
): Promise<{ text: string; total: number; shown: number; hidden: number } | undefined> {
	const inventory = await buildInventory(ctx);
	const total = inventory.byId.size;
	const viewRootDraft = options.id ? findDraft(inventory.root, options.id) : inventory.root;
	if (options.id && !viewRootDraft) return undefined;
	const root = viewRootDraft ?? inventory.root;
	let filteredRoot: ContextDraft;
	let hiddenCount: number;
	if (options.all) {
		filteredRoot = cloneSubtree(root);
		hiddenCount = 0;
	} else {
		const pruned = pruneChildren(root, node => classifyContext(node) !== "other");
		filteredRoot = cloneDraft(root, pruned.children);
		hiddenCount = pruned.hidden;
	}
	const { rendered, collapsed } = planRender(filteredRoot, COLLAPSE_THRESHOLD);
	const data = await hydrateData(inventory, rendered);
	const materializedRoot = materialize(filteredRoot, data);
	const text = renderList(materializedRoot, {
		collapsed,
		hiddenCount,
		viewRootId: root.id,
		isSubtree: !!options.id,
	});
	return { text, total, shown: rendered.length, hidden: hiddenCount };
}

/**
 * `ctx show <id>` rendering as a plain string. Same output shape and
 * source of truth as the tool call. `id` defaults to the current
 * session so post-compaction injections can attach the main session's
 * per-task timeline without a follow-up tool call. Returns `undefined`
 * when the id is not in the inventory.
 */
export async function renderCtxShowText(
	ctx: ExtensionContext,
	id?: string,
): Promise<{ text: string; id: string } | undefined> {
	const inventory = await buildInventory(ctx);
	const requestedId = id?.trim() || inventory.current.id;
	const target = findDraft(inventory.root, requestedId);
	if (!target) return undefined;
	const root = await hydrateShow(inventory, target);
	const shownNode = flattenNode(root).find(entry => entry.node.id === target.id)!.node;
	return { text: renderShow(shownNode, parentChain(root, target.id)), id: target.id };
}

export default function ctxTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ctx",
		label: "Context Directory",
		description:
			"Composed, read-only recall view of what prior contexts (this session and its subagents) did — never mutates a session or file. A different axis from `read history://<id>`, which returns the raw transcript verbatim: `ctx` stitches the current session, its subagent registry, transcripts, compaction sidecar summaries, and per-agent task logs into a shallow tree of status, handoff, and task counts.\n" +
			"- `ctx list`: the current session and its `task` subagents as a shallow tree with status, one-line handoff, and todo progress (done / total / blocked); internal contexts (mentor/discuss/trace) are hidden by default. `ctx list all=true` includes them; `ctx list <id>` expands the subtree rooted at that context (large subtrees collapse with a `ctx list <id>` expand marker). Answer most \"what did we already do?\" questions here before opening any transcript.\n" +
			"- `ctx show <id>`: one context's full handoff + task log — every `goal`/`todo` op with local timestamp and outcome, plus the compaction sidecar summary. `<id>` is what `ctx list` prints, and what `agent://<id>` and `history://<id>` accept.\n" +
			"- `read history://<id>` is the fallback, not the default: reach for the raw transcript only when `ctx show` is insufficient — exact wording, the concrete tool arguments issued, an elided message, or raw error text the task log did not capture. Transcripts are large and unindexed; opening one when `ctx` already answers is wasted effort.\n" +
			"- Scope: this session and its descendants only. Sibling or unrelated sessions never surface here; if you already hold their id, address them directly via `history://<id>` or `agent://<id>`.\n" +
			"- `todo` and `goal` ops feed the task log `ctx show` reads; update those markers the moment state changes so this recall view stays worth consulting.",
		parameters: contextParams,
		approval: "read",
		loadMode: "essential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
			if (params.op === "list") {
				const result = await renderCtxListText(ctx, { id: params.id, all: params.all });
				if (!result) {
					const inventory = await buildInventory(ctx);
					const knownIds = [...inventory.byId.keys()].join(", ") || "(none)";
					throw new Error(`Unknown context \"${params.id}\". Known ids: ${knownIds}`);
				}
				return {
					content: [{ type: "text", text: result.text }],
					details: { op: params.op, count: result.total, shown: result.shown, hidden: result.hidden, subtree: params.id } satisfies CtxToolDetails,
				};
			}
			const requestedId = params.id?.trim();
			if (!requestedId) throw new Error("ctx show requires an id");
			const result = await renderCtxShowText(ctx, requestedId);
			if (!result) {
				const inventory = await buildInventory(ctx);
				const knownIds = [...inventory.byId.keys()].join(", ") || "(none)";
				throw new Error(`Unknown context \"${requestedId}\". Known ids: ${knownIds}`);
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: { op: params.op, count: 1 } satisfies CtxToolDetails,
			};
		},
	});
}
