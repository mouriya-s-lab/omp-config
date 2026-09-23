import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';

/**
 * Watches for shell commands that reimplement the built-in tools APPEND_SYSTEM.md
 * assigns to the model: list, read, search, edit, write and eval operations.
 * Ignoring the system prompt is one failure: after the first three hits, send at
 * most three generic steer nags per context, then go quiet until the context is
 * replaced (compaction, /clear, branch or tree navigation).
 */

const NAG_TEXT = '你为什么不遵守system prompt。';
const STATE_ENTRY_TYPE = 'mouriya.omp.tool-policy-nag.state';
/** Fire on the hit that goes *past* three. */
const HIT_THRESHOLD = 3;
const MAX_NAGS_PER_CONTEXT = 3;
/**
 * Neither ExtensionContext nor the persisted session header exposes
 * AgentSession's internal agent kind: main files are `<timestamp>_<uuid>.jsonl`,
 * while subagents are `<parent>/<AgentName>.jsonl`. Use this path discriminator
 * instead of `ctx.mode`, because headless main `omp -p` is also `"print"`.
 */
const MAIN_SESSION_FILE_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const isMainSession = (ctx: ExtensionContext): boolean => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const fileName = sessionFile?.split(/[\\/]/).pop();
    return fileName !== undefined && MAIN_SESSION_FILE_PATTERN.test(fileName);
};

const runForMainSession = (ctx: ExtensionContext, handler: () => void): void => {
    if (isMainSession(ctx)) handler();
};

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
const EVAL_PROGRAMS: Record<string, true> = {
    node: true,
    bun: true,
    deno: true,
    python: true,
    python3: true,
    ruby: true,
};
/**
 * Privilege elevation and remote execution: the command runs as another user or
 * on another host, where the built-in tools cannot reach, so it is never a hit.
 */
