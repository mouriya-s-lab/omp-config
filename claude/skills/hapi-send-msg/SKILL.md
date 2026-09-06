---
name: hapi-send-msg
description: Resolve an existing active HAPI session and send a message now or queue it for an explicit future date-time. Use for continuing a session outside HAPI; not for creating sessions or finding archived runner transcripts.
---

# Message an existing HAPI session

Use the installed `hapi-send-msg` CLI for the same message path as the web UI. New sessions belong to `skill://hapi-open-session`; historical files to `skill://hapi-session-finder`. Inside HAPI, use `skill://hapi-agent` for scoped orchestration rather than rebuilding its authentication and permission flow.

## Resolve before sending

```bash
hapi-send-msg coder-loop --find
hapi-send-msg '<full-id-from-output>' '继续'
```

`SESSION` accepts a full UUID or a case-insensitive substring of ID, `metadata.name`, `metadata.path`, or `metadata.summary.text`. When any active sessions exist, **only that active pool is searched**; this is not an active-first search followed by an inactive fallback. If none are active, the helper searches the returned list but still rejects an inactive target, including with `--find`.

A unique match resolves automatically. Multiple matches print candidate IDs/labels and exit 1; choose the intended full ID rather than guessing. `--find` authenticates and queries HAPI, prints `session: <id>` and a label, but sends nothing.

Message text can be positional, `-m`/`--message`, or stdin when omitted. An explicit `--message` wins over positional text; no message or empty text is rejected.

```bash
printf '%s' '继续检查失败的测试，不要部署' | hapi-send-msg '<full-id-from-output>'
```

## Schedule once at an explicit time

```bash
hapi-send-msg '<full-id-from-output>' '继续' --at "$FUTURE_RFC3339" --dry-run
hapi-send-msg '<full-id-from-output>' '继续' --at "$FUTURE_RFC3339"
```

Set `FUTURE_RFC3339` to the user's intended future date-time, for example the shape `YYYY-MM-DDTHH:MM:SS+09:00`, not that literal placeholder. Use a full date and time (a space separator is also accepted):

- `Z`, `+HH:MM`, or `-HH:MM` uses the stated zone.
- Without a zone, the CLI uses **its host's local timezone**, not UTC or the runner's timezone. Prefer an explicit offset when the user and CLI host differ.
- The resolved instant must be **more than 3 seconds** ahead and at most 7 days ahead. Leave enough margin for authentication/network latency.
- Do not use `+10m`, `6am`, `today`, `tomorrow`, JSON, or epoch numbers. The implementation parses with Python `datetime.fromisoformat`; the documented interface is a full date-time, not natural-language scheduling.

The CLI creates a fresh UUID `localId` and posts `{text, localId, scheduledAt}` with milliseconds since epoch. The hub queues the message for that time, rather than delivering it to the agent immediately. `scheduled:` in output confirms submission, **not on-time execution or an agent response**. Queue consumption must be observed separately; do not promise exact wall-clock execution.

Cancel queued messages in the web UI; the installed CLI has no cancellation option. Do not attempt cancellation by changing `scheduledAt`: a matured timestamp is eligible for immediate delivery. `sentFrom` is set by the hub, not spoofed by the helper.

## Configuration and offline preview

The helper reads `~/.hapi/settings.json`, or `--settings PATH`, even for dry-run. URL precedence: `HAPI_API_URL`, settings `apiUrl`, settings `serverUrl`. Token precedence: `CLI_API_TOKEN`, settings `cliApiToken`. It authenticates at `POST /api/auth`, lists sessions, and posts to `/api/sessions/{id}/messages`. Missing configuration is a credential/tooling-path problem; do not expose tokens or request a pasted replacement.

`--dry-run` makes **no HAPI calls** and does **not resolve the session**. Its output is labeled text, not JSON: `api_url`, `session_query`, `message`, `scheduled_at`, and (when scheduled) `local_id`. It checks local configuration/message/time parsing only. Use `--find` separately when authorized to inspect the live target.

## Output and failure boundaries

Success prints the full `session:` and label followed by `sent`, or `scheduled: <host-local time> (localId=...)`. Record the target and, for scheduling, intended offset/instant and printed `localId`.

HTTP/transport, ambiguous-target, inactive-target, and input errors print `error: ...` and exit 1. Only active sessions accept messages; this command does not resume an inactive session. If delivery outcome is uncertain, inspect the target/queue before retrying: immediate sends have no supplied `localId`, and scheduled retries generate a **new** one, so neither is a safe blind retry. Report the exact failure, not a claim that the agent received or executed the message.
