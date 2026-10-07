# OMP Configuration Coding Standards

Read this file only when changing implementation code, structured configuration, or custom agent definitions under the active OMP agent directory. Do not load it for unrelated work. The active directory is runtime configuration, not a full backup; databases, sessions, caches, logs, and credentials are outside this document's scope.

## Extensions (`extensions/*.ts`)

- Name files in lowercase kebab-case; use a camelCase default-exported function matching the filename.
- Export a `(pi: ExtensionAPI) => void` extension. Register tools or commands with the API, or subscribe to hooks; do not add a wrapper for hook-only extensions.
- Preserve lifecycle semantics: `context` fires for each model call, including wakes of idle or parked agents; `before_agent_start` does not.
- Extension-authored user messages must pass `attribution: "agent"`; the default `user` attribution is treated as human input by `user-prompt-inject.ts`.
- Import only host-supported `@oh-my-pi` packages: `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-natives`, `pi-tui`, and `pi-utils`. Node built-ins and Web APIs are available.
- Every helper session created with `createAgentSession` must set `taskDepth: 1`. Without it, disposal can tear down the shared lifecycle manager and orphan idle subagents.
- Handle hook and tool read failures defensively. Validate untrusted inputs at the boundary with the host schema API; preserve structured model or provider errors without leaking secrets.
- Keep transient state in the extension or session. Persist durable session state through session custom entries.
- Process-wide patches must be idempotent and narrowly matched. Existing fetch and timeout wrappers use `Symbol.for` guards; do not add a second wrapper or broaden their match.
- Preserve the edited file's local style. There is no formatter and existing files are not uniform.

## Custom agent definitions (`agents/*.md`)

- Frontmatter uses `name`, `description`, and `spawns`. Model binding belongs in `config.yml`, not the definition.
- Prefer explicit `spawns` allowlists; the first entry is the default for an omitted `agent`. Check `task.disabledAgents` before allowing a name.
- Before changing a definition, read `agents/README.txt`. It records dispatch defaults, disabled agents, recursion limits, yield-loss behavior, discovery ordering, and parse-failure handling.
- Keep ordinary notes as `.txt`. Every `.md` in `agents/` is treated as an agent candidate.

## Structured configuration

- Edit only the fields required by the task. Do not reserialize whole YAML or JSON files.
- Keep agent definitions and their `config.yml` model bindings consistent.
- Never print, move, or commit credentials. Do not edit runtime databases, WAL files, sessions, caches, or logs as configuration.
- Do not overwrite app-managed extensions marked `@orca-managed-pi-extension` or `marker: _otty`.

## Verification

- Parse-check changed YAML with `Bun.YAML.parse` and changed JSON with `JSON.parse`.
- Agent-definition edits apply to the next spawn. Verify discovery by dispatching the changed agent after the edit.
- Extension and `APPEND_SYSTEM.md` changes require a new OMP process before runtime behavior can be exercised. Do not restart the current process unless the user explicitly authorizes it.
- Parse-clean configuration is not runtime proof. Exercise the changed hook, tool, command, or agent path before claiming behavior is verified; otherwise report the boundary.
