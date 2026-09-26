import { basename } from 'node:path';
import { completeSimple } from '@oh-my-pi/pi-ai';
import { type ExtensionAPI, type ExtensionContext, z } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';

/**
 * Completion judge for `task:low` / `task:mid` / `task:free` subagents. It runs
 * inside the subagent's own session and intercepts its terminal `yield` — the
 * one step every task run (sync or async) passes before its result reaches
 * the parent. A fast model compares the original assignment (plus the batch's
 * shared context) with the last 50 tool calls and the submitted result, and
 * decides whether the work was actually finished.
 *
 * Per subagent session: the first terminal yield judged NOT done is blocked
 * and the reason goes back to the subagent, which keeps working. The next
 * terminal yield is judged again and always passes. Every yield that passes
 * after a definitive verdict carries it to the parent as
 * `data.completion_judge = { verdict, reason, bounced }`. Later yields in the
 * same session pass unjudged.
 *
 * The verdict is attached only when the yield's `data` is the schema-free open
 * object; a caller `outputSchema` could reject the extra field, so there the
 * yield passes unchanged (the bounce still applies). A data-less text result
 * is converted to `data: { result: <that text>, completion_judge }`.
 *
 * Every failure (agent not identified, model missing, provider error,
 * unparseable answer, deadline) lets the yield pass as written. The deadline
 * stays under the harness's 30 s `tool_call` handler timeout, which would
 * otherwise block the yield.
 */

const MODEL = 'openai-codex/gpt-6-sol';
const EFFORT = 'low';
const DEADLINE_MS = 25_000;
const JUDGED_AGENTS: Record<string, true> = { 'task:low': true, 'task:free': true, 'task:mid': true };
const TOOL_CALL_WINDOW = 50;
const ARGS_CHAR_LIMIT = 800;
const RESULT_CHAR_LIMIT = 800;
const SUBMISSION_CHAR_LIMIT = 6_000;

const SYSTEM_PROMPT = [
    'You audit whether a worker agent actually completed the assignment it was given.',
    'You receive: the assignment, the shared background context (may be empty), the worker\'s last tool calls with their results in order, and the result the worker is now submitting.',
    'Judge from the tool-call evidence, not from the worker\'s own claims. A claim in the submitted result that no tool call backs up does not count as done.',
    'DONE: everything the assignment asks for was delivered, and the tool calls show it (the edits or artifacts exist, the required commands ran, the required verification ran and passed).',
    'NOT_DONE: a required part is missing or only stubbed; the scope was quietly narrowed; required verification was skipped; a failure or error in the results was ignored; or the submitted result claims work the tool calls do not show.',
    'Only the last tool calls are shown; earlier work may exist. Do not answer NOT_DONE only because early steps are not visible, but the end state the assignment requires must be supported by what is shown or by the submitted result consistently with it.',
    'A worker that honestly reports a blocker it could not get past has not completed the assignment: answer NOT_DONE and name the blocker.',
    'Answer format: the first line is exactly `DONE` or `NOT_DONE`. The following lines give one short paragraph in Chinese with the concrete evidence; for NOT_DONE, name exactly what is missing.',
].join('\n');

// --- boundary schemas: yield input, session entries, yield tool parameters ---

const yieldInputSchema = z
    .object({
        key: z.unknown().optional(),
        error: z.string().nullable().optional(),
        type: z.union([z.string(), z.array(z.string())]).nullable().optional(),
        data: z.unknown().optional(),
    })
    .passthrough();
type YieldInput = z.infer<typeof yieldInputSchema>;

const dataObjectSchema = z.record(z.string(), z.unknown());

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const toolCallBlockSchema = z
    .object({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.unknown() })
    .passthrough();

const messageEntrySchema = z
    .object({
        type: z.literal('message'),
        message: z.union([
            z.object({ role: z.literal('user'), content: z.unknown() }).passthrough(),
            z.object({ role: z.literal('assistant'), content: z.array(z.unknown()) }).passthrough(),
            z
                .object({
                    role: z.literal('toolResult'),
                    toolCallId: z.string(),
                    content: z.unknown(),
                    isError: z.boolean().optional(),
                })
                .passthrough(),
        ]),
    })
    .passthrough();

/** The schema-free yield `data` is `{ type: 'object', additionalProperties: true }` with no declared properties. */
const openYieldParametersSchema = z
    .object({
        properties: z
            .object({
                data: z.object({ additionalProperties: z.literal(true), properties: z.undefined() }).passthrough(),
            })
            .passthrough(),
    })
    .passthrough();

// --- domain types ---

type Round = 'bounced' | 'settled';

