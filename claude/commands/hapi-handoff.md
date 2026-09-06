---
description: Register this Claude Code session with remote hapi hub so it can be resumed from the web app
---

Goal: insert a row directly into hapi hub's SQLite (on `moat-app1`) so this currently-running Claude Code session becomes "resumable" in the hapi web/PWA at https://hapi.237575.xyz. Then warm the in-memory cache so it shows up in the session list immediately.

Do every step yourself with the Bash tool. Stop and report on any failure — do not retry blindly.

## Inputs to gather

1. `CWD` = `pwd`
2. `HOST` = `hostname`
3. `CLAUDE_SID` = newest `*.jsonl` file basename (without extension) in `~/.claude/projects/<ENCODED_CWD>/`, where `<ENCODED_CWD>` is `CWD` with every `/` replaced by `-` (and the leading `/` becomes a leading `-`). One-liner:
   ```bash
   ENCODED_CWD=$(pwd | sed 's|/|-|g')
   CLAUDE_SID=$(ls -t ~/.claude/projects/"$ENCODED_CWD"/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)
   ```
   If empty → abort and tell the user the project dir wasn't found.
4. From `~/.hapi/settings.json` (use `jq`):
   - `API_URL` = `.apiUrl`
   - `MACHINE_ID` = `.machineId`
   - `CLI_TOKEN` = `.cliApiToken`

## Step 1 — check for an existing imported row, abort if it's there

```bash
ssh root@moat-app1 "python3 -c \"import sqlite3
c = sqlite3.connect('file:/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db?mode=ro', uri=True)
r = c.execute('SELECT id FROM sessions WHERE tag=? AND namespace=?', ('$CLAUDE_SID','default')).fetchone()
print(r[0] if r else '')\""
```

If the result is non-empty: print the existing session id and the URL `${API_URL}/sessions/<id>`, then stop. Don't insert again.

## Step 2 — insert the row

Use `python3` over SSH (no `sqlite3` CLI on host, no `bun`/`better-sqlite3` in the container). Pass dynamic values via env, not f-string interpolation:

```bash
ssh root@moat-app1 "CWD='$CWD' HOST='$HOST' MACHINE_ID='$MACHINE_ID' CLAUDE_SID='$CLAUDE_SID' python3 - <<'PY'
import sqlite3, json, time, uuid, os
md = {
    'path': os.environ['CWD'],
    'host': os.environ['HOST'],
    'machineId': os.environ['MACHINE_ID'],
    'flavor': 'claude',
    'claudeSessionId': os.environ['CLAUDE_SID'],
}
sid = str(uuid.uuid4())
now = int(time.time() * 1000)
db = sqlite3.connect('/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db', timeout=10)
db.execute('''INSERT INTO sessions
    (id, tag, namespace, machine_id, created_at, updated_at,
     metadata, metadata_version, agent_state, agent_state_version,
     model, model_reasoning_effort, effort,
     todos, todos_updated_at, active, active_at, seq)
    VALUES (?, ?, 'default', NULL, ?, ?, ?, 1, NULL, 1,
            NULL, NULL, NULL, NULL, NULL, 0, NULL, 0)''',
    (sid, os.environ['CLAUDE_SID'], now, now, json.dumps(md, separators=(',',':'))))
db.commit()
print(sid)
PY"
```

Capture the printed UUID as `NEW_SID`. If empty or python printed an error: abort.

## Step 3 — warm hub cache

```bash
JWT=$(curl -fsS -X POST "${API_URL}/api/auth" \
  -H 'content-type: application/json' \
  -d "{\"accessToken\":\"$CLI_TOKEN\"}" | jq -r .token)

curl -fsS "${API_URL}/api/sessions/${NEW_SID}" \
  -H "authorization: Bearer $JWT" >/dev/null
```

If `JWT` is empty/`null`: abort, the access token isn't being accepted.

## Output

Tell the user:

- Inserted session id: `<NEW_SID>`
- Resumable at: `${API_URL}/sessions/<NEW_SID>`
- Reminder: closing this Claude Code window won't kill the JSONL. Click Resume in the web app to spawn `claude --resume <CLAUDE_SID>` on this Mac (the runner is local).

## Constraints

- Do not modify any hapi source code.
- Do not create new CLI subcommands or HTTP endpoints.
- Do not write to the local `~/.hapi/hapi.db` — the live hub is on `moat-app1`.
- Do not install packages on `moat-app1` (`python3` is enough, no `apt install sqlite3` etc.).
- If `ssh root@moat-app1` fails: stop, report the SSH error, do not try alternate hosts.
