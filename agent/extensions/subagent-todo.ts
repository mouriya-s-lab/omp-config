import { type ExtensionAPI, type ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session';
import type { ToolSession } from '@oh-my-pi/pi-coding-agent/tools';
import { TodoTool } from '@oh-my-pi/pi-coding-agent/tools/todo';

/**
 * Gives `task:*` subagents their own `todo` tool.
 *
 * OMP drops `todo` from every subagent that is not prewalk-armed, in two
 * places: `isToolAllowed` never builds it for yield-gated sessions
 * (`tools/index.ts`), and the executor strips it from the active set at spawn
 * (`task/executor.ts`, `isParentOwnedTool`). The todo state itself is already
 * per session — each `AgentSession` owns its `TodoTracker`, and the stop-time
 * completion reminder, mid-run nudge, and branch rehydration all key on that
 * session — so a subagent can own a list without touching its parent's.
 *
 * At `before_agent_start` (after the executor's strip), the extension finds
 * its own `AgentSession` through the agent registry and installs a native
 * `TodoTool` bound to that session as a host tool. The tool keeps the name
 * `todo`, so its results persist and rehydrate like the built-in one. Sessions
 * that already have a `todo` (the main agent, prewalk-armed subagents) and
 * agents outside `task:*` are left alone. Any failure only logs a warning.
 */

const TODO_AGENTS: Record<string, true> = {
    'task:high': true,
    'task:mid': true,
    'task:low': true,
    'task:free': true,
};

/** The `task:*` subagent session this extension instance runs in, if any. */
const ownTaskSession = (ctx: ExtensionContext): AgentSession | undefined => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined) return undefined;
    // Task session files are `<artifacts>/<agent-id>.jsonl`; the registry ref carries the agent definition name.
    const ref = AgentRegistry.global()
        .list()
        .find(candidate => candidate.sessionFile === sessionFile);
    if (ref === undefined || !Object.hasOwn(TODO_AGENTS, ref.displayName)) return undefined;
    return ref.session ?? undefined;
};

/**
 * `TodoTool.execute` reads and writes the list only through these three
 * members (`tools/todo.ts`, `execute`), so they are bound to the owning
 * session and nothing else is exposed.
 */
type TodoToolSession = Pick<ToolSession, 'getSessionFile' | 'getTodoPhases' | 'setTodoPhases'>;

const todoToolSession = (session: AgentSession): TodoToolSession => ({
    getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
    getTodoPhases: () => session.getTodoPhases(),
    setTodoPhases: phases => session.setTodoPhases(phases),
});

export default function subagentTodo(pi: ExtensionAPI): void {
    pi.on('before_agent_start', async (_event, ctx) => {
        try {
            const session = ownTaskSession(ctx);
            if (session === undefined) return;
            if (session.getAllToolNames().includes('todo')) return;
            await session.refreshRpcHostTools([new TodoTool(todoToolSession(session))]);
        } catch (error) {
            pi.logger.warn('subagent-todo could not install todo', { error: String(error) });
        }
    });
}