const EXEMPT_PROGRAMS: Record<string, true> = {
    sudo: true,
    doas: true,
    su: true,
    ssh: true,
};
/** Prefixes that delegate to the real program in the same command position. */
const WRAPPER_PROGRAMS: Record<string, true> = {
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

type NagState =
    | { readonly kind: 'watching'; readonly hits: number; readonly nagsSent: number }
    | { readonly kind: 'exhausted'; readonly hits: number; readonly nagsSent: number };

type ViolationCategory = 'list' | 'read' | 'search' | 'edit' | 'write' | 'eval';
type ShellProgram =
    | 'ls'
    | 'find'
    | 'cat'
    | 'bat'
    | 'nl'
    | 'head'
    | 'tail'
    | 'less'
    | 'more'
    | 'sed'
    | 'grep'
    | 'egrep'
    | 'fgrep'
    | 'rg'
    | 'ag'
    | 'ack'
    | 'awk'
    | 'perl'
    | 'mv'
    | 'echo'
    | 'printf'
    | 'node'
    | 'bun'
    | 'deno'
    | 'python'
    | 'python3'
    | 'ruby';
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Library entry points the eval tool's `code` uses to reimplement `read`/`glob`. */
type EvalApi =
    | 'open'
    | 'Path.read_text'
    | 'Path.read_bytes'
    | 'readlines'
    | 'readFileSync'
    | 'fs.readFile'
    | 'Bun.file'
    | 'os.listdir'
    | 'os.scandir'
    | 'os.walk'
    | 'glob.glob'
    | 'Path.glob'
    | 'readdirSync'
    | 'fs.readdir'
    | 'Bun.Glob';

/** One shell command matched by one or more policy categories. */
export type ShellViolation = {
    readonly categories: NonEmptyReadonlyArray<ViolationCategory>;
    readonly program: ShellProgram | EvalApi;
    readonly target: string;
};

type RedirectOperator = 'write' | 'append' | 'hereDoc' | 'hereString' | 'other';
type CommandToken =
    | { readonly kind: 'word'; readonly text: string }
    /** `<` — the following word is a file the command reads. */
    | { readonly kind: 'readFrom'; readonly fd: number }
    /** `>`, `>>`, `2>`, `<<`, `<<<` — the following word is not a file being read. */
    | {
          readonly kind: 'otherRedirect';
          readonly operator: RedirectOperator;
          readonly fd: number;
      };

const isOperatorChar = (ch: string): boolean =>
    ch === '|' || ch === '&' || ch === ';' || ch === '\n' || ch === '(' || ch === ')' || ch === '`';

type HereDocument = { readonly delimiter: string; readonly stripTabs: boolean };

const skipHereDocument = (command: string, start: number, document: HereDocument): number => {
    let cursor = start;
    while (cursor < command.length) {
        const lineEnd = command.indexOf('\n', cursor);
        const end = lineEnd === -1 ? command.length : lineEnd;
        const line = command.slice(cursor, end);
        const comparable = document.stripTabs ? line.replace(/^\t+/, '') : line;
        if (comparable === document.delimiter) return lineEnd === -1 ? command.length : lineEnd + 1;
        if (lineEnd === -1) return command.length;
        cursor = lineEnd + 1;
    }
    return command.length;
};

/**
 * Splits a shell line into simple commands, keeping only what the detector needs:
 * command-position words, and whether a word is a redirection target. Quotes are
 * consumed (their content stays a single word), `$(`/backtick substitutions and
 * control operators end the current command, so `echo $(cat f)` still exposes
 * `cat f` as its own simple command. Here-document bodies are opaque.
 */
type SimpleCommand = { readonly tokens: CommandToken[]; readonly pipelineId: number };

function splitSimpleCommands(command: string): SimpleCommand[] {
    const commands: SimpleCommand[] = [];
    let current: CommandToken[] = [];
    let pipelineId = 0;
    let nextPipelineId = 1;
    let word = '';
    let wordStart: number | null = null;
    let wordCanBeFd = true;
    let quote: '"' | "'" | null = null;
    const substitutions: Array<{ readonly delimiter: '$(' | '`'; readonly resumeQuote: '"' | null }> = [];
    const suspendedCommands: Array<{ readonly current: CommandToken[]; readonly pipelineId: number }> = [];
    const hereDocuments: HereDocument[] = [];
    let expectingHereDocumentDelimiter: HereDocument | null = null;
    const flushWord = (): void => {
        if (word.length === 0) {
            wordStart = null;
            wordCanBeFd = true;
            return;
        }
        current.push({ kind: 'word', text: word });
        if (expectingHereDocumentDelimiter !== null) {
            hereDocuments.push({ delimiter: word, stripTabs: expectingHereDocumentDelimiter.stripTabs });
            expectingHereDocumentDelimiter = null;
        }
        word = '';
        wordStart = null;
        wordCanBeFd = true;
    };
    const flushCommand = (): void => {
        flushWord();
        if (current.length === 0) return;
        commands.push({ tokens: current, pipelineId });
        current = [];
    };
    const flushPipeline = (): void => {
        flushCommand();
        pipelineId = nextPipelineId++;
    };
    const beginSubstitution = (delimiter: '$(' | '`', resumeQuote: '"' | null): void => {
        flushWord();
        suspendedCommands.push({ current, pipelineId });
        current = [];
        pipelineId = nextPipelineId++;
        substitutions.push({ delimiter, resumeQuote });
    };
    const finishSubstitution = (): void => {
        flushCommand();
        const suspended = suspendedCommands.pop();
        current = suspended?.current ?? [];
        pipelineId = suspended?.pipelineId ?? 0;
        const substitution = substitutions.pop();
        quote = substitution?.resumeQuote ?? null;
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
                // A substitution inside double quotes still runs a command. Restore
                // the surrounding quote after its matching closing delimiter.
                beginSubstitution('$(', '"');
                quote = null;
                i++;
            } else if (quote === '"' && ch === '`') {
                beginSubstitution('`', '"');
                quote = null;
            } else {
                word += ch;
            }
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            if (wordStart === null) wordStart = i;
            wordCanBeFd = false;
            word += command[i + 1] as string;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (wordStart === null) wordStart = i;
            wordCanBeFd = false;
            quote = ch;
            continue;
        }
        if (ch === '$' && command[i + 1] === '(') {
            beginSubstitution('$(', null);
            i++;
            continue;
        }
        if (ch === '`') {
            const substitution = substitutions[substitutions.length - 1];
            if (substitution?.delimiter === '`') finishSubstitution();
            else beginSubstitution('`', null);
            continue;
        }
        if (ch === ')' && substitutions[substitutions.length - 1]?.delimiter === '$(') {
            finishSubstitution();
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            flushWord();
            continue;
        }
        if (ch === '\n') {
            flushWord();
            if (hereDocuments.length > 0) {
                flushPipeline();
                let cursor = i + 1;
                for (const delimiter of hereDocuments) {
                    cursor = skipHereDocument(command, cursor, delimiter);
                }
                hereDocuments.length = 0;
                i = cursor - 1;
                continue;
            }
            flushPipeline();
            continue;
        }
        if (ch === '|') {
            if (command[i + 1] === '|') {
                flushPipeline();
                i++;
            } else if (command[i + 1] === '&') {
                flushCommand();
                i++;
            } else {
                flushCommand();
            }
            continue;
        }
        if (isOperatorChar(ch) && !(ch === '&' && command[i + 1] === '>')) {
            flushPipeline();
            continue;
        }
        if (ch === '<' || ch === '>') {
            let fdPrefix: number | null = null;
            if (
                wordCanBeFd &&
                wordStart !== null &&
                wordStart + word.length === i &&
                /^\d+$/.test(word)
            ) {
                fdPrefix = Number(word);
                word = '';
                wordStart = null;
                wordCanBeFd = true;
            } else {
                flushWord();
            }

            let operator: RedirectOperator;
            let consumed = 0;
            if (ch === '>') {
                if (command[i + 1] === '>') {
                    operator = 'append';
                    consumed = 1;
                } else if (command[i + 1] === '&') {
                    operator = 'other';
                    consumed = 1;
                } else {
                    operator = 'write';
                }
            } else if (command[i + 1] === '<' && command[i + 2] === '<') {
                operator = 'hereString';
                consumed = 2;
            } else if (command[i + 1] === '<') {
                operator = 'hereDoc';
                const stripTabs = command[i + 2] === '-';
                consumed = stripTabs ? 2 : 1;
                expectingHereDocumentDelimiter = { delimiter: '', stripTabs };
            } else if (command[i + 1] === '&') {
                operator = 'other';
                consumed = 1;
            } else {
                current.push({ kind: 'readFrom', fd: fdPrefix ?? 0 });
                continue;
            }
            current.push({
                kind: 'otherRedirect',
                operator,
                fd: fdPrefix ?? (ch === '>' ? 1 : 0),
            });
            i += consumed;
            continue;
        }
        if (wordStart === null) wordStart = i;
        word += ch;
    }
    flushPipeline();
    return commands;
}

