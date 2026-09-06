---
name: source-command-hapi-handoff
description: Register the current native Codex session in the remote HAPI hub for later web resume. This is an explicitly authorized direct database mutation, not a new-session launcher or a generic OMP/Claude handoff.
---

# Register the current Codex session with HAPI

Use for the migrated source command `hapi-handoff`: create an inactive hub record for **this native Codex session**, then load it through the hub API so it can appear in https://hapi.237575.xyz. This guide supplies a manual procedure, not an installed `hapi-handoff` executable.

For a new external session use `skill://hapi-open-session`; for messaging use `skill://hapi-send-msg`; for historical identification use `skill://hapi-session-finder`. Merely loading this skill from OMP does not make the current process a Codex session.

## Authorization and stop boundaries

This bypasses the hub's application write path and directly changes production SQLite. Execute only when the user explicitly requests registration, the **current Codex identity is proven**, and the owning infrastructure context permits that DB mutation. Load `skill://iac-projects` and `skill://iac-issue-routing` and the owning repo's rules first. A request to inspect history or hand work to a new agent is not permission to import a row.

The documented target is `root@moat-app1`, DB `/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db`. Confirm live placement, deployed schema, native resume contract, namespace and local runner identity before mutation. Do not write `~/.hapi/hapi.db`, try alternate hosts after SSH failure, install packages, edit HAPI source, or create CLI commands/endpoints. Stop on any failure; never rerun an uncertain insertion blindly.

## Establish inputs without exposing credentials

- `CWD`: actual working directory of the Codex session; `HOST`: its runner's hostname.
- `CODEX_SID`: the current native Codex thread ID, **not** a HAPI UUID or OMP session ID.
- Settings `~/.hapi/settings.json`: `apiUrl`, `machineId`, `cliApiToken`. This procedure uses these fields directly, not the opener/sender CLI's environment-override rules. Keep token/JWT out of output.

Prefer explicit identity from the current Codex runtime. `~/.codex/session_index.jsonl` can locate candidates by `cwd`/`path` and `session_id`/`id`/`rollout_id`, but only if those fields actually exist. “Newest matching CWD” is not proof: multiple sessions and subagents can share a directory. Locate its rollout under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and confirm `session_meta.payload.id`, `payload.cwd`, and that it is the intended current thread. If the index is unavailable, use rollout metadata directly; do not use the newest file globally. Ambiguous or missing current identity means stop before SSH mutation.

Export the **verified** `CODEX_SID` for the registration procedure; it is not a secret. Verify that settings `machineId` belongs to this runner and the target `default` namespace. A different namespace requires its actual supported contract, not substitution into this template.

## Read-only preflight

```bash
ssh root@moat-app1 \
  'test -f /var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db && python3 -' <<'PY'
import sqlite3
uri = 'file:/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db?mode=ro'
with sqlite3.connect(uri, uri=True, timeout=10) as db:
    print('sessions:', db.execute('PRAGMA table_info(sessions)').fetchall())
    print('machines:', db.execute('PRAGMA table_info(machines)').fetchall())
    print('session indexes:', db.execute('PRAGMA index_list(sessions)').fetchall())
PY
```

The supported insertion contract is documented in [references/registration.md](references/registration.md): lowercase `flavor: codex`, `codexSessionId`, metadata `machineId`, inactive state, and no SQL `machine_id` assignment. Confirm the deployed runner uses `codexSessionId` for resume, not merely that the column names exist. The local checkout `/Users/mouriya/Ext/code/hapi` establishes this shape in `cli/src/codex/session.ts`, `shared/src/sessionSummary.ts`, and `hub/src/store/{index,sessions}.ts`; it does **not** establish the deployed version.

If live columns/defaults or resume semantics differ, report the exact incompatibility and stop. Do not repair the live schema to make this guide work.

## Register, verify, and report

After those gates, follow [the registration procedure](references/registration.md). It checks existing native identity in `default` before insertion and again under a SQLite write transaction. An existing row returns its HAPI ID/URL and stops without importing again. The tag index is not unique in the local schema; do not run parallel imports or treat a preflight query alone as duplicate protection against other writers.

A successful insert is followed by `POST /api/auth` and `GET /api/sessions/<new-id>`. Report the actual HAPI ID and `${API_URL}/sessions/<id>`. If cache warming fails, the row **still exists**: report “inserted, visibility unverified” with its ID; diagnose authentication/cache read, not another insert.

Finally verify the record appears in the web session list and has the expected native ID, runner, directory, and inactive/resumable state. Registration is not proof that Resume succeeds. When the user actually wants to resume, use the verified runner contract and observe the resumed thread; avoid running two writers against the same native transcript. The local JSONL persists independently of the current terminal, but it must remain available on the runner for later resume.
