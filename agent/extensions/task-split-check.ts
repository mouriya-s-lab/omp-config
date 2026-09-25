import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { completeSimple } from '@oh-my-pi/pi-ai';
import { type ExtensionAPI, type ExtensionContext, z } from '@oh-my-pi/pi-coding-agent';

/**
 * Split check for the main agent's `task` calls. Before a call runs, each item
 * dispatched to `task:low` / `task:free` / `task:mid` is shown — prompt only,
 * no tools, nothing read — to a fast model that answers whether the item
 * bundles several independent tasks. All items are judged concurrently; when
 * any item comes back `true` the whole call is blocked and the main agent is
 * told it did not plan the work. A definitive verdict is cached per process by
 * the hash of the exact classifier prompt (shared context + item task), so an
 * identical re-dispatch reuses it instead of asking the model again.
 *
 * Every failure (model missing, provider error, unparseable answer, deadline)
 * lets the call run as written. The deadline stays under the harness's 30 s
 * `tool_call` handler timeout, which would otherwise block the call.
 */

const MODEL = 'openai-codex/gpt-6-sol';
const EFFORT = 'medium';
const DEADLINE_MS = 25_000;
const CHECKED_AGENTS: Record<string, true> = { 'task:low': true, 'task:free': true, 'task:mid': true };

/** Main session files are `<timestamp>_<uuid>.jsonl`; subagents are `<parent>/<name>.jsonl`. */
const MAIN_SESSION_FILE_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const SYSTEM_PROMPT = [
    'You check one assignment that an orchestrating agent is about to hand to a single worker agent.',
    'Decide whether this one assignment bundles two or more independent tasks that should have been dispatched as separate assignments.',
    'Parts are independent when each has its own acceptance criterion, can start without another part\'s output, and does not share files or state with the other parts.',
    'Not a bundle: several steps toward one outcome; one change together with its verification; one investigation asking several questions about the same thing; a cohesive refactor of one area.',
    'The shared context describes the whole batch and is background only. Judge the assignment text.',
    'Answer with exactly one word: `true` if the assignment bundles independent tasks, `false` otherwise.',
].join('\n');

const taskItemSchema = z
    .object({
        task: z.string(),
        name: z.string().optional(),
        agent: z.string().optional(),
    })
    .passthrough();
const batchSchema = z.object({ context: z.string().optional(), tasks: z.array(taskItemSchema) }).passthrough();
type TaskItem = z.infer<typeof taskItemSchema>;
type TaskCall = { readonly context: string | undefined; readonly items: readonly TaskItem[] };

/** Batch calls carry `context` + `tasks[]`; the runtime still accepts a flat single item. */
const parseTaskCall = (input: unknown): TaskCall | null => {
    const batch = batchSchema.safeParse(input);
    if (batch.success) return { context: batch.data.context, items: batch.data.tasks };
    const flat = taskItemSchema.safeParse(input);
    return flat.success ? { context: undefined, items: [flat.data] } : null;
};

type Verdict =
    | { readonly kind: 'bundled' }
    | { readonly kind: 'split' }
    | { readonly kind: 'unknown'; readonly why: string };

const parseAnswer = (text: string): Verdict => {
    const word = text.trim().replace(/^`+|`+$/g, '').toLowerCase();
    if (/^true\b/.test(word)) return { kind: 'bundled' };
    if (/^false\b/.test(word)) return { kind: 'split' };
    return { kind: 'unknown', why: `unparseable answer: ${text.slice(0, 80)}` };
};

const renderPrompt = (context: string | undefined, item: TaskItem): string =>
    [
        '<shared-context>',
        context?.trim() || '(none)',
        '</shared-context>',
        '<assignment>',
        item.task.trim(),
        '</assignment>',
    ].join('\n');

const itemLabel = (item: TaskItem, index: number): string => `\`${item.name ?? `item ${index + 1}`}\``;

const isMainSession = (ctx: ExtensionContext): boolean => {
    const file = ctx.sessionManager.getSessionFile();
    return file !== undefined && MAIN_SESSION_FILE_PATTERN.test(basename(file));
};

type DefinitiveVerdict = Exclude<Verdict, { kind: 'unknown' }>;

/** Verdicts by sha256 of the classifier prompt; failures are never cached. */
const verdictCache = new Map<string, DefinitiveVerdict>();

export default function taskSplitCheck(pi: ExtensionAPI): void {
    const classify = async (ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<Verdict> => {
        const model = ctx.models.resolve(MODEL);
        if (model === undefined) return { kind: 'unknown', why: `model unavailable: ${MODEL}` };
        try {
            const reply = await completeSimple(
                model,
                {
                    systemPrompt: [SYSTEM_PROMPT],
                    messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
                },
                { apiKey: ctx.modelRegistry.resolver(model), reasoning: EFFORT, signal },
            );
            if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
                return { kind: 'unknown', why: `${reply.stopReason}: ${reply.errorMessage ?? ''}` };
            }
            const text = reply.content
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join('');
            return parseAnswer(text);
        } catch (error) {
            return { kind: 'unknown', why: signal.aborted ? 'deadline' : String(error) };
        }
    };

    const judge = async (
        ctx: ExtensionContext,
        prompt: string,
        signal: AbortSignal,
    ): Promise<{ readonly verdict: Verdict; readonly cached: boolean }> => {
        const hash = createHash('sha256').update(prompt).digest('hex');
        const cached = verdictCache.get(hash);
        if (cached !== undefined) return { verdict: cached, cached: true };
        const verdict = await classify(ctx, prompt, signal);
        if (verdict.kind !== 'unknown') verdictCache.set(hash, verdict);
        return { verdict, cached: false };
    };

    /** Returns the block reason, or null to let the call run as written. */
    const check = async (input: unknown, ctx: ExtensionContext): Promise<string | null> => {
        if (!isMainSession(ctx)) return null;
        const call = parseTaskCall(input);
        if (call === null) return null;
        const checked = call.items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.agent !== undefined && Object.hasOwn(CHECKED_AGENTS, item.agent));
        if (checked.length === 0) return null;

        const deadline = AbortSignal.timeout(DEADLINE_MS);
        const verdicts = await Promise.all(
            checked.map(async ({ item, index }) => ({
                label: itemLabel(item, index),
                ...(await judge(ctx, renderPrompt(call.context, item), deadline)),
            })),
        );
        pi.logger.info('task-split-check verdicts', {
            verdicts: verdicts.map(({ label, verdict, cached }) => ({ label, cached, ...verdict })),
        });
        const bundled = verdicts.filter(({ verdict }) => verdict.kind === 'bundled').map(({ label }) => label);
        if (bundled.length === 0) return null;
        return `你没有好好规划任务：${bundled.join('、')} 把多个独立任务塞给了一个 agent，拆成多个 item 后重新派发。`;
    };

    // A throwing tool_call handler blocks the tool, so every failure lets the call run.
    pi.on('tool_call', async (event, ctx) => {
        if (event.toolName !== 'task') return;
        try {
            const reason = await check(event.input, ctx);
            return reason === null ? undefined : { block: true, reason };
        } catch (error) {
            pi.logger.warn('task-split-check skipped a task call', { error: String(error) });
            return undefined;
        }
    });
}
