import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
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
const MAX_SCAN_DEPTH = 8;

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

type TranscriptFile = {
	id: string;
	file: string;
	parentId?: string;
};

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

type CurrentSessionState = {
	id: string;
	kind: ContextKind;
	status: ContextStatus;
	parentId?: string;
	lastTimestampMs?: number;
	latestCompaction?: CompactionEntry;
	firstUserPrompt?: string;
};

type TaskCounts = {
	done: number;
	total: number;
};

type TaskLogEvent =
	| { tool: "todo"; op: "init" | "start" | "done" | "drop" | "block" | "unblock" | "append" | "rm" | "view"; detail: string }
	| { tool: "goal"; op: "create" | "get" | "resume" | "complete" | "drop"; detail: string };

type ContextRecord = {
	id: string;
	kind: ContextKind;
	status: ContextStatus;
	parentId?: string;
	lastTimestampMs?: number;
	summary: string;
	handoff: string;
	taskLog: string | undefined;
	tasks: TaskCounts | undefined;
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const timestamp = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseJsonObject(line: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function textField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function firstMeaningfulLines(value: string): string {
	const lines = value
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	return lines.slice(0, 2).join(" — ");
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit = SUMMARY_LIMIT): string {
	const normalized = oneLine(value);
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
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

function parentIdFromTranscript(file: string, root: string): string | undefined {
	const directory = path.dirname(file);
	if (path.resolve(directory) === path.resolve(root)) return undefined;
	const parent = path.basename(directory);
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
	if (sessionFile && root && isWithin(sessionFile, root)) {
		return safeAgentIdFromFile(sessionFile) ?? MAIN_AGENT_ID;
	}
	return MAIN_AGENT_ID;
}

function inferCurrentKind(ctx: ExtensionContext, root: string | undefined, ref: AgentRef | undefined): ContextKind {
	if (ref) return ref.kind === "main" ? "main" : "sub";
	const sessionFile = asPath(ctx.sessionManager.getSessionFile());
	return sessionFile && root && isWithin(sessionFile, root) ? "sub" : "main";
}

function inferCurrentParent(ctx: ExtensionContext, root: string | undefined, ref: AgentRef | undefined): string | undefined {
	if (ref?.parentId) return ref.parentId;
	const sessionFile = asPath(ctx.sessionManager.getSessionFile());
	return sessionFile && root ? parentIdFromTranscript(sessionFile, root) : undefined;
}

async function scanTranscriptFiles(root: string | undefined): Promise<TranscriptFile[]> {
	if (!root) return [];
	const found: TranscriptFile[] = [];
	const seenDirectories = new Set<string>();
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > MAX_SCAN_DEPTH) return;
		const resolvedDirectory = path.resolve(directory);
		if (seenDirectories.has(resolvedDirectory)) return;
		seenDirectories.add(resolvedDirectory);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(resolvedDirectory, { withFileTypes: true });
		} catch (error) {
			if (isMissingFile(error)) return;
			throw error;
		}
		for (const entry of entries) {
			const entryPath = path.join(resolvedDirectory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath, depth + 1);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("__advisor")) continue;
			const id = safeAgentIdFromFile(entryPath);
			if (!id) continue;
			found.push({ id, file: entryPath, parentId: parentIdFromTranscript(entryPath, resolvedDirectoryRoot) });
		}
	};
	const resolvedDirectoryRoot = path.resolve(root);
	await visit(resolvedDirectoryRoot, 0);
	return found;
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function readTextFile(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		return undefined;
	}
}

