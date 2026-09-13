import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';

/**
 * Watches for the one violation APPEND_SYSTEM.md predicts the Claude models will
 * commit anyway: reading file bytes through a shell command instead of the `read`
 * tool ("Read a file or range" row of the Tool Call table). Past three hits the
 * session gets one nag, then the detector goes quiet until the context is
 * replaced (compaction, /clear, branch or tree navigation).
 */

const NAG_TEXT = '你为什么不遵守system prompt。';
const STATE_ENTRY_TYPE = 'mouriya.omp.tool-policy-nag.state';
/** Fire on the hit that goes *past* three. */
const HIT_THRESHOLD = 3;

/** Programs that source file bytes the `read` tool owns. */
const READ_PROGRAMS: Record<string, true> = {
    cat: true,
    bat: true,
    nl: true,
    head: true,
    tail: true,
    less: true,
    more: true,
    sed: true,
};
/** Prefixes that delegate to the real program in the same command position. */
const WRAPPER_PROGRAMS: Record<string, true> = {
    sudo: true,
    command: true,
    env: true,
    time: true,
    nohup: true,
    builtin: true,
    exec: true,
    stdbuf: true,
    nice: true,
    xargs: true,
};

type NagState = { readonly kind: 'watching'; readonly hits: number } | { readonly kind: 'fired' };

/** One file-sourcing read command found in a shell line. */
export type ReadShellViolation = { readonly program: string; readonly target: string };

type CommandToken =
    | { readonly kind: 'word'; readonly text: string }
    /** `<` — the following word is a file the command reads. */
    | { readonly kind: 'readFrom' }
    /** `>`, `>>`, `2>`, `<<`, `<<<` — the following word is not a file being read. */
    | { readonly kind: 'otherRedirect' };

const isOperatorChar = (ch: string): boolean =>
    ch === '|' || ch === '&' || ch === ';' || ch === '\n' || ch === '(' || ch === ')' || ch === '`';

/**
 * Splits a shell line into simple commands, keeping only what the detector needs:
 * command-position words, and whether a word is a redirection target. Quotes are
 * consumed (their content stays a single word), `$(`/backtick substitutions and
 * control operators end the current command, so `echo $(cat f)` still exposes
 * `cat f` as its own simple command.
 */
function splitSimpleCommands(command: string): CommandToken[][] {
    const commands: CommandToken[][] = [];
    let current: CommandToken[] = [];
    let word = '';
    let quote: '"' | "'" | null = null;

    const flushWord = (): void => {
        if (word.length === 0) return;
        current.push({ kind: 'word', text: word });
        word = '';
    };
    const flushCommand = (): void => {
        flushWord();
        if (current.length === 0) return;
        commands.push(current);
        current = [];
    };

    for (let i = 0; i < command.length; i++) {
        const ch = command[i] as string;
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
            } else if (quote === '"' && ch === '\\' && i + 1 < command.length) {
                word += command[i + 1] as string;
                i++;
            } else if (quote === '"' && ch === '$' && command[i + 1] === '(') {
                // A substitution inside double quotes still runs a command: leave
                // quoted mode so its body tokenizes as one, ended by the `)` operator.
                flushCommand();
                quote = null;
                i++;
            } else {
                word += ch;
            }
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            word += command[i + 1] as string;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '$' && command[i + 1] === '(') {
            flushCommand();
            i++;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            flushWord();
            continue;
        }
        if (isOperatorChar(ch)) {
            flushCommand();
            continue;
        }
        if (ch === '<' || ch === '>') {
            flushWord();
            const doubled = command[i + 1] === ch;
            const tripled = doubled && command[i + 2] === ch;
            current.push({ kind: ch === '<' && !doubled ? 'readFrom' : 'otherRedirect' });
            i += tripled ? 2 : doubled ? 1 : 0;
            continue;
        }
        word += ch;
    }
    flushCommand();
    return commands;
}

const basename = (path: string): string => {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
};

const isEnvAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

const isFlag = (text: string): boolean => text.length > 1 && text.startsWith('-');

/** `sed` only replaces `read` when it prints selected lines: `-n`/`--quiet`/`--silent`. */
const sedIsQuiet = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '--quiet' || flag === '--silent' || /^-[^-]*n/.test(flag));

/** With `-e`/`-f` the script is not an operand, so every operand is a file. */
const sedScriptIsFlag = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '-e' || flag === '-f' || flag === '--expression' || flag === '--file');

