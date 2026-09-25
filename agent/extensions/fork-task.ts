import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type TaskItem,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

// ============================================================================
// fork_task — native `task` subagents that start from a copy of the caller's
// conversation.
//
// The spawn itself is the built-in `task` tool, called with the same batch
// shape, so each child is an ordinary task subagent: its own agent definition
// (system prompt, model binding, tools), Agent Hub row, `agent://`/`history://`,
// idle/park/revive lifecycle, isolation and patch merge. Only the child's
// starting transcript differs:
//
//   1. At call time the caller's persisted conversation is forked into a
//      staging JSONL (inherited cost zeroed, a dangling in-flight tool call
//      paired with a synthetic aborted result, the parent's todo list cleared),
//      followed by a fork notice. `shake: true` then runs the same
//      `session.shake("elide")` that `/shake` runs, writing its recovery
//      artifact into the parent's artifact store — the store the child adopts.
//   2. Parent runtime state is removed so the executor, not the copy, decides
//      the child's contract: `session_init` (a copied init makes the persisted
//      roster treat the file as another live generation and fails the spawn),
//      model / thinking / service-tier changes, and the shake helper's own
//      bookkeeping. Removed entries' children are re-parented.
//   3. The header cwd stays the parent cwd for shared children (revival reopens
//      the file by path and reads its cwd from there); isolated children get a
//      blank cwd so `SessionManager.open` binds them to the worktree.
//   4. `before_subagent_spawn` fires after the task tool pre-allocates the
//      child id (async dispatch) and before the executor opens
//      `<artifactsDir>/<id>.jsonl`; the staging file is moved there so the
//      executor opens the fork instead of an empty session. Each item gets a
//      unique name, so the allocated id is predictable and matched exactly.
//
// Relies on omp internals (AgentRegistry, the executor's session-file path and
// hook ordering, session entry types); re-verify after every omp upgrade.
// ============================================================================

const itemSchema = z.object({
	name: z.string().optional(),
	agent: z.string().optional(),
	task: z.string(),
	isolated: z.boolean().optional(),
	shake: z.boolean().optional(),
	effort: z.enum(["lo", "med", "hi"]).optional(),
	tools: z.array(z.string()).optional(),
	outputSchema: z.unknown().optional(),
	schemaMode: z.enum(["permissive", "strict"]).optional(),
});

const paramsSchema = z.object({
	context: z.string(),
	tasks: z.array(itemSchema).min(1),
});

const progressSchema = z
	.object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) })
	.passthrough();

const sessionHeaderSchema = z
	.object({ type: z.literal("session"), cwd: z.string(), additionalDirectories: z.array(z.string()).optional() })
	.passthrough();

const sessionEntrySchema = z
	.object({
		type: z.string(),
		id: z.string(),
		parentId: z.string().nullable().optional(),
		customType: z.string().optional(),
		firstKeptEntryId: z.string().optional(),
	})
	.passthrough();
type SessionEntryRecord = z.infer<typeof sessionEntrySchema>;

/** Parent runtime state that must not seed the child's own contract. */
const RUNTIME_STATE_TYPES: Record<string, true> = {
	session_init: true,
	model_change: true,
	thinking_level_change: true,
	service_tier_change: true,
};

const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