type Verdict =
    | { readonly kind: 'done'; readonly reason: string }
    | { readonly kind: 'not_done'; readonly reason: string }
    | { readonly kind: 'unknown'; readonly why: string };

/** Terminal yields are judged; incremental sections, error yields, and workpool items pass untouched. */
type YieldCall =
    | { readonly kind: 'data'; readonly data: Readonly<Record<string, unknown>> }
    | { readonly kind: 'text' }
    | { readonly kind: 'opaque' }
    | { readonly kind: 'not_terminal' };

type ToolCallRecord = { readonly id: string; readonly name: string; readonly args: unknown };
type ToolResultRecord = { readonly text: string; readonly isError: boolean };

type Transcript = {
    readonly assignment: string;
    readonly calls: readonly ToolCallRecord[];
    readonly results: ReadonlyMap<string, ToolResultRecord>;
    readonly assistantTextByCallId: ReadonlyMap<string, string>;
};

// --- pure helpers ---

const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const block of content) {
        const parsed = textBlockSchema.safeParse(block);
        if (parsed.success) text += parsed.data.text;
    }
    return text;
};

const truncate = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    const head = Math.ceil(limit * 0.6);
    const tail = limit - head;
    return `${text.slice(0, head)}\n…[${text.length - limit} chars omitted]…\n${text.slice(text.length - tail)}`;
};

const stringify = (value: unknown): string => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

const classifyYield = (input: YieldInput): YieldCall => {
    if (input.key !== undefined && input.key !== null) return { kind: 'not_terminal' };
    if (typeof input.error === 'string' && input.error.trim() !== '') return { kind: 'not_terminal' };
    if (Array.isArray(input.type)) return { kind: 'not_terminal' };
    if (input.data === undefined || input.data === null) return { kind: 'text' };
    const data = dataObjectSchema.safeParse(input.data);
    return data.success && !Array.isArray(input.data) ? { kind: 'data', data: data.data } : { kind: 'opaque' };
};

const readTranscript = (ctx: ExtensionContext): Transcript => {
    let assignment = '';
    const calls: ToolCallRecord[] = [];
    const results = new Map<string, ToolResultRecord>();
    const assistantTextByCallId = new Map<string, string>();
    for (const entry of ctx.sessionManager.getBranch()) {
        const parsed = messageEntrySchema.safeParse(entry);
        if (!parsed.success) continue;
        const message = parsed.data.message;
        switch (message.role) {
            case 'user':
                if (assignment === '') assignment = textOf(message.content);
                break;
            case 'assistant': {
                const text = textOf(message.content);
                for (const block of message.content) {
                    const call = toolCallBlockSchema.safeParse(block);
                    if (!call.success) continue;
                    calls.push({ id: call.data.id, name: call.data.name, args: call.data.arguments });
                    assistantTextByCallId.set(call.data.id, text);
                }
                break;
            }
            case 'toolResult':
                results.set(message.toolCallId, { text: textOf(message.content), isError: message.isError === true });
                break;
        }
    }
    return { assignment, calls, results, assistantTextByCallId };
};

/** The batch's shared `context` is rendered into the subagent system prompt as its `§ Context` section. */
const sharedContextOf = (ctx: ExtensionContext): string => {
    const prompt = ctx.getSystemPrompt().join('\n');
    const marker = '§ Context\n';
    const start = prompt.indexOf(marker);
    if (start === -1) return '';
    const body = prompt.slice(start + marker.length);
    const end = body.indexOf('\n§ ');
    return (end === -1 ? body : body.slice(0, end)).trim();
};

const renderPrompt = (
    ctx: ExtensionContext,
    transcript: Transcript,
    yieldCallId: string,
    submission: string,
): string => {
    const prior = transcript.calls.filter(call => call.id !== yieldCallId);
    const window = prior.slice(-TOOL_CALL_WINDOW);
    const renderedCalls = window.map((call, index) => {
        const result = transcript.results.get(call.id);
        const status = result === undefined ? 'no result' : result.isError ? 'error' : 'ok';
        return [
            `<call n="${index + 1}" tool="${call.name}" status="${status}">`,
            `<args>${truncate(stringify(call.args), ARGS_CHAR_LIMIT)}</args>`,
            `<result>${result === undefined ? '' : truncate(result.text, RESULT_CHAR_LIMIT)}</result>`,
            '</call>',
        ].join('\n');
    });
    return [
        '<assignment>',
        transcript.assignment.trim() || '(missing)',
        '</assignment>',
        '<shared-context>',
        sharedContextOf(ctx) || '(none)',
        '</shared-context>',
        `<tool-calls shown="${window.length}" total="${prior.length}">`,
        ...renderedCalls,
        '</tool-calls>',
        '<submitted-result>',
        truncate(submission, SUBMISSION_CHAR_LIMIT),
        '</submitted-result>',
    ].join('\n');
};