const basename = (path: string): string => {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
};

const isEnvAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

const isFlag = (text: string): boolean => text.length > 1 && text.startsWith('-');

const firstScriptOperand = (args: readonly string[]): string | undefined => {
    let options = true;
    for (const arg of args) {
        if (options && arg === '--') {
            options = false;
            continue;
        }
        if (options && isFlag(arg) && arg !== '-') continue;
        return arg;
    }
    return undefined;
};

type ParsedArguments = { readonly flags: readonly string[]; readonly operands: readonly string[] };

const parseArguments = (args: readonly string[], consumesValue: (flag: string) => boolean): ParsedArguments => {
    const flags: string[] = [];
    const operands: string[] = [];
    let options = true;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (options && arg === '--') {
            options = false;
            continue;
        }
        if (options && isFlag(arg)) {
            flags.push(arg);
            if (consumesValue(arg)) i++;
            continue;
        }
        operands.push(arg);
    }
    return { flags, operands };
};

const optionName = (flag: string): string => {
    const equals = flag.indexOf('=');
    return equals === -1 ? flag : flag.slice(0, equals);
};

const noOptionValue = (_flag: string): boolean => false;

const readOptionConsumesValue = (program: string, flag: string): boolean => {
    const name = optionName(flag);
    if ((program === 'head' || program === 'tail') && (name === '-n' || name === '-c' || name === '--lines' || name === '--bytes')) {
        return flag === name;
    }
    if (program === 'nl' && (name === '-w' || name === '-s' || name === '-v' || name === '-i' || name === '--width' || name === '--separator' || name === '--starting-line-number' || name === '--line-increment')) {
        return flag === name;
    }
    return false;
};

const sedIsQuiet = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '--quiet' || flag === '--silent' || /^-[^-]*n/.test(flag));

const sedIsInPlace = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '--in-place' || flag.startsWith('--in-place=') || /^-[^-]*i/.test(flag));

/** With `-e`/`-f` the script is not an operand, so every operand is a file. */
const sedScriptIsFlag = (flags: readonly string[]): boolean =>
    flags.some(flag => {
        const name = optionName(flag);
        return name === '-e' || name === '-f' || name === '--expression' || name === '--file';
    });

const sedOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-e' || name === '-f' || name === '--expression' || name === '--file') && flag === name;
};

const perlOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-e' || name === '-f' || name === '--eval' || name === '--file') && flag === name;
};
const mvTarget = (args: readonly string[], operands: readonly string[]): string | undefined => {
    let targetDirectory: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (arg === '-t' || arg === '--target-directory') {
            targetDirectory = args[i + 1];
            i++;
        } else if (arg.startsWith('--target-directory=')) {
            targetDirectory = arg.slice('--target-directory='.length);
        } else if (arg.startsWith('-t') && arg.length > 2) {
            targetDirectory = arg.slice(2);
        }
    }
    if (targetDirectory !== undefined && operands.length > 0) return targetDirectory;
    if (operands.length < 2) return undefined;
    return lastNonDashOperand(operands);
};

const searchOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (
        name === '-e' ||
        name === '-f' ||
        name === '--regexp' ||
        name === '--file' ||
        name === '--include' ||
        name === '--exclude' ||
        name === '--exclude-dir' ||
        name === '-g' ||
        name === '--glob' ||
        name === '--type' ||
        name === '--type-add'
    ) && flag === name;
};

const FIND_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-D': true,
    '-maxdepth': true,
    '-mindepth': true,
    '-name': true,
    '-iname': true,
    '-path': true,
    '-ipath': true,
    '-wholename': true,
    '-iwholename': true,
    '-regex': true,
    '-iregex': true,
    '-type': true,
    '-user': true,
    '-group': true,
    '-perm': true,
    '-size': true,
    '-printf': true,
    '-fprintf': true,
};

const findOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return FIND_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const awkOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-f' || name === '-v' || name === '-F') && flag === name;
};

const isSearchFlag = (flag: string): boolean => {
    if (flag === '--include' || flag.startsWith('--include=')) return true;
    if (flag.startsWith('--')) return false;
    return flag.slice(1).includes('r') || flag.slice(1).includes('R') || flag.slice(1).includes('l');
};

const firstNonDashOperand = (operands: readonly string[]): string | undefined =>
    operands.find(operand => operand !== '-');

const lastNonDashOperand = (operands: readonly string[]): string | undefined => {
    for (let i = operands.length - 1; i >= 0; i--) {
        const operand = operands[i] as string;
        if (operand !== '-' && operand.length > 0) return operand;
    }
    return undefined;
};


/** `/dev/*` is a kernel stream, not file bytes any tool can fetch. */
const isDeviceTarget = (target: string): boolean => target.startsWith('/dev/');

type OutputRedirect = { readonly operator: 'write' | 'append'; readonly target: string };

