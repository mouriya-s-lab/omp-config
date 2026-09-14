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

const MAX_CONTEXT_ROWS = 50;
const SUMMARY_LIMIT = 120;
const SUMMARY_PREFIX_BYTES = 8 * 1024;
const SUMMARY_GREP_COLUMNS = 400;
const SUMMARY_KEYS = ["summary", "report", "report_path", "review", "verdict", "assessment", "advice", "status", "findings"] as const;
const STRUCTURED_SUMMARY_KEYS = ["implementation", "result", "outcome", "conclusion", "notes"] as const;
const SUMMARY_SCAN_LIMIT = 64;
const SIDECAR_SUMMARY_PATTERN = '"(?:summary|report|report_path|review|verdict|assessment|advice|status|findings)"\\s*:';

const contextParams = z.object({
	op: z.enum(["list", "show"]),
	id: z.string().optional(),
});

type ContextParams = z.infer<typeof contextParams>;
type CtxToolDetails = {
	op: ContextParams["op"];
	count: number;
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
};

type TaskCounts = {
	done: number;
	total: number;
};

type TaskLogEvent =
	| { tool: "todo"; op: "init" | "start" | "done" | "drop" | "block" | "unblock" | "append" | "rm" | "view"; detail: string }
	| { tool: "goal"; op: "create" | "get" | "resume" | "complete" | "drop"; detail: string };

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
	readonly taskLog?: string;
	readonly tasks?: TaskCounts;
};

type ContextNode = {
	readonly id: string;
	readonly kind: ContextKind;
	readonly status: ContextStatus;
	readonly parentId?: string;
	readonly spawnedAtMs?: number;
	readonly spawnHeaderId?: string;
	readonly lastActivityMs?: number;
	readonly summary: SummaryCell;
	readonly tasks?: TaskCounts;
	readonly handoff: string;
	readonly taskLog?: string;
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
	readonly text: string;
	readonly counts: TaskCounts;
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
		const result = await grep({
			pattern: SESSION_HEADER_PATTERN,
			path: root,
			glob: "*.jsonl",
			mode: GrepOutputMode.Content,
			maxCountPerFile: 1,
			gitignore: false,
			hidden: true,
		});
		const headers = new Map<string, SpawnHeader>();
		for (const match of result.matches) {
			const relativePath = normalizedRelativePath(match.path);
			if (path.posix.basename(relativePath).startsWith("__advisor")) continue;
			headers.set(relativePath, parseSessionHeader(match.line));
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
	const summary = prefix === undefined ? { kind: "none" } : summaryCellFromText(prefix);
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
): Promise<{ text: string | undefined; counts: TaskCounts | undefined }> {
	const file = taskLogPath(localRoot, id);
	const metadata = snapshots.metadataByPath.get(file);
	if (!metadata) return { text: undefined, counts: undefined };
	const cached = taskLogCache.get(file);
	if (cached && sameMetadata(cached, metadata)) return { text: cached.text, counts: cached.counts };
	const text = await readTextFile(file);
	if (text === undefined) return { text: undefined, counts: undefined };
	const counts = taskLogCounts(text);
	taskLogCache.set(file, { ...metadata, text, counts });
	return { text, counts };
}

function parseTaskLogEvent(line: string): TaskLogEvent | undefined {
	const match = /^-\s+\S+\s+\S+\s+(todo|goal)\s+([a-z]+):\s*(.*)$/i.exec(line.trim());
	if (!match) return undefined;
	const tool = match[1]?.toLowerCase();
	const op = match[2]?.toLowerCase();
	const detail = match[3] ?? "";
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
			return { tool, op, detail };
		}
		return undefined;
	}
	if (tool === "goal" && (op === "create" || op === "get" || op === "resume" || op === "complete" || op === "drop")) {
		return { tool, op, detail };
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
		taskLog: nodeData.taskLog,
		file: node.file,
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

function renderNodeLine(node: ContextNode, depth: number): string {
	const fields = [`**${node.id}**`, `${node.kind}/${node.status}`];
	if (node.tasks) fields.push(`${node.tasks.done}/${node.tasks.total}`);
	const last = relativeLast(node.lastActivityMs);
	if (last) fields.push(last);
	if (node.summary.kind === "text") fields.push(node.summary.text);
	return `${"  ".repeat(depth)}- ${fields.join(" · ")}`;
}

function renderList(root: ContextNode, total: number): string {
	const visible = flattenNode(root).slice(0, MAX_CONTEXT_ROWS);
	const lines = ["# Contexts", ""];
	for (const { node, depth } of visible) lines.push(renderNodeLine(node, depth));
	if (total > MAX_CONTEXT_ROWS) lines.push("", `_Note: showing ${MAX_CONTEXT_ROWS} of ${total} contexts._`);
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
		"## Task log",
		"",
		node.taskLog ?? "(none)",
		"",
		`Transcript: history://${node.id}`,
	].join("\n");
}

