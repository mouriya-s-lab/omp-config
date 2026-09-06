---
name: hapi-open-session
description: Open a new external HAPI session for a file/directory and send its first prompt, optionally choosing worktree/simple mode, agent, model preset, or reasoning effort. For an existing session use hapi-send-msg; for scoped orchestration inside HAPI use hapi-agent.
allowed-tools: Bash
---

# Open a new HAPI session

Use the installed `hapi-open-session` CLI when the user wants a **separate** session. This creates a session and sends work; it does not register the current session (see `skill://source-command-hapi-handoff`) or retrieve historical transcripts (`skill://hapi-session-finder`). Inside a HAPI session, scoped child orchestration belongs to `skill://hapi-agent`.

## Path, prompt, and defaults

```bash
hapi-open-session /Users/mouriya/Ext/code/project --dry-run
hapi-open-session /Users/mouriya/Ext/code/project --prompt '检查这个仓库的测试入口'
```

Use an existing absolute path. The CLI resolves it locally: a directory is the session directory; a file uses its parent. The same path must be accessible on the selected runner; the helper does not upload files or map local paths to remote paths.

Without `--prompt`, it sends `阅读 <resolved-path> 路径的文件`. With `--prompt`, it sends that text verbatim instead; `--prompt-template` is ignored in that mode.

Defaults are Codex, **yolo enabled**, and a `worktree` session with no `worktreeName` supplied (HAPI chooses the name). Use `--no-yolo` when unrestricted execution is not authorized. Choose `--session-type simple` only when the user needs a non-worktree session; do not change agent or isolation merely to bypass a failure.

## Configuration and machine selection

The CLI reads `~/.hapi/settings.json` (override with `--settings PATH`) before doing anything, including dry-run. URL precedence is `HAPI_API_URL`, then settings `apiUrl`, then `serverUrl`; token precedence is `CLI_API_TOKEN`, then `cliApiToken`. Use the existing credential path; never print tokens or ask the user to paste one to work around broken configuration.

It authenticates through `POST /api/auth` and lists machines. Only active machines are eligible:

1. `--machine-id`, or settings `machineId`, is a **preference**, not a hard pin. It wins if active and either has no advertised workspace roots or has a root containing the session directory.
2. Otherwise the first active machine advertising a containing workspace root wins.
3. No eligible machine produces an error; no machine is spawned by this helper.

`--dry-run` prints a JSON plan with resolved paths, preferred machine ID, prompt, agent, model, permissions, and session type. It makes **no HAPI calls**: it cannot confirm machine choice, reachability, model availability, or worktree support. Do not treat `preferredMachineId` as the selected machine.

## Model selection

`--model` overrides HAPI's default; accepted values depend on `--agent`:

| Agent | Model contract |
|---|---|
| `claude` | Preset aliases `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]`; not full Anthropic IDs. Quote bracketed values. |
| `gemini` | Presets `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. |
| `codex`, `opencode`, `cursor`, `kimi` | Forwarded verbatim; HAPI validates against the runner. |

`--reasoning-effort VALUE` is forwarded as `modelReasoningEffort`; it is not locally validated.

```bash
hapi-open-session /Users/mouriya/Ext/code/project \
  --agent claude --model 'opus[1m]' --no-yolo \
  --prompt '深入分析这个仓库的架构'
```

## Observe completion and recover without duplicating work

The real command prints the selected `machine:`, directory and options, then `session: <id>` after spawn. It waits for `active: True` (90 seconds by default; `--wait-active-timeout` changes this), sends the prompt, and prints `sent`.

Report the actual full session ID and whether the prompt was sent. A printed session ID alone proves creation, not delivery or task completion. Errors are printed as `error: ...` and exit 1; retain the exact error without exposing credentials.

If activation or message delivery fails **after** `session:` was printed, the session may already exist. Inspect that session before retrying; do not rerun the opener blindly and create another worktree. Continue an existing active session through `skill://hapi-send-msg`. If no ID was returned, do not invent one; resolve any uncertain spawn outcome before another create attempt.