const DESCRIPTION = `Spawn subagents exactly like \`task\` — same batch shape, agent types, models, lifecycle, result delivery, \`write agent://\` follow-up, \`agent://\`/\`history://\` — except each child starts with a copy of THIS conversation up to this call, followed by its assignment.

Prefer it over \`task\` for complex work: multi-step implementation, debugging, or design follow-through whose assignment depends on what this conversation already established (requirements, decisions, findings, file contents read so far), where restating that in \`context\`/\`task\` would be long or lossy. Use \`task\` when independence matters (clean-room review, second opinion) or the needed background is short.

Recommended per item: keep \`isolated\` at its default \`true\` and pass \`shake: true\`.
- \`isolated\` (default true): the child works in its own workspace and returns a patch; like any isolated task child it is not resumable afterwards. Pass \`isolated: false\` only for research-only children you want to keep messaging after they finish.
- \`shake: true\` runs \`/shake\` (elide mode) on the inherited copy before the child starts, cutting its starting context:
  - Elided: every text tool result regardless of size, and every fenced code block (\`\`\` or ~~~) or top-level lowercase XML element of at least 400 tokens inside user, assistant, or developer messages.
  - Kept: the most recent ~4,000 tokens of the copy (the end of this conversation), \`skill\` results and \`skill://\` reads, reads of the current plan file, prose outside those blocks, thinking, and tool-call arguments. History already summarized by a compaction is not touched.
  - Each elided region becomes a placeholder like \`[shaken ~N tokens — recover: artifact://<id> (region K)]\`; the child can \`read\` that artifact to get the original text back.
  - Omit \`shake\` only when the child needs older raw outputs in front of it verbatim, not behind an artifact read.
- The child runs its own agent's system prompt and model; it sees the conversation as background and its own assignment as the task. It does not inherit this session's todo list.
- Each item's \`name\` gets a short unique suffix; address the child by the id reported in the result.

\`context\` and each item's \`task\` follow the same rules as \`task\`: the conversation copy is background, the assignment must still state the target, change, and acceptance.`;

const forkNotice = (parentCwd: string, isolated: boolean): string =>
	[
		`<system-notice cause="fork_task">`,
		"Above: the conversation of the parent agent that spawned you, copied as background. It ran under its own role, tools, and rules; yours are the ones in your system prompt.",
		"- Use it only for the facts, decisions, and constraints it established.",
		"- Your job is the assignment that follows this notice, nothing else. NEVER continue, resume, or complete other work from the conversation; its todo lists and plans belong to the parent.",
		"- The parent keeps working concurrently.",
		isolated
			? `- You run in an isolated copy of the workspace. Paths under \`${parentCwd}\` in the conversation name the parent's checkout: use the same repository-relative paths inside your own working directory, and NEVER read or write under \`${parentCwd}\`.`
			: "- You share the parent's working directory; files may change between your reads.",
		"</system-notice>",
	].join("\n");

type PendingFork = {
	/** Exact requested name; the allocated id's last dot-segment. */
	readonly name: string;
	readonly artifactsDir: string;
	readonly staging: string;
};

type StagedFork = {
	readonly staging: string;
	readonly shakeSummary?: string;
};

const STAGING_ROOT = path.join(os.tmpdir(), "omp-fork-task");

/** Mirrors the task tool's `sanitizeAgentId`, so the requested name is the allocated id. */
function sanitizeName(value: string | undefined): string | undefined {
	const sanitized = value?.trim().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40);
	return sanitized || undefined;
}

function findCallerSession(ctx: ExtensionContext): AgentSession | undefined {
	const file = ctx.sessionManager.getSessionFile();
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session) continue;
		if (session.sessionManager === ctx.sessionManager) return session;
		if (file && session.sessionManager.getSessionFile() === file) return session;
	}
	return undefined;
}

/**
 * Rewrite the staged JSONL: drop parent runtime state and the shake helper's
 * bookkeeping, re-parent what depended on dropped entries, and set the header
 * cwd the child must bind to.
 */
