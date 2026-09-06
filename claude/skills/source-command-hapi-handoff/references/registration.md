# Direct registration procedure

Read `../SKILL.md` first. This command **writes the remote hub database**; it is not a diagnostic probe. Run only after its authorization, native-identity, runner, schema, and deployed-resume gates pass. `CODEX_SID` must already be exported from verified current-session evidence, and the shell must be in that session's actual CWD.

## Supported row contract

The local HAPI checkout provides these source anchors:

- `cli/src/codex/session.ts`: native identity is written as `codexSessionId`.
- `cli/src/codex/runCodex.ts`: bootstrap flavor is lowercase `codex`.
- `shared/src/sessionSummary.ts`: known `codex` resolves only its own native-ID field.
- `hub/src/store/sessions.ts`: newly created sessions keep SQL `machine_id` null, metadata/agent-state versions 1, and inactive initial state.
- `hub/src/store/index.ts`: `sessions` has the insert columns below; additional fields have nullable/default initial values. `machines` has `id` and `namespace`. The `(tag, namespace)` index is not unique.

The procedure checks for duplicate tag **or native identity** in `default`; it does not rewrite an existing record. Metadata `claudeSessionId` is included in duplicate detection to catch legacy imports, not written into the new Codex record. Its transaction recheck prevents two copies of this procedure from importing concurrently, but does not establish a uniqueness constraint for every other hub writer. Serialize registration with other imports of this native thread.

## Command

The local Python process reads credentials without printing them. Remote arguments contain only non-secret session metadata and are shell-quoted with `shlex`; SQL values are bound parameters. SQLite `mode=rw` refuses to create a missing database.

```bash
python3 - <<'PY'
import json, os, pathlib, shlex, socket, sqlite3, subprocess, time, urllib.request, uuid

settings = json.loads((pathlib.Path.home() / '.hapi/settings.json').read_text())
api_url = settings['apiUrl'].rstrip('/')
cli_token = settings['cliApiToken']
machine_id = settings['machineId']
native_id = os.environ['CODEX_SID']
if not all(isinstance(v, str) and v for v in (api_url, cli_token, machine_id, native_id)):
    raise SystemExit('Missing registration input; stopped before SSH')
inputs = json.dumps({'cwd': os.getcwd(), 'host': socket.gethostname(),
                     'machine_id': machine_id, 'native_id': native_id})
remote = r"""
import json, sqlite3, sys, time, uuid
p = json.loads(sys.argv[1])
base = 'file:/var/lib/docker/volumes/hapi_hapi-data/_data/hapi.db'
lookup = '''
    SELECT id FROM sessions WHERE namespace = 'default'
    AND (tag = ? OR json_extract(metadata, '$.codexSessionId') = ?
                OR json_extract(metadata, '$.claudeSessionId') = ?)
    ORDER BY created_at DESC
'''
params = (p['native_id'],) * 3
with sqlite3.connect(base + '?mode=ro', uri=True, timeout=10) as db:
    if not db.execute("SELECT id FROM machines WHERE id=? AND namespace='default'",
                      (p['machine_id'],)).fetchone():
        raise SystemExit('Configured runner not found in default namespace; no insert')
    existing = db.execute(lookup, params).fetchall()
if existing:
    print(json.dumps({'status': 'existing', 'ids': [r[0] for r in existing]}))
    raise SystemExit(0)

with sqlite3.connect(base + '?mode=rw', uri=True, timeout=10) as db:
    db.execute('BEGIN IMMEDIATE')
    existing = db.execute(lookup, params).fetchall()
    if existing:
        print(json.dumps({'status': 'existing', 'ids': [r[0] for r in existing]}))
    else:
        sid = str(uuid.uuid4())
        now = int(time.time() * 1000)
        metadata = {'path': p['cwd'], 'host': p['host'],
                    'machineId': p['machine_id'], 'flavor': 'codex',
                    'codexSessionId': p['native_id']}
        db.execute('''
            INSERT INTO sessions
            (id, tag, namespace, machine_id, created_at, updated_at,
             metadata, metadata_version, agent_state, agent_state_version,
             model, model_reasoning_effort, effort,
             todos, todos_updated_at, active, active_at, seq)
            VALUES (?, ?, 'default', NULL, ?, ?, ?, 1, NULL, 1,
                    NULL, NULL, NULL, NULL, NULL, 0, NULL, 0)
        ''', (sid, p['native_id'], now, now,
                     json.dumps(metadata, separators=(',', ':'))))
        db.commit()
        print(json.dumps({'status': 'inserted', 'ids': [sid]}))
"""
command = 'python3 -c ' + shlex.quote(remote) + ' ' + shlex.quote(inputs)
result = subprocess.run(['ssh', 'root@moat-app1', command],
                        check=False, text=True, capture_output=True)
if result.returncode:
    print(result.stderr, end='')
    raise SystemExit('SSH/SQL failed; establish commit outcome with read-only lookup before retry')
record = json.loads(result.stdout)
for sid in record['ids']:
    print(record['status'] + ' session: ' + sid, flush=True)
    print(api_url + '/sessions/' + sid, flush=True)
if record['status'] == 'existing':
    raise SystemExit(0)

sid = record['ids'][0]
try:
    request = urllib.request.Request(api_url + '/api/auth',
        data=json.dumps({'accessToken': cli_token}).encode(),
        headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.load(response).get('token')
    if not isinstance(token, str) or not token:
        raise RuntimeError('Authentication returned no token')
    request = urllib.request.Request(api_url + '/api/sessions/' + sid,
                                    headers={'authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()
except Exception as exc:
    raise SystemExit('Row inserted, visibility unverified; do not reinsert. ' + str(exc))
print('Hub session GET succeeded; verify web visibility and native resume identity next.')
PY
```

## Interpret the terminal result

- `existing session: <id>`: no import was performed. Report the URL and stop. Multiple IDs reveal duplicate preexisting records; do not choose one to overwrite or delete.
- `inserted session: <id>` followed by successful hub GET: the row committed and the API read completed. Check the web session list before claiming visibility; a successful GET is not proof of successful Resume.
- SSH/SQL failure or unreadable output: stop and preserve the exact diagnostic. The commit may have occurred before transport loss; run only the read-only duplicate lookup to establish the outcome before another insertion attempt.
- `Row inserted, visibility unverified`: keep the printed ID, diagnose auth/cache-read failure, and retry only that read stage after resolution. Never import a second row to repair visibility.

Do not print credentials, mutate the transcript, delete a row as automatic rollback, or resume the native thread while its existing writer is still running without an explicit ownership handoff.