async function readFileMtime(file: string): Promise<number | undefined> {
	try {
		const stat = await fs.stat(file);
		return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		return undefined;
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

function compactionSummary(entry: CompactionEntry): string {
	const shortSummary = textField(entry.shortSummary);
	const summary = textField(entry.summary);
	const preferred = shortSummary ?? summary;
	if (isRemoteCompactionPlaceholder(shortSummary) || isRemoteCompactionPlaceholder(summary)) {
		const suffix = compactionCountsSuffix(entry);
		if (suffix) return truncate(`${preferred ?? "Remote compaction"}${suffix}`);
	}
	return truncate(preferred ?? "(none)");
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

async function subagentHandoff(directory: string, id: string, includeHandoff: boolean): Promise<{ summary: string; handoff: string }> {
	const markdownPath = sidecarPath(directory, id, ".md");
	const markdown = markdownPath ? await readTextFile(markdownPath) : undefined;
	if (markdown !== undefined && markdown.trim().length > 0) {
		const firstLines = firstMeaningfulLines(markdown);
		return { summary: truncate(firstLines), handoff: includeHandoff ? markdown : "" };
	}

	const jsonPath = sidecarPath(directory, id, ".json");
	const jsonText = jsonPath ? await readTextFile(jsonPath) : undefined;
	if (jsonText !== undefined) {
		const parsed = parseJsonObject(jsonText);
		const summary = parsed ? textField(parsed.summary) ?? textField(parsed.report) : undefined;
		if (summary) return { summary: truncate(firstMeaningfulLines(summary)), handoff: includeHandoff ? summary : "" };
	}
	return { summary: "—", handoff: "(none)" };
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
	return normalized === "all tasks" || normalized === "\"all tasks\"";
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

async function taskLogFor(localRoot: string, id: string): Promise<{ text: string | undefined; counts: TaskCounts | undefined }> {
	const taskLogDir = path.resolve(localRoot, "task-log");
	const file = path.resolve(taskLogDir, `${id}.md`);
	if (!isWithin(file, taskLogDir)) return { text: undefined, counts: undefined };
	const text = await readTextFile(file);
	return text === undefined ? { text: undefined, counts: undefined } : { text, counts: taskLogCounts(text) };
}

function relativeLast(timestampMs: number | undefined): string {
	if (timestampMs === undefined || !Number.isFinite(timestampMs)) return "—";
	const date = new Date(timestampMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} local`;
}

function escapeTableCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
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

async function buildRecords(ctx: ExtensionContext, includeHandoff: boolean): Promise<ContextRecord[]> {
	const options = localOptionsFor(ctx);
	const localRoot = path.resolve(resolveLocalRoot(options));
	const artifactRoot = artifactRootFor(ctx, options);
	const refs = refsFromRegistry();
	const currentRef = currentRefFor(ctx, refs);
	const currentId = inferCurrentId(ctx, artifactRoot, currentRef);
	const currentKind = inferCurrentKind(ctx, artifactRoot, currentRef);
	const currentParentId = inferCurrentParent(ctx, artifactRoot, currentRef);
	const currentStatus: ContextStatus = currentRef?.status ?? "live";
	const currentEntries = ctx.sessionManager.getBranch();
	const currentCompaction = latestCompaction(currentEntries);
	const currentLastEntryTimestamp = currentEntries.reduce<number | undefined>((latest, entry) => {
		const timestamp = parseTimestamp(entry.timestamp);
		return timestamp !== undefined && (latest === undefined || timestamp > latest) ? timestamp : latest;
	}, undefined);
	const currentSessionFile = asPath(ctx.sessionManager.getSessionFile());
	const currentFileMtime = currentSessionFile ? await readFileMtime(currentSessionFile) : undefined;
	const currentLastTimestampMs = [currentLastEntryTimestamp, currentFileMtime, currentRef?.lastActivity].reduce<number | undefined>(
		(latest, value) => (value !== undefined && (latest === undefined || value > latest) ? value : latest),
		undefined,
	);
	const currentState: CurrentSessionState = {
		id: currentId,
		kind: currentKind,
		status: currentStatus,
		parentId: currentParentId,
		lastTimestampMs: currentLastTimestampMs,
		latestCompaction: currentCompaction,
		firstUserPrompt: firstUserPrompt(currentEntries),
	};

	const transcriptFiles = await scanTranscriptFiles(artifactRoot);
	const byId = new Map<string, TranscriptFile>();
	for (const file of transcriptFiles) byId.set(file.id, file);
	if (currentSessionFile && artifactRoot && isWithin(currentSessionFile, artifactRoot)) {
		const currentFileId = safeAgentIdFromFile(currentSessionFile);
		if (currentFileId && !byId.has(currentFileId)) {
			byId.set(currentFileId, {
				id: currentFileId,
				file: currentSessionFile,
				parentId: parentIdFromTranscript(currentSessionFile, artifactRoot),
			});
		}
	}

	const descriptors = new Map<string, { file?: string; parentId?: string; ref?: AgentRef }>();
	const addDescriptor = (id: string, descriptor: { file?: string; parentId?: string; ref?: AgentRef }): void => {
		const previous = descriptors.get(id);
		descriptors.set(id, {
			file: descriptor.file ?? previous?.file,
			parentId: descriptor.parentId ?? previous?.parentId,
			ref: descriptor.ref ?? previous?.ref,
		});
	};
	for (const file of byId.values()) addDescriptor(file.id, { file: file.file, parentId: file.parentId });
	for (const ref of refs) {
		const file = refSessionFile(ref);
		if (ref.id !== currentId && (!file || !artifactRoot || !isWithin(file, artifactRoot))) continue;
		addDescriptor(ref.id, {
			file: file && artifactRoot && isWithin(file, artifactRoot) ? file : undefined,
			parentId: ref.parentId,
			ref,
		});
	}
	addDescriptor(currentId, {
		file: currentSessionFile && artifactRoot && isWithin(currentSessionFile, artifactRoot) ? currentSessionFile : undefined,
		parentId: currentParentId,
		ref: currentRef,
	});

	const records = await Promise.all(
		Array.from(descriptors.entries()).map(async ([id, descriptor]): Promise<ContextRecord> => {
			const descriptorRef = descriptor.ref ?? refs.find(ref => ref.id === id);
			const fallbackKind: ContextKind = id === currentId ? currentKind : "sub";
			const fallbackStatus: ContextStatus = id === currentId ? currentStatus : "on disk";
			const metadata = registryDescriptor(descriptorRef, fallbackKind, fallbackStatus, descriptor.parentId);
			if (id === currentState.id && currentKind === "main") {
				const taskLog = await taskLogFor(localRoot, id);
				const summary = currentCompaction ? compactionSummary(currentCompaction) : truncate(currentState.firstUserPrompt ?? "—");
				return {
					id,
					kind: metadata.kind,
					status: metadata.status,
					parentId: metadata.parentId,
					lastTimestampMs: currentState.lastTimestampMs,
					summary,
					handoff: includeHandoff && currentCompaction ? compactionHandoff(currentCompaction) : "(none)",
					taskLog: taskLog.text,
					tasks: taskLog.counts,
				};
			}

			const transcriptMtime = descriptor.file ? await readFileMtime(descriptor.file) : undefined;
			const outputDirectory = descriptor.file ? path.dirname(descriptor.file) : artifactRoot ?? localRoot;
			const handoff = await subagentHandoff(outputDirectory, id, includeHandoff);
			const taskLog = await taskLogFor(localRoot, id);
			const lastTimestampMs = [transcriptMtime, descriptorRef?.lastActivity].reduce<number | undefined>(
				(latest, value) => (value !== undefined && (latest === undefined || value > latest) ? value : latest),
				undefined,
			);
			return {
				id,
				kind: metadata.kind,
				status: metadata.status,
				parentId: metadata.parentId,
				lastTimestampMs,
				summary: handoff.summary,
				handoff: handoff.handoff,
				taskLog: taskLog.text,
				tasks: taskLog.counts,
			};
		}),
	);
	return records.sort((left, right) => {
		const leftLast = left.lastTimestampMs ?? 0;
		const rightLast = right.lastTimestampMs ?? 0;
		return rightLast - leftLast || left.id.localeCompare(right.id);
	});
}

function renderList(records: readonly ContextRecord[]): string {
	const visible = records.slice(0, MAX_CONTEXT_ROWS);
	const lines = [
		"# Contexts",
		"",
		"| id | kind | status | last | summary | tasks |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const record of visible) {
		const tasks = record.tasks ? `${record.tasks.done}/${record.tasks.total}` : "—";
		lines.push(
			`| ${escapeTableCell(record.id)} | ${record.kind} | ${record.status} | ${relativeLast(record.lastTimestampMs)} | ${escapeTableCell(record.summary)} | ${tasks} |`,
		);
	}
	if (visible.length === 0) lines.push("| (none) | — | — | — | — | — |");
	if (records.length > MAX_CONTEXT_ROWS) {
		lines.push("", `_Note: showing ${MAX_CONTEXT_ROWS} of ${records.length} contexts._`);
	}
	return lines.join("\n");
}

function findRecord(records: readonly ContextRecord[], requestedId: string): ContextRecord | undefined {
	return records.find(record => record.id === requestedId) ?? records.find(record => record.id.toLowerCase() === requestedId.toLowerCase());
}

function renderShow(record: ContextRecord): string {
	return [
		`# Context ${record.id}`,
		"",
		"## Handoff",
		"",
		record.handoff,
		"",
		"## Task log",
		"",
		record.taskLog ?? "(none)",
		"",
		`Transcript: history://${record.id}`,
	].join("\n");
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
			const records = await buildRecords(ctx, params.op === "show");
			if (params.op === "list") {
				return { content: [{ type: "text", text: renderList(records) }], details: { op: params.op, count: records.length } satisfies CtxToolDetails };
			}
			const requestedId = params.id?.trim();
			if (!requestedId) throw new Error("ctx show requires an id");
			const record = findRecord(records, requestedId);
			if (!record) {
				const knownIds = records.map(candidate => candidate.id).join(", ") || "(none)";
				throw new Error(`Unknown context \"${requestedId}\". Known ids: ${knownIds}`);
			}
			return { content: [{ type: "text", text: renderShow(record) }], details: { op: params.op, count: 1 } satisfies CtxToolDetails };
		},
	});
}
