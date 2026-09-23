import { createHash } from 'node:crypto';
import { type ExtensionAPI, type ExtensionContext, z } from '@oh-my-pi/pi-coding-agent';

/**
 * Worktree reminder for parallel writers, given once per assignment prompt.
 * When a `task` call would leave two or more write-capable agents sharing the
 * session's working directory without isolation, and some undecided item's
 * prompt has not been reminded before, the call is blocked and the reason tells
 * the model to re-dispatch writers with `isolated: true`. The block is the
 * reminder: the same prompt re-dispatched as it was runs untouched, while a new
 * prompt gets its own reminder. Prompts are keyed by a hash of the item's
 * `task` text. The extension never sets `isolated` itself.
 *
 * "Shared" means spawned without `isolated: true`. Only items that leave
 * `isolated` out count as undecided; an explicit `isolated: false` is a
 * deliberate choice (research-only, hub-continuable) and never triggers the
 * block. Earlier shared writers count while their background job is running,
 * found through the caller-owned async job snapshot. Eval `agent()` and
 * `workpool()` spawns are not seen. When the `task` schema has no `isolated`
 * field (isolation disabled, or plan mode) the model cannot follow the
 * reminder, so nothing is blocked.
 */

/**
 * `task:*` workers and user-tagged model agents (`m1`, `m2`, … — the bundled
 * task template) hold write tools; an omitted `agent` resolves to one of them.
 * `discuss:*` and `mentor:*` are read-only by definition.
 */
const isWriter = (agent: string | undefined): boolean =>
    agent === undefined || /^task(?::|$)/.test(agent) || /^m\d+$/.test(agent);

/** One spawn as the model wrote it. */
const taskItemSchema = z
    .object({
        task: z.string(),
        name: z.string().optional(),
        agent: z.string().optional(),
        isolated: z.boolean().optional(),
    })
    .passthrough();
const batchSchema = z.object({ tasks: z.array(taskItemSchema) }).passthrough();
type TaskItem = z.infer<typeof taskItemSchema>;

/** Batch calls carry `tasks[]`; the runtime still accepts a flat single item. */
const parseTaskItems = (input: unknown): readonly TaskItem[] | null => {
    const batch = batchSchema.safeParse(input);
    if (batch.success) return batch.data.tasks;
    const flat = taskItemSchema.safeParse(input);
    return flat.success ? [flat.data] : null;
};

/** `TaskToolDetails.progress`: one entry per spawn, `index` matching the call's item order. */
const taskDetailsSchema = z
    .object({ progress: z.array(z.object({ index: z.number(), id: z.string() }).passthrough()) })
    .passthrough();

const spawnProgress = (details: unknown): readonly { readonly index: number; readonly id: string }[] => {
    const parsed = taskDetailsSchema.safeParse(details);
    return parsed.success ? parsed.data.progress : [];
};

const promptHash = (item: TaskItem): string => createHash('sha256').update(item.task).digest('hex');

const itemLabel = (item: TaskItem, index: number): string => `\`${item.name ?? `item ${index + 1}`}\``;

const renderReminder = (unreminded: readonly string[], runningIds: readonly string[]): string => {
    const agents = [...runningIds.map(id => `\`${id}\` (already running)`), ...unreminded];
    return [
        `Not dispatched — a reminder, not a rule. This call would leave write-capable agents sharing this working directory without isolation: ${agents.join(', ')}. Agents sharing a checkout can overwrite each other's work.`,
        'Re-dispatch the writers with `isolated: true`. For an item that only researches, set `isolated: false` to keep it shared.',
        'Each prompt is reminded once: re-dispatching these same prompts unchanged runs them as written.',
    ].join('\n');
};

type SessionState = {
    /** Shared writers this session spawned; pruned once their job stops running. */
    readonly sharedAgentIds: Set<string>;
    /** Shared item indexes per dispatched call, recorded as agent ids on its result. */
    readonly pending: Map<string, ReadonlySet<number>>;
    /** Hashes of prompts whose dispatch was already blocked once. */
    readonly remindedPrompts: Set<string>;
};

export default function isolationNudge(pi: ExtensionAPI): void {
    const sessions = new Map<string, SessionState>();

    const stateOf = (ctx: ExtensionContext): SessionState => {
        const key = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
        const existing = sessions.get(key);
        if (existing !== undefined) return existing;
        const fresh: SessionState = { sharedAgentIds: new Set(), pending: new Map(), remindedPrompts: new Set() };
        sessions.set(key, fresh);
        return fresh;
    };

    const runningSharedIds = (ctx: ExtensionContext, sharedAgentIds: Set<string>): string[] => {
        const running = new Set(
            (ctx.getAsyncJobSnapshot()?.running ?? []).filter(job => job.type === 'task').map(job => job.id),
        );
        for (const id of sharedAgentIds) if (!running.has(id)) sharedAgentIds.delete(id);
        return [...sharedAgentIds];
    };

    /**
     * The task description documents `isolated` exactly when the field is in the
     * schema: isolation enabled and plan mode off. (`parameters` is an arktype
     * function, not serializable JSON.)
     */
    const isolationAvailable = (): boolean =>
        pi.getAllTools().some(tool => tool.name === 'task' && tool.description.includes('`isolated`'));

    /** Returns the block reason, or null to let the call run as written. */
    const onTaskCall = (toolCallId: string, input: unknown, ctx: ExtensionContext): string | null => {
        const items = parseTaskItems(input);
        if (items === null) return null;
        const state = stateOf(ctx);

        const shared = new Set<number>();
        const unreminded: { readonly label: string; readonly hash: string }[] = [];
        items.forEach((item, index) => {
            if (item.isolated === true || !isWriter(item.agent)) return;
            shared.add(index);
            if (item.isolated !== undefined) return;
            const hash = promptHash(item);
            if (!state.remindedPrompts.has(hash)) unreminded.push({ label: itemLabel(item, index), hash });
        });
        if (shared.size === 0) return null;

        const runningIds = runningSharedIds(ctx, state.sharedAgentIds);
        if (shared.size + runningIds.length >= 2 && unreminded.length > 0 && isolationAvailable()) {
            for (const { hash } of unreminded) state.remindedPrompts.add(hash);
            const labels = unreminded.map(({ label }) => label);
            pi.logger.info('isolation-nudge reminder: blocked shared-checkout dispatch', {
                unreminded: labels,
                runningSharedWriters: runningIds,
            });
            return renderReminder(labels, runningIds);
        }
        state.pending.set(toolCallId, shared);
        return null;
    };

    // A throwing tool_call handler blocks the tool, so every failure degrades to
    // "no reminder" and the spawn runs exactly as the model wrote it.
    pi.on('tool_call', (event, ctx) => {
        if (event.toolName !== 'task') return;
        try {
            const reason = onTaskCall(event.toolCallId, event.input, ctx);
            return reason === null ? undefined : { block: true, reason };
        } catch (error) {
            pi.logger.warn('isolation-nudge skipped a task call', { error: String(error) });
            return undefined;
        }
    });

    pi.on('tool_result', (event, ctx) => {
        if (event.toolName !== 'task') return;
        try {
            const state = stateOf(ctx);
            const shared = state.pending.get(event.toolCallId);
            if (shared === undefined) return;
            state.pending.delete(event.toolCallId);
            if (event.isError) return;
            for (const spawn of spawnProgress(event.details)) {
                if (shared.has(spawn.index)) state.sharedAgentIds.add(spawn.id);
            }
        } catch (error) {
            pi.logger.warn('isolation-nudge could not record a task result', { error: String(error) });
        }
    });
}
