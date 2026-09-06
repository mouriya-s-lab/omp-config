---
name: km-api
description: >-
  Direct Komodo REST requests only for CLI gaps: version-matched /read, /write or /execute payloads, resource IDs and endpoint-helper credentials. Use for missing commands/fields, not to bypass repo-backed declarations or IaC ownership.
allowed-tools: Bash, Read
---

# Komodo REST API for CLI gaps

Prefer an existing `km -p <core>` command: it handles authentication and errors. Use REST when the CLI lacks the required operation, field or resource detail. `skill://container-management` owns target routing; `skill://km-endpoints` owns connections and the credential-helper contract.

## Establish operation and authority

1. Inspect installed CLI help for the requested operation before choosing REST. A JSON request is not inherently preferable to a supported CLI command.
2. Establish the Core and resource owner. For repo-backed Stacks, change `komodo/syncs/` and `stacks/` in the owning workload repo and use its ResourceSync workflow. The API is for inspection, authorized bounded runtime operations or a declared workflow's integration—not a second declaration store. Legacy file_contents resources still have an owning IaC/control-plane repo.
3. Determine the live Core version with `GetVersion`, then consult the matching schema at the [Komodo documentation](https://komo.do/docs) or a local checkout. Verify request type, params and response shape before writing a payload. Do not invent type names or copy a create/update config from another version.
4. Read current resource state and resolve IDs **on this Core**. For example, `ListServers` supplies Server IDs; confirm the target's name/host before using its ID in a Stack operation. Never reuse IDs across Cores.

## Make a read-only request

The helper requires Python 3.11+ and emits the fixed, shell-escaped Bash `NAME`, `HOST`, `KEY`, `SECRET` assignments described in `km-endpoints`. Values are encoded as literal data, not shell commands. Capture only this trusted local helper's output with tracing disabled, stop on failure and consume it in the explicit Bash subshell below. Do not display helper output or reuse stale variables from another Core.

```bash
bash <<'BASH'
(
  set +x
  endpoint_fields=$(bash ~/.claude/skills/km-endpoints/bin/show.sh homelab) || exit
  eval "$endpoint_fields" || exit
  curl --silent --show-error --fail-with-body -X POST "$HOST/read" \
    -H 'Content-Type: application/json' \
    -H "x-api-key: $KEY" \
    -H "x-api-secret: $SECRET" \
    -d '{"type":"GetVersion","params":{}}'
)
BASH
```

For trading, select `trading` in that same request shell; there is no active endpoint. After establishing the version, use the same scoped request with `{"type":"ListServers","params":{}}` to obtain the inventory. Response data may contain sensitive configuration in other read operations: capture it privately and report only necessary nonsecret fields. Do not enable verbose curl or shell tracing.

## Request shape and mutation workflow

Each endpoint accepts an envelope with `type` and `params`:

| Path | Purpose | Completion evidence |
|---|---|---|
| `/read` | Query/version/resource details | Successful response with the intended Core/resource |
| `/write` | Create/update/delete a resource or value | Response plus read-back against the authorized desired state |
| `/execute` | Start a lifecycle/orchestration action | Terminal execution result, resulting resource state and runtime effects |

For a genuine CLI gap, prepare a JSON request file against the version-matched schema, inspect its diff/impact against current state and obtain any required destructive authorization. `CreateStack` is not a shortcut around workload onboarding or declaration ownership. Do not assume a Compose file array is the schema for a field named `file_contents`.

Use the same credential-scoped request pattern above, replacing the path with the verified endpoint and using `--data-binary @"$request_file"` for the reviewed payload. Keep secrets out of payloads unless the authorized secret-injection path specifically requires them; such files must remain private and be cleaned up through that path. Do not construct a transcript-visible command containing a secret value.

A supported CLI operation remains preferred even for Variables. For an authorized **nonsecret** value whose workflow permits a live update:

```bash
# core, variable and value are established by the owning workflow.
km -p "$core" update variable "$variable" "$value"
```

For durable workload Variables/secrets, follow the owning repo's sync workflow rather than hand-maintaining values through either interface.

## Verify and recover

- Check transport/HTTP errors and the API response body; HTTP success alone does not establish a successful action. For writes, read back the exact resource. For executions, follow the returned update/reference to a terminal result and verify the final behavior.
- A timeout can occur after acceptance. Read current state/execution history before retrying a create or destructive action; do not duplicate mutations blindly.
- A missing endpoint or authentication failure goes to `km-endpoints` and the authorized credential source. A schema rejection requires checking the actual version/schema, not trying guessed fields. A failed deploy/sync uses `km-stack`/`km-gitops` recovery and declaration authority.
- If a required schema or authorized credential path cannot be established, stop the mutation and report that specific gap. API access does not grant permission to alter host placement, networking, storage or Core provisioning outside IaC.