async function finalizeStaging(
	file: string,
	options: { cwd: string; isolated: boolean; preShakeIds: ReadonlySet<string> },
): Promise<void> {
	const lines = (await fs.readFile(file, "utf8")).split("\n").filter(line => line.length > 0);
	const records = lines.map(line => JSON.parse(line) as unknown);

	const dropped = new Map<string, string | null>();
	const entries: Array<SessionEntryRecord | undefined> = records.map(record => {
		const parsed = sessionEntrySchema.safeParse(record);
		return parsed.success ? parsed.data : undefined;
	});
	for (const entry of entries) {
		if (!entry) continue;
		const addedByShake = !options.preShakeIds.has(entry.id);
		const drop =
			RUNTIME_STATE_TYPES[entry.type] === true ||
			(addedByShake && entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (drop) dropped.set(entry.id, entry.parentId ?? null);
	}
	const survivingParent = (id: string | null): string | null => {
		let current = id;
		while (current !== null && dropped.has(current)) current = dropped.get(current) ?? null;
		return current;
	};
	// `firstKeptEntryId` may name a dropped entry: move it to the next surviving entry.
	const nextSurviving = new Map<string, string>();
	let pendingDropped: string[] = [];
	for (const entry of entries) {
		if (!entry) continue;
		if (dropped.has(entry.id)) {
			pendingDropped.push(entry.id);
			continue;
		}
		for (const id of pendingDropped) nextSurviving.set(id, entry.id);
		pendingDropped = [];
	}

	let headerSeen = false;
	const output: string[] = [];
	for (const [index, record] of records.entries()) {
		const header = headerSeen ? undefined : sessionHeaderSchema.safeParse(record);
		if (header?.success) {
			headerSeen = true;
			const next = { ...header.data, cwd: options.isolated ? "" : options.cwd };
			if (options.isolated) delete next.additionalDirectories;
			output.push(JSON.stringify(next));
			continue;
		}
		const entry = entries[index];
		if (!entry) {
			output.push(lines[index]!);
			continue;
		}
		if (dropped.has(entry.id)) continue;
		const next: SessionEntryRecord = { ...entry };
		if (next.parentId && dropped.has(next.parentId)) next.parentId = survivingParent(next.parentId);
		if (next.firstKeptEntryId && dropped.has(next.firstKeptEntryId)) {
			const replacement = nextSurviving.get(next.firstKeptEntryId);
			if (replacement) next.firstKeptEntryId = replacement;
		}
		output.push(JSON.stringify(next));
	}
	if (!headerSeen) throw new Error(`fork_task: ${file} has no session header`);
	await fs.writeFile(file, `${output.join("\n")}\n`);
}

async function moveFile(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
		await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
		await fs.rm(from, { force: true });
	}
}

