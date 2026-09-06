---
name: hapi-session-finder
description: Find HAPI history by title, identify its runner and agent flavor, then locate Claude or Codex JSONL or an explicitly recorded OMP session file. Unknown or conflicting profiles require inspection, not a guessed Claude layout.
---

# Find HAPI session history

This is a **read-only lookup**, not a send, spawn, resume, or registration operation. Use `skill://hapi-send-msg` to continue an active session, `skill://hapi-open-session` for a new one, and `skill://source-command-hapi-handoff` only for authorized registration of the current Codex session.

## Hub access and query

The documented hub is `hapi-hub` on `moat-app1`, with container DB `/root/.hapi/hapi.db` in Docker volume `hapi_hapi-data`. Its host-side DB path is `/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db`. Confirm that placement through `skill://internal-services` / `skill://iac-projects` and the owning repo before relying on it; do not probe alternate hosts or create a missing database.

The established SSH path uses the Bitwarden SSH agent (`hb.lan` key):

```bash
ssh -F /dev/null -o ConnectTimeout=5 root@moat-app1.hb.lan \
  'test -f /var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db && python3 -' <<'PY'
import sqlite3
uri = 'file:/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db?mode=ro'
with sqlite3.connect(uri, uri=True, timeout=10) as db:
    print(db.execute('PRAGMA table_info(sessions)').fetchall())
PY
```

Stop on SSH, missing-file, or schema failure. The query below needs `id`, `tag`, `namespace`, `metadata`, `created_at`, `model`, `effort`, and `active`. Read the live database with SQLite `mode=ro`, which respects its WAL; **do not copy only `hapi.db` out of a running WAL database** and assume the snapshot is complete. No remote scratch DB or cleanup is needed with this path.

Replace the Python `search` literal with the title keyword (escape it as Python text; do not interpolate it into SQL):

```bash
ssh -F /dev/null -o ConnectTimeout=5 root@moat-app1.hb.lan 'python3 -' <<'PY'
import json, sqlite3
search = 'title keyword'
uri = 'file:/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db?mode=ro'
with sqlite3.connect(uri, uri=True, timeout=10) as db:
    db.row_factory = sqlite3.Row
    rows = db.execute('''
        SELECT id AS hapi_id, tag, namespace,
               json_extract(metadata, '$.summary.text') AS title,
               json_extract(metadata, '$.host') AS host,
               json_extract(metadata, '$.path') AS cwd,
               json_extract(metadata, '$.flavor') AS flavor,
               json_extract(metadata, '$.claudeSessionId') AS claude_id,
               json_extract(metadata, '$.codexSessionId') AS codex_id,
               json_extract(metadata, '$.codexSourceSessionId') AS codex_source_id,
               json_extract(metadata, '$.ompSession.id') AS omp_id,
               json_extract(metadata, '$.ompSession.file') AS omp_file,
               json_extract(metadata, '$.version') AS agent_version,
               datetime(created_at/1000, 'unixepoch') AS created_utc,
               model, effort, active
        FROM sessions
        WHERE json_extract(metadata, '$.summary.text') LIKE ?
        ORDER BY created_at DESC
        LIMIT 21
    ''', ('%' + search + '%',)).fetchall()
    print(json.dumps({'matches': [dict(r) for r in rows[:20]],
                      'more_matches': len(rows) > 20}, ensure_ascii=False, indent=2))
PY
```

This searches `metadata.summary.text`, not every name/path field. SQL `LIKE` treats `%` and `_` as wildcards. Empty results warrant a broader title query or checking the web UI at https://hapi.237575.xyz; they do not prove no history exists. `more_matches: true` means narrow the query rather than present the first 20 as exhaustive. `created_utc` is UTC.

## Select the native history profile

Keep **HAPI ID**, **native agent ID**, and **runner hostname** distinct. The CLI using this skill does not determine the target's agent type.

| Stored profile | Identity and history location |
|---|---|
| `flavor = claude` | `claudeSessionId`; runner `~/.claude/projects/<actual-project-directory>/<id>.jsonl`. |
| `flavor = codex` | `codexSessionId`; runner `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. An index entry may supply a path. `codexSourceSessionId` is the original thread when HAPI has forked a continuation; do not substitute it for the current thread. |
| `flavor = omp` | `ompSession.id` and explicitly recorded `ompSession.file`; use that file on the recorded runner, not a Claude or Codex path. |
| Missing/unknown flavor or inconsistent IDs | Inspect native file metadata and the matching HAPI version before choosing a profile. A field named `claudeSessionId` alone does not prove Claude: imported Codex records can use that legacy key. |
| Other known flavor | This guide has no verified filesystem layout for it. Report the hub match and stop file-location work until the actual runner/profile contract is established. |

Current local HAPI source maps Claude and Codex to separate fields (`shared/src/sessionSummary.ts` and `cli/src/{claude,codex}/session.ts` in `/Users/mouriya/Ext/code/hapi`). It resolves OMP's native ID from `ompSession.id`; its schema requires an explicit file. These facts are not proof that the live hub runs that checkout.

## Locate and verify on the runner

First establish which machine and user home own the record. If the runner is not this machine, say so and use its verified connection; do not search this Mac and conclude the remote history is missing.

**Claude:** locate the exact native-ID filename under `~/.claude/projects/*/`. Do not derive the directory from the repo basename. For example this Mac has `~/.claude/projects/-Users-mouriya-Ext-code-hapi/`, not simply `hapi`. Use a glob/search tool, then inspect the matching JSONL's session identity/CWD before reading task content.

**Codex:** search `~/.codex/session_index.jsonl` for the exact native ID. Use a path only if the matching entry actually contains a session-file path; index formats can omit CWD/path. Otherwise locate `~/.codex/sessions/*/*/*/rollout-*<native-id>*.jsonl`. Read its `session_meta` record and match `payload.id` and `payload.cwd`; a recent filename alone is not identity evidence. If multiple candidates exist, resolve the identity rather than choosing newest.

**OMP:** check existence/readability of the recorded `omp_file` on its runner and match the native session identity in that file. Missing path or conflicting identity is a stop, not permission to guess a standard directory.

The hub `messages` table can provide hub-visible message content, but runner JSONL contains native tool/output context that may not be represented there. Treat both as private session data; read only what the user's lookup requires.

## Result

Return a table with title, flavor, runner, CWD, creation time (UTC), full HAPI ID, native ID, and **verified** history path. Mark unresolved paths explicitly and state the missing fact (profile, host access, file, or identity), rather than fabricate a location. Finding a file is not authorization to resume, message, import, or mutate its session.