function analyzeSimpleCommand(tokens: readonly CommandToken[]): ReadShellViolation | null {
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === undefined || token.kind !== 'word') return null;
        if (isEnvAssignment(token.text) || WRAPPER_PROGRAMS[basename(token.text)] === true) {
            index++;
            continue;
        }
        break;
    }
    const head = tokens[index];
    if (head === undefined || head.kind !== 'word') return null;
    const program = basename(head.text);
    if (READ_PROGRAMS[program] !== true) return null;

    const flags: string[] = [];
    const operands: string[] = [];
    for (let j = index + 1; j < tokens.length; j++) {
        const token = tokens[j] as CommandToken;
        if (token.kind === 'otherRedirect') {
            j++;
            continue;
        }
        if (token.kind === 'readFrom') {
            const target = tokens[j + 1];
            if (target?.kind === 'word') {
                operands.push(target.text);
                j++;
            }
            continue;
        }
        if (isFlag(token.text)) flags.push(token.text);
        else operands.push(token.text);
    }

    if (program === 'sed') {
        if (!sedIsQuiet(flags)) return null;
        const files = sedScriptIsFlag(flags) ? operands : operands.slice(1);
        const target = files[0];
        return target === undefined ? null : { program, target };
    }
    // No operand: the command filters another command's output rather than
    // sourcing a file (`some-cli | head -20`), which the read tool cannot do.
    const target = operands.find(operand => operand !== '-');
    return target === undefined ? null : { program, target };
}

/** Every file-sourcing read command in a shell line. */
export function detectReadShellViolations(command: string): ReadShellViolation[] {
    const violations: ReadShellViolation[] = [];
    for (const tokens of splitSimpleCommands(command)) {
        const violation = analyzeSimpleCommand(tokens);
        if (violation !== null) violations.push(violation);
    }
    return violations;
}

const WATCHING: NagState = { kind: 'watching', hits: 0 };

function parseState(data: unknown): NagState | null {
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;
    if (record.kind === 'fired') return { kind: 'fired' };
    if (record.kind === 'watching' && typeof record.hits === 'number' && Number.isFinite(record.hits)) {
        return { kind: 'watching', hits: Math.max(0, Math.trunc(record.hits)) };
    }
    return null;
}

/**
 * Rebuilds the counter from the session branch so a resumed process keeps its
 * word: a boundary that replaces the model's context (compaction, `/clear`,
 * a branch summary) discards every hit recorded before it.
 */
function rebuildState(ctx: ExtensionContext): NagState {
    let state: NagState = WATCHING;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'compaction' || entry.type === 'reset_boundary' || entry.type === 'branch_summary') {
            state = WATCHING;
            continue;
        }
        if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY_TYPE) continue;
        const parsed = parseState(entry.data);
        if (parsed !== null) state = parsed;
    }
    return state;
}

export default function toolPolicyNag(pi: ExtensionAPI): void {
    let state: NagState = WATCHING;

    const commit = (next: NagState): void => {
        state = next;
        pi.appendEntry(STATE_ENTRY_TYPE, next);
    };

    const rearm = (reason: string): void => {
        if (state.kind === 'watching' && state.hits === 0) return;
        pi.logger.info('Tool-policy nag re-armed', { reason, previous: state });
        commit(WATCHING);
    };

    const restore = (reason: string, ctx: ExtensionContext): void => {
        state = rebuildState(ctx);
        pi.logger.info('Tool-policy nag state restored', { reason, state });
    };

    pi.on('session_start', (_event, ctx) => restore('session_start', ctx));
    pi.on('session_switch', (_event, ctx) => restore('session_switch', ctx));
    pi.on('session_branch', (_event, ctx) => restore('session_branch', ctx));
    pi.on('session_tree', (_event, ctx) => restore('session_tree', ctx));
    pi.on('session_compact', () => rearm('session_compact'));
    pi.on('auto_compaction_end', event => {
        if (event.aborted || event.skipped === true || event.result === undefined) return;
        rearm(`auto_compaction_end:${event.action}`);
    });

    pi.on('tool_call', (event, ctx) => {
        if (state.kind === 'fired') return;
        // Literal comparisons, not a table lookup: they narrow the ToolCallEvent
        // union so `input.command` is typed.
        if (event.toolName !== 'bash' && event.toolName !== 'bash_bg') return;
        const command = event.input.command;
        if (typeof command !== 'string') return;
        const violations = detectReadShellViolations(command);
        if (violations.length === 0) return;

        // Every offending command counts, so four `cat`s batched into one bash
        // call are four hits rather than one.
        const hits = state.hits + violations.length;
        const programs = violations.map(violation => `${violation.program} ${violation.target}`);
        if (hits <= HIT_THRESHOLD) {
            pi.logger.info('Tool-policy read violation', { hits, threshold: HIT_THRESHOLD, programs });
            commit({ kind: 'watching', hits });
            return;
        }
        pi.logger.warn('Tool-policy read violation past threshold — nagging', { hits, programs });
        commit({ kind: 'fired' });
        pi.sendUserMessage(NAG_TEXT, { deliverAs: 'aside' });
        ctx.ui.notify(`Shell read #${hits} (${programs.join(', ')}) — nag sent, detector off until compaction`, 'warning');
    });
}