function analyzeSimpleCommand(tokens: readonly CommandToken[]): ShellViolation[] {
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index] as CommandToken;
        if (token.kind === 'readFrom' || token.kind === 'otherRedirect') {
            index += 2;
            continue;
        }
        if (token.kind !== 'word') return [];
        if (isEnvAssignment(token.text) || WRAPPER_PROGRAMS[basename(token.text)] === true) {
            index++;
            continue;
        }
        break;
    }
    const head = tokens[index];
    if (head === undefined || head.kind !== 'word') return [];
    const program = basename(head.text);
    if (EXEMPT_PROGRAMS[program] === true) return [];
    const args: string[] = [];
    const readInputs: string[] = [];
    const outputRedirects: OutputRedirect[] = [];
    for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j] as CommandToken;
        if (token.kind === 'word') {
            if (j > index) args.push(token.text);
            continue;
        }
        const target = tokens[j + 1];
        if (target?.kind === 'word') {
            if (token.kind === 'readFrom' && token.fd === 0) {
                readInputs.push(target.text);
            } else if (
                token.kind === 'otherRedirect' &&
                token.fd === 1 &&
                !isDeviceTarget(target.text) &&
                (token.operator === 'write' ||
                    token.operator === 'append' ||
                    (token.operator === 'other' && !/^\d+$/.test(target.text) && target.text !== '-'))
            ) {
                outputRedirects.push({ operator: token.operator === 'append' ? 'append' : 'write', target: target.text });
            }
            j++;
        }
    }

    let categories: NonEmptyReadonlyArray<ViolationCategory> | null = null;
    let firstTarget: string | undefined;
    const addMatch = (category: ViolationCategory, target: string): void => {
        if (category !== 'list' && category !== 'eval' && isDeviceTarget(target)) return;
        firstTarget ??= target;
        if (categories === null) {
            categories = [category];
        } else if (!categories.includes(category)) {
            categories = [...categories, category];
        }
    };

    if (program === 'ls') {
        const parsed = parseArguments(args, noOptionValue);
        addMatch('list', firstNonDashOperand(parsed.operands) ?? '.');
    } else if (program === 'find') {
        const parsed = parseArguments(args, findOptionConsumesValue);
        const target = firstNonDashOperand(parsed.operands);
        if (target !== undefined) addMatch('list', target);
    }

    if (program === 'sed') {
        const parsed = parseArguments(args, sedOptionConsumesValue);
        if (sedIsInPlace(parsed.flags)) {
            const target = lastNonDashOperand(parsed.operands) ?? readInputs[0];
            if (target !== undefined) addMatch('edit', target);
        } else if (sedIsQuiet(parsed.flags)) {
            const fileOperands = sedScriptIsFlag(parsed.flags) ? parsed.operands : parsed.operands.slice(1);
            const target = firstNonDashOperand(fileOperands) ?? readInputs[0];
            if (target !== undefined) addMatch('read', target);
        }
    } else if (READ_PROGRAMS[program] === true) {
        const parsed = parseArguments(args, flag => readOptionConsumesValue(program, flag));
        const target = firstNonDashOperand(parsed.operands) ?? readInputs[0];
        if (target !== undefined) addMatch('read', target);
    }

    if (program === 'perl') {
        const parsed = parseArguments(args, perlOptionConsumesValue);
        const inPlace = parsed.flags.some(flag => flag === '--in-place' || flag.startsWith('--in-place=') || /^-[^-]*i/.test(flag));
        if (inPlace) {
            const target = lastNonDashOperand(parsed.operands) ?? readInputs[0];
            if (target !== undefined) addMatch('edit', target);
        }
    } else if (program === 'mv') {
        const parsed = parseArguments(args, () => false);
        const target = mvTarget(args, parsed.operands);
        if (target !== undefined) addMatch('edit', target);
    }

    if (
        program === 'grep' ||
        program === 'egrep' ||
        program === 'fgrep' ||
        program === 'rg' ||
        program === 'ag' ||
        program === 'ack'
    ) {
        const parsed = parseArguments(args, searchOptionConsumesValue);
        const hasSearchModeFlag = parsed.flags.some(isSearchFlag);
        const patternInOption = parsed.flags.some(flag => {
            const name = optionName(flag);
            return name === '-e' || name === '-f' || name === '--regexp' || name === '--file';
        });
        const fileOperand =
            parsed.operands.length > (patternInOption ? 0 : 1)
                ? parsed.operands[patternInOption ? 0 : 1]
                : readInputs[0];
        const target = fileOperand !== undefined && fileOperand !== '-' ? fileOperand : hasSearchModeFlag ? '.' : undefined;
        if (target !== undefined && (hasSearchModeFlag || readInputs.length > 0 || parsed.operands.length > (patternInOption ? 0 : 1))) {
            addMatch('search', target);
        }
    } else if (program === 'awk') {
        const parsed = parseArguments(args, awkOptionConsumesValue);
        const operands = parsed.operands.filter(operand => !isEnvAssignment(operand) && operand !== '-');
        const usesFileOption = parsed.flags.some(flag => optionName(flag) === '-f');
        const target = usesFileOption ? operands[0] : operands[1];
        if (target !== undefined) {
            addMatch('search', target);
        } else if (operands.length > 0 && readInputs[0] !== undefined) {
            addMatch('search', readInputs[0]);
        }
    }

    if (program === 'echo' || program === 'printf' || program === 'cat') {
        const redirect = outputRedirects[0];
        if (redirect !== undefined) addMatch('write', redirect.target);
    }

    if (EVAL_PROGRAMS[program] === true) {
        let target: string | null = null;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i] as string;
            if (arg === '-e' || arg === '-c' || arg === '--eval' || arg === '-p') {
                target = args[i + 1] ?? '<inline>';
                break;
            }
            if (arg.startsWith('--eval=')) {
                target = arg.slice('--eval='.length);
                break;
            }
            if (!arg.startsWith('--') && /^-[ecp].+/.test(arg)) {
                target = arg.slice(2);
                break;
            }
        }
        if (target === null && program === 'deno' && args[0] === 'eval') {
            target = firstScriptOperand(args.slice(1)) ?? '<inline>';
        }
        if (target === null && firstScriptOperand(args) === '-') target = '<stdin>';
        if (target !== null) addMatch('eval', target);
    }

    if (categories === null || firstTarget === undefined) return [];
    return [{ categories, program: program as ShellProgram, target: firstTarget }];
}

type CommandParts = {
    readonly program: string;
    readonly args: readonly string[];
    readonly hasInputRedirect: boolean;
};

const commandParts = (tokens: readonly CommandToken[]): CommandParts | null => {
    const words: string[] = [];
    let hasInputRedirect = false;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] as CommandToken;
        if (token.kind === 'word') {
            words.push(token.text);
            continue;
        }
        const target = tokens[i + 1];
        if (token.kind === 'readFrom' && token.fd === 0 && target?.kind === 'word') hasInputRedirect = true;
        if (target?.kind === 'word') i++;
    }

    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word === undefined) return null;
        if (isEnvAssignment(word) || WRAPPER_PROGRAMS[basename(word)] === true) {
            index++;
            continue;
        }
        return { program: basename(word), args: words.slice(index + 1), hasInputRedirect };
    }
    return null;
};

const SORT_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-k': true,
    '--key': true,
    '-t': true,
    '--field-separator': true,
    '-S': true,
    '--buffer-size': true,
    '-T': true,
    '--temporary-directory': true,
    '--compress-program': true,
    '--batch-size': true,
    '--parallel': true,
    '--files0-from': true,
};

const sortOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return SORT_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const UNIQ_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-f': true,
    '--skip-fields': true,
    '-s': true,
    '--skip-chars': true,
    '-w': true,
    '--check-chars': true,
    '--group': true,
    '--all-repeated': true,
};

const uniqOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return UNIQ_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const WC_OPTIONS_WITH_VALUES: Record<string, true> = {
    '--files0-from': true,
};

const wcOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return WC_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const isWcCommand = (tokens: readonly CommandToken[]): boolean => {
    const parts = commandParts(tokens);
    if (parts === null || parts.program !== 'wc' || parts.hasInputRedirect) return false;
    const parsed = parseArguments(parts.args, wcOptionConsumesValue);
    return firstNonDashOperand(parsed.operands) === undefined;
};

const isStreamReshaperWithoutFile = (tokens: readonly CommandToken[]): boolean => {
    const parts = commandParts(tokens);
    if (parts === null || parts.hasInputRedirect) return false;
    if (parts.program === 'tr') return true;
    if (parts.program === 'sort') return firstNonDashOperand(parseArguments(parts.args, sortOptionConsumesValue).operands) === undefined;
    if (parts.program === 'uniq') return firstNonDashOperand(parseArguments(parts.args, uniqOptionConsumesValue).operands) === undefined;
    if (parts.program === 'head' || parts.program === 'tail') {
        return firstNonDashOperand(parseArguments(parts.args, flag => readOptionConsumesValue(parts.program, flag)).operands) === undefined;
    }
    if (parts.program !== 'grep' && parts.program !== 'egrep' && parts.program !== 'fgrep' && parts.program !== 'rg' && parts.program !== 'ag' && parts.program !== 'ack') {
        return false;
    }
    const parsed = parseArguments(parts.args, searchOptionConsumesValue);
    const patternInOption = parsed.flags.some(flag => {
        const name = optionName(flag);
        return name === '-e' || name === '-f' || name === '--regexp' || name === '--file';
    });
    const fileOperands = parsed.operands.slice(patternInOption ? 0 : 1).filter(operand => operand !== '-');
    return fileOperands.length === 0;
};


const isCountExemptViolation = (violation: ShellViolation): boolean =>
    violation.categories.every(category => category === 'list' || category === 'read' || category === 'search');

/**
 * Walk backward over trailing stream reshapers to find the effective sink.
 * Only a `wc` sink makes read-only producers an allowed count pipeline.
 */
const countPipelineSinkIndex = (commands: readonly SimpleCommand[], lastIndex: number): number => {
    let index = lastIndex;
    while (index > 0) {
        const current = commands[index];
        const previous = commands[index - 1];
        if (
            current === undefined ||
            previous === undefined ||
            current.pipelineId !== previous.pipelineId ||
            !isStreamReshaperWithoutFile(current.tokens)
        ) {
            break;
        }
        index--;
    }
    return index;
};

/**
 * A terminal `wc` makes the preceding list/read/search producers part of an
 * allowed count pipeline. `ls -dt ... | head` remains a violation because the
 * glob contract makes `ls`'s newest-first ordering tool-covered; `head` is not
 * a counter.
 */
export function detectShellViolations(command: string): ShellViolation[] {
    const commands = splitSimpleCommands(command);
    const pipelineLast = new Map<number, number>();
    for (const [index, simple] of commands.entries()) pipelineLast.set(simple.pipelineId, index);

    const violations: ShellViolation[] = [];
    for (const [index, simple] of commands.entries()) {
        const commandViolations = analyzeSimpleCommand(simple.tokens);
        if (commandViolations.length === 0) continue;
        const lastIndex = pipelineLast.get(simple.pipelineId);
        const sinkIndex = lastIndex === undefined ? undefined : countPipelineSinkIndex(commands, lastIndex);
        const isCountPipelineProducer = sinkIndex !== undefined && sinkIndex > index && isWcCommand(commands[sinkIndex]?.tokens ?? []);
        if (isCountPipelineProducer) {
            violations.push(...commandViolations.filter(violation => !isCountExemptViolation(violation)));
        } else {
            violations.push(...commandViolations);
        }
    }
    return violations;
}

type UnknownRecord = { readonly [key: string]: unknown };

const stringField = (value: unknown, field: string): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as UnknownRecord;
    const result = record[field];
    return typeof result === 'string' ? result : null;
};

const WRITE_DEVICE_COMMAND_FIELDS: Record<string, 'command' | 'cmd'> = {
    'xd://bash_bg': 'command',
    'xd://bash': 'command',
    'xd://exec_command': 'cmd',
};