async function stageFork(
	ctx: ExtensionContext,
	parent: AgentSession,
	parentFile: string,
	shake: boolean,
	isolated: boolean,
): Promise<StagedFork> {
	const parentCwd = parent.sessionManager.getCwd();
	const stagingDir = path.join(STAGING_ROOT, randomUUID());
	const staging = path.join(stagingDir, "fork.jsonl");
	await fs.mkdir(stagingDir, { recursive: true });
	try {
		const manager = await SessionManager.forkFrom(parentFile, parentCwd, stagingDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: staging,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		let shakeSummary: string | undefined;
		let preShakeIds: ReadonlySet<string>;
		try {
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			manager.appendMessage({
				role: "developer",
				content: forkNotice(parentCwd, isolated),
				attribution: "agent",
				timestamp: Date.now(),
			});
			await manager.flush();
			preShakeIds = new Set(manager.getEntries().map(entry => entry.id));
			if (shake) {
				// Recovery artifacts go to the store the child will adopt, so the
				// `artifact://` ids written into the transcript resolve for it.
				const parentArtifacts = parent.sessionManager.getArtifactManager();
				if (parentArtifacts) manager.adoptArtifactManager(parentArtifacts);
				const { session: shaker } = await createAgentSession({
					cwd: parentCwd,
					sessionManager: manager,
					model: parent.model ?? ctx.model,
					modelRegistry: ctx.modelRegistry,
					toolNames: [],
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					disableExtensionDiscovery: true,
					systemPrompt: [],
					hasUI: false,
					// A main-kind session's dispose tears down the global
					// AgentLifecycleManager; keep the helper out of the shared registry.
					taskDepth: 1,
					agentRegistry: new AgentRegistry(),
					agentId: `fork-shake-${path.basename(stagingDir)}`,
				});
				try {
					const result = await shaker.shake("elide");
					shakeSummary = `shake freed ~${result.tokensFreed} tokens (${result.toolResultsDropped} tool results, ${result.blocksDropped} blocks)`;
				} finally {
					await shaker.dispose();
				}
			}
		} finally {
			await manager.close();
		}
		await finalizeStaging(staging, { cwd: parentCwd, isolated, preShakeIds });
		return { staging, shakeSummary };
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

export default function forkTask(pi: ExtensionAPI): void {
	const pending: PendingFork[] = [];

	const discard = async (entry: PendingFork): Promise<void> => {
		const index = pending.indexOf(entry);
		if (index !== -1) pending.splice(index, 1);
		await fs.rm(path.dirname(entry.staging), { recursive: true, force: true });
	};

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (event.invocationKind !== "task" || !event.spawnKey) return;
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		const spawnKey = event.spawnKey;
		const segment = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
		const entry = pending.find(p => p.artifactsDir === artifactsDir && p.name === segment);
		if (!entry) return;
		const target = path.join(artifactsDir, `${spawnKey}.jsonl`);
		const occupied = await fs.access(target).then(
			() => true,
			() => false,
		);
		if (occupied) {
			await discard(entry);
			return { block: true, reason: `fork_task: ${target} already exists; refusing to overwrite it.` };
		}
		await fs.mkdir(artifactsDir, { recursive: true });
		await moveFile(entry.staging, target);
		await discard(entry);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		for (const entry of pending.filter(p => p.artifactsDir === artifactsDir)) await discard(entry);
	});

	pi.registerTool({
		name: "fork_task",
		label: "Fork Task",
		description: DESCRIPTION,
		loadMode: "essential",
		parameters: paramsSchema,
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
			const params = paramsSchema.parse(rawParams);

			const parent = findCallerSession(ctx);
			if (!parent) return fail("fork_task: could not resolve the calling session in the agent registry.");
			const taskTool = parent.getToolByName("task");
			if (!taskTool) return fail("fork_task: the `task` tool is unavailable in this session (recursion depth or settings).");
			// Only async dispatch pre-allocates the child id before the spawn hook;
			// sync dispatch reports the bare label, which misses nested id prefixes.
			if (!parent.asyncJobManager || parent.settings.get("async.enabled") !== true) {
				return fail("fork_task: requires background jobs (`async.enabled: true`).");
			}
			await parent.sessionManager.ensureOnDisk();
			await parent.sessionManager.flush();
			const parentFile = parent.sessionManager.getSessionFile();
			if (!parentFile) return fail("fork_task: forking needs a persisted session.");
			const artifactsDir = parentFile.slice(0, -".jsonl".length);
			const planMode = parent.getPlanModeState()?.enabled === true;

			const staged: PendingFork[] = [];
			const notes: string[] = [];
			const tasks: TaskItem[] = [];
			try {
				for (const [index, item] of params.tasks.entries()) {
					const name = `${sanitizeName(item.name) ?? "Fork"}_${randomUUID().slice(0, 4)}`;
					const isolated = !planMode && (item.isolated ?? true);
					const { staging, shakeSummary } = await stageFork(ctx, parent, parentFile, item.shake === true, isolated);
					const entry: PendingFork = { name, artifactsDir, staging };
					staged.push(entry);
					pending.push(entry);
					if (shakeSummary) notes.push(`${name}: ${shakeSummary}`);
					tasks[index] = {
						name,
						task: item.task,
						...(item.agent !== undefined ? { agent: item.agent } : {}),
						...(planMode ? {} : { isolated }),
						...(item.effort !== undefined ? { effort: item.effort } : {}),
						...(item.tools !== undefined ? { tools: item.tools } : {}),
						...(item.outputSchema !== undefined ? { outputSchema: item.outputSchema } : {}),
						...(item.schemaMode !== undefined ? { schemaMode: item.schemaMode } : {}),
					};
				}
			} catch (error) {
				for (const entry of staged) await discard(entry);
				return fail(`fork_task: staging the conversation fork failed: ${error instanceof Error ? error.message : String(error)}`);
			}

			const result = await taskTool
				.execute(toolCallId, { context: params.context, tasks }, signal, onUpdate)
				.catch(async (error: unknown) => {
					for (const entry of staged) await discard(entry);
					throw error;
				});

			// Items the task tool never scheduled (validation errors) leave nothing staged.
			const parsed = progressSchema.safeParse(result.details);
			const scheduled = new Set(parsed.success ? parsed.data.progress.map(p => p.index) : []);
			for (const [index, entry] of staged.entries()) {
				if (!scheduled.has(index)) await discard(entry);
			}

			if (notes.length === 0) return result;
			return {
				...result,
				content: [...result.content, { type: "text" as const, text: `\n[fork_task] ${notes.join("; ")}` }],
			};
		},
	});
}