async function hydrateList(inventory: Inventory, visibleDrafts: readonly ContextDraft[]): Promise<ContextNode> {
	const data = new Map<string, NodeData>();
	data.set(inventory.current.id, currentNodeData(inventory));
	const needs = sidecarNeeds(visibleDrafts, inventory);
	const sidecarMatches = await sidecarSummaryMatches(inventory.artifactRoot, needs.extensions);
	for (const node of visibleDrafts) {
		const summary =
			node.id === inventory.current.id
				? data.get(node.id)!.summary
				: await sidecarSummaryFor(sidecarCandidates(node, inventory.artifactRoot, inventory.localRoot), inventory.sidecars, sidecarMatches);
		const taskLog = await taskLogFor(inventory.localRoot, node.id, inventory.taskLogs);
		const value: NodeData = {
			summary,
			handoff: "(none)",
			taskLog: taskLog.text,
			tasks: taskLog.counts,
		};
		data.set(node.id, value);
		if (node.file) {
			const cached = transcriptCache.get(node.file);
			if (cached) transcriptCache.set(node.file, { ...cached, data: value });
		}
	}
	return materialize(inventory.root, data);
}

async function hydrateShow(inventory: Inventory, target: ContextDraft): Promise<ContextNode> {
	const data = new Map<string, NodeData>();
	data.set(inventory.current.id, currentNodeData(inventory));
	const taskLog = await taskLogFor(inventory.localRoot, target.id, inventory.taskLogs);
	if (target.id === inventory.current.id) {
		data.set(target.id, {
			summary: data.get(target.id)!.summary,
			handoff: inventory.currentCompactionHandoff,
			taskLog: taskLog.text,
			tasks: taskLog.counts,
		});
	} else {
		const directory = target.file ? path.dirname(target.file) : inventory.artifactRoot ?? inventory.localRoot;
		const handoff = await subagentHandoff(directory, target.id, inventory.sidecars);
		data.set(target.id, {
			summary: handoff.summary,
			handoff: handoff.handoff,
			taskLog: taskLog.text,
			tasks: taskLog.counts,
		});
		if (target.file) {
			const cached = transcriptCache.get(target.file);
			if (cached) transcriptCache.set(target.file, { ...cached, data: data.get(target.id)! });
		}
	}
	return materialize(inventory.root, data);
}

export default function ctxTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ctx",
		label: "Context Directory",
		description:
			"Use `ctx list` to recall what prior contexts (this session and its subagents) did before opening transcripts; use `ctx show <id>` for one context's handoff + task log.",
		parameters: contextParams,
		approval: "read",
		loadMode: "essential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
			const inventory = await buildInventory(ctx);
			const total = inventory.byId.size;
			if (params.op === "list") {
				const visibleDrafts = flattenDraft(inventory.root).slice(0, MAX_CONTEXT_ROWS).map(entry => entry.node);
				const root = await hydrateList(inventory, visibleDrafts);
				return { content: [{ type: "text", text: renderList(root, total) }], details: { op: params.op, count: total } satisfies CtxToolDetails };
			}
			const requestedId = params.id?.trim();
			if (!requestedId) throw new Error("ctx show requires an id");
			const target = findDraft(inventory.root, requestedId);
			if (!target) {
				const knownIds = [...inventory.byId.keys()].join(", ") || "(none)";
				throw new Error(`Unknown context \"${requestedId}\". Known ids: ${knownIds}`);
			}
			const root = await hydrateShow(inventory, target);
			const shownNode = flattenNode(root).find(entry => entry.node.id === target.id)!.node;
			return {
				content: [{ type: "text", text: renderShow(shownNode, parentChain(root, target.id)) }],
				details: { op: params.op, count: 1 } satisfies CtxToolDetails,
			};
		},
	});
}