/**
 * Extracts a shell command from a write-device payload. Device content is
 * untrusted JSON; malformed or non-shell payloads are intentionally ignored.
 */
export function detectWriteShellViolations(path: string, content: unknown): ShellViolation[] {
    const commandField = WRITE_DEVICE_COMMAND_FIELDS[path];
    if (commandField === undefined || typeof content !== 'string') return [];
    try {
        const payload: unknown = JSON.parse(content);
        const command = stringField(payload, commandField);
        return command === null ? [] : detectShellViolations(command);
    } catch {
        return [];
    }
}

type EvalLanguage = 'py' | 'js';
/** One library call the eval tool's `code` uses where a built-in tool exists. */
type EvalPattern = {
    readonly category: 'read' | 'list';
    readonly program: EvalApi;
    readonly test: RegExp;
};

/**
 * The eval tool's `code` is Python or JavaScript, not a shell line, so it needs
 * its own matchers. Only file reads (the `read` tool) and path/directory listing
 * (the `glob` tool) are flagged; writes, subprocesses, and in-memory work are
 * left alone. Patterns run in order and the first match per category names it.
 */
const EVAL_PATTERNS: Record<EvalLanguage, readonly EvalPattern[]> = {
    py: [
        { category: 'read', program: 'Path.read_text', test: /\.read_text\s*\(/ },
        { category: 'read', program: 'Path.read_bytes', test: /\.read_bytes\s*\(/ },
        { category: 'read', program: 'open', test: /\bopen\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*read/ },
        { category: 'read', program: 'open', test: /\bopen\s*\([^)]*,\s*['"]r[bt+]*['"]\s*\)/ },
        { category: 'read', program: 'open', test: /\bwith\s+open\s*\((?![^)]*['"][wax][bt+]*['"])[^)]*\)\s*as\b/ },
        { category: 'read', program: 'open', test: /\bfor\b[^\n]*\bin\s+open\s*\(/ },
        { category: 'read', program: 'readlines', test: /\.readlines\s*\(/ },
        { category: 'list', program: 'glob.glob', test: /\bglob\.i?glob\s*\(/ },
        { category: 'list', program: 'os.walk', test: /\bos\.walk\s*\(/ },
        { category: 'list', program: 'os.listdir', test: /\bos\.listdir\s*\(/ },
        { category: 'list', program: 'os.scandir', test: /\bos\.scandir\s*\(/ },
        { category: 'list', program: 'Path.glob', test: /\.\s*r?glob\s*\(/ },
    ],
    js: [
        { category: 'read', program: 'readFileSync', test: /\breadFileSync\s*\(/ },
        { category: 'read', program: 'fs.readFile', test: /\.\s*readFile\s*\(/ },
        { category: 'read', program: 'Bun.file', test: /\bBun\.file\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:text|json|bytes|arrayBuffer|stream|formData)\s*\(/ },
        { category: 'list', program: 'readdirSync', test: /\breaddirSync\s*\(/ },
        { category: 'list', program: 'fs.readdir', test: /\.\s*readdir\s*\(/ },
        { category: 'list', program: 'Bun.Glob', test: /\bBun\.Glob\b|\bnew\s+Glob\s*\(/ },
    ],
};

const isEvalLanguage = (language: string): language is EvalLanguage =>
    language === 'py' || language === 'js';

/**
 * Flags eval-tool code that reimplements `read` (file bytes) or `glob`
 * (directory/path listing), at most one violation per category. Write,
 * subprocess, and pure in-memory work are intentionally ignored.
 */
export function detectEvalViolations(language: string, code: string): ShellViolation[] {
    if (!isEvalLanguage(language)) return [];
    const seen: Record<'read' | 'list', boolean> = { read: false, list: false };
    const violations: ShellViolation[] = [];
    for (const { category, program, test } of EVAL_PATTERNS[language]) {
        if (seen[category]) continue;
        const match = test.exec(code);
        if (match === null) continue;
        seen[category] = true;
        violations.push({ categories: [category], program, target: match[0].trim().slice(0, 60) });
    }
    return violations;
}

const WATCHING: NagState = { kind: 'watching', hits: 0, nagsSent: 0 };

function parseState(data: unknown): NagState | null {
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;
    if (record.kind !== 'watching' && record.kind !== 'exhausted') return null;
    if (
        typeof record.hits !== 'number' ||
        !Number.isFinite(record.hits) ||
        typeof record.nagsSent !== 'number' ||
        !Number.isFinite(record.nagsSent)
    ) {
        return null;
    }
    const hits = Math.max(0, Math.trunc(record.hits));
    const nagsSent = Math.max(0, Math.trunc(record.nagsSent));
    return record.kind === 'exhausted' ? { kind: 'exhausted', hits, nagsSent } : { kind: 'watching', hits, nagsSent };
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
    const nestedDeviceCalls = new Set<string>();

    const commit = (next: NagState): void => {
        state = next;
        pi.appendEntry(STATE_ENTRY_TYPE, next);
    };

    const rearm = (reason: string): void => {
        if (state.kind === 'watching' && state.hits === 0 && state.nagsSent === 0) return;
        pi.logger.info('Tool-policy nag re-armed', { reason, previous: state });
        commit(WATCHING);
    };

    const restore = (reason: string, ctx: ExtensionContext): void => {
        state = rebuildState(ctx);
        pi.logger.info('Tool-policy nag state restored', { reason, state });
    };

    pi.on('session_start', (_event, ctx) => runForMainSession(ctx, () => restore('session_start', ctx)));
    pi.on('session_switch', (_event, ctx) => runForMainSession(ctx, () => restore('session_switch', ctx)));
    pi.on('session_branch', (_event, ctx) => runForMainSession(ctx, () => restore('session_branch', ctx)));
    pi.on('session_tree', (_event, ctx) => runForMainSession(ctx, () => restore('session_tree', ctx)));
    pi.on('session_compact', (_event, ctx) => runForMainSession(ctx, () => rearm('session_compact')));
    pi.on('auto_compaction_end', (event, ctx) =>
        runForMainSession(ctx, () => {
            if (event.aborted || event.skipped === true || event.result === undefined) return;
            rearm(`auto_compaction_end:${event.action}`);
        }),
    );

    pi.on('tool_call', (event, ctx) => runForMainSession(ctx, () => {
        if (event.toolName !== 'write' && nestedDeviceCalls.delete(event.toolCallId)) return;
        if (state.kind === 'exhausted') return;

        let violations: ShellViolation[];
        if (event.toolName === 'bash' || event.toolName === 'bash_bg') {
            const command = stringField(event.input, 'command');
            if (command === null) return;
            violations = detectShellViolations(command);
        } else if (event.toolName === 'write') {
            const path = stringField(event.input, 'path');
            const content = stringField(event.input, 'content');
            if (path === null || content === null) return;
            if (WRITE_DEVICE_COMMAND_FIELDS[path] !== undefined) nestedDeviceCalls.add(event.toolCallId);
            violations = detectWriteShellViolations(path, content);
        } else if (event.toolName === 'exec_command') {
            const command = stringField(event.input, 'cmd');
            if (command === null) return;
            violations = detectShellViolations(command);
        } else if (event.toolName === 'eval') {
            const language = stringField(event.input, 'language');
            const code = stringField(event.input, 'code');
            if (language === null || code === null) return;
            violations = detectEvalViolations(language, code);
        } else {
            return;
        }
        if (violations.length === 0) return;

        // Every offending command counts, so four `cat`s batched into one bash
        // call are four hits rather than one.
        const hits = state.hits + violations.length;
        const programs = violations.map(violation => `${violation.program} ${violation.target}`);
        const violationDetails = violations.map(({ categories, program, target }) => ({ categories, program, target }));
        if (hits <= HIT_THRESHOLD) {
            pi.logger.info('Tool-policy violation observed', {
                hits,
                threshold: HIT_THRESHOLD,
                programs,
                violations: violationDetails,
                nagNumber: state.nagsSent,
                nagsSent: state.nagsSent,
                maxNags: MAX_NAGS_PER_CONTEXT,
                detectorArmed: true,
            });
            commit({ kind: 'watching', hits, nagsSent: state.nagsSent });
            return;
        }
        if (state.nagsSent >= MAX_NAGS_PER_CONTEXT) {
            commit({ kind: 'exhausted', hits, nagsSent: state.nagsSent });
            return;
        }
        const nagsSent = state.nagsSent + 1;
        const detectorArmed = nagsSent < MAX_NAGS_PER_CONTEXT;
        pi.logger.warn('Tool-policy violation past threshold — nagging', {
            hits,
            programs,
            violations: violationDetails,
            nagNumber: nagsSent,
            nagsSent,
            maxNags: MAX_NAGS_PER_CONTEXT,
            detectorArmed,
        });
        commit(
            detectorArmed
                ? { kind: 'watching', hits, nagsSent }
                : { kind: 'exhausted', hits, nagsSent },
        );
        pi.sendUserMessage(NAG_TEXT, { deliverAs: 'steer' });
        ctx.ui.notify(
            `Shell policy nag ${nagsSent}/${MAX_NAGS_PER_CONTEXT} sent for hit #${hits} (${programs.join(', ')}) — detector ${
                detectorArmed ? 'still armed' : 'exhausted until compaction'
            }`,
            'warning',
        );
    }));
}