const parseAnswer = (text: string): Verdict => {
    const lines = text.trim().split('\n');
    const head = (lines[0] ?? '').trim().replace(/^[`*\s]+|[`*\s]+$/g, '').toUpperCase();
    const reason = lines.slice(1).join('\n').trim();
    if (head === 'NOT_DONE') return { kind: 'not_done', reason };
    if (head === 'DONE') return { kind: 'done', reason };
    return { kind: 'unknown', why: `unparseable answer: ${text.slice(0, 80)}` };
};

const judge = async (ctx: ExtensionContext, prompt: string, signal: AbortSignal): Promise<Verdict> => {
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

export default function taskCompletionJudge(pi: ExtensionAPI): void {
    /** Per subagent session file: absent = not judged yet. */
    const rounds = new Map<string, Round>();

    const annotate = (
        input: YieldInput,
        call: YieldCall,
        assistantText: string | undefined,
        completionJudge: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> | undefined => {
        // Only the schema-free `data` can take an extra field without failing validation.
        const yieldTool = pi.getAllTools().find(tool => tool.name === 'yield');
        if (!openYieldParametersSchema.safeParse(yieldTool?.parameters).success) return undefined;
        switch (call.kind) {
            case 'data':
                return { ...input, data: { ...call.data, completion_judge: completionJudge } };
            case 'text':
                return assistantText === undefined
                    ? undefined
                    : { ...input, data: { result: assistantText, completion_judge: completionJudge } };
            case 'opaque':
            case 'not_terminal':
                return undefined;
        }
    };

    const review = async (
        toolCallId: string,
        rawInput: unknown,
        ctx: ExtensionContext,
    ): Promise<{ block: true; reason: string } | { input: Record<string, unknown> } | undefined> => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile === undefined) return undefined;
        const round = rounds.get(sessionFile);
        if (round === 'settled') return undefined;
        const parsedInput = yieldInputSchema.safeParse(rawInput);
        if (!parsedInput.success) return undefined;
        const input = parsedInput.data;
        const call = classifyYield(input);
        if (call.kind === 'not_terminal') return undefined;
        // Task session files are `<artifacts>/<agent-id>.jsonl`; the registry ref carries the agent definition name.
        const agentName = AgentRegistry.global()
            .list()
            .find(ref => ref.sessionFile === sessionFile)?.displayName;
        if (agentName === undefined || !Object.hasOwn(JUDGED_AGENTS, agentName)) return undefined;

        const transcript = readTranscript(ctx);
        const assistantText = transcript.assistantTextByCallId.get(toolCallId);
        const submission = call.kind === 'text' ? (assistantText ?? '') : stringify(input.data);
        const verdict = await judge(
            ctx,
            renderPrompt(ctx, transcript, toolCallId, submission),
            AbortSignal.timeout(DEADLINE_MS),
        );
        pi.logger.info('task-completion-judge verdict', {
            agent: basename(sessionFile, '.jsonl'),
            agentName,
            round: round ?? 'first',
            ...verdict,
        });

        if (verdict.kind === 'unknown') {
            rounds.set(sessionFile, 'settled');
            return undefined;
        }
        if (verdict.kind === 'not_done' && round === undefined) {
            rounds.set(sessionFile, 'bounced');
            const reason = [
                '完成度鉴定：对照最初的任务和你最近的 tool call，这次任务还没有真正完成，yield 被退回。',
                verdict.reason || '(鉴定未给出具体原因)',
                '补完缺失的部分并实际验证后再 yield。下一次 yield 会直接交付，鉴定结论会一并交给主 agent。',
            ].join('\n');
            return { block: true, reason };
        }
        rounds.set(sessionFile, 'settled');
        const revised = annotate(input, call, assistantText, {
            verdict: verdict.kind,
            reason: verdict.reason,
            bounced: round === 'bounced',
        });
        return revised === undefined ? undefined : { input: revised };
    };

    // A throwing tool_call handler blocks the tool, so every failure lets the yield run.
    pi.on('tool_call', async (event, ctx) => {
        if (event.toolName !== 'yield') return undefined;
        try {
            return await review(event.toolCallId, event.input, ctx);
        } catch (error) {
            pi.logger.warn('task-completion-judge skipped a yield', { error: String(error) });
            return undefined;
        }
    });

    pi.on('session_shutdown', (_event, ctx) => {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile !== undefined) rounds.delete(sessionFile);
    });
}
