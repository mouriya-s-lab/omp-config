---
name: km-endpoints
description: >-
  Maintain the local Komodo Core endpoint inventory and render named CLI profiles; list connections or supply credentials to km-api. No active endpoint: every km command uses -p. Use for missing profiles, new Cores, endpoint changes and concurrent Core access.
allowed-tools: Bash, Read, Write, Edit, Glob
---

# Komodo endpoint inventory

This skill owns connection inventory, not service lifecycle operations. Use `skill://container-management` for those.

## Files and authority

Helpers below are relative to the installed `~/.claude/skills/km-endpoints/` skill. The sole endpoint inventory is `${XDG_CONFIG_HOME:-$HOME/.config}/komodo/endpoints`, outside all skill installation directories. All three helpers use that location directly; there is no fallback inventory inside the installed package. The generated CLI config remains `~/.config/komodo/komodo.cli.toml`.

| Path | Contract |
|---|---|
| `${XDG_CONFIG_HOME:-$HOME/.config}/komodo/endpoints/<name>.toml` | Durable private local connection inventory; `host`, `key`, `secret` fields, one file per Core |
| `bin/list.sh` | Prints endpoint name and host, never key/secret; fails when inventory is empty |
| `bin/show.sh <name>` | Prints fixed, shell-escaped Bash `NAME`, `HOST`, `KEY`, `SECRET` assignments for one endpoint; requires Python 3.11+ and rejects invalid TOML or missing/empty/nonstring/NUL-containing required fields |
| `bin/render-config.sh` | Sole writer of `~/.config/komodo/komodo.cli.toml`; emits one named profile per endpoint |

The endpoint inventory is **not automatically synced from IaC**. Register only a Core actually declared by the owning IaC change: homelab Core inventory is in `homelab-tf`'s `komodo_core_hosts`. Resolve host and credentials from that change's authorized secret source (for example `homelab-tf/_shared/ansible/secrets.yml`), not from the user's clipboard. Do not create a speculative connection or embed secrets in Markdown/committed code. Keep the external endpoint directory private (mode `0700`, endpoint files `0600`), outside repositories and npx-managed skill payloads. Installing or updating the skill does not migrate, populate or overwrite this inventory.

Known routing: `homelab` is moat-app1 / VM 110; `trading` is trading-agent / VM 130. Keycloak/Forgejo belong to pve-vctcn on vctcn-app1 / VM 180, not these Cores. Inventory and IaC are the authorities when adding or removing connections.

## List and select

```bash
bash ~/.claude/skills/km-endpoints/bin/list.sh
km -p homelab config
km -p trading config
```

`km config` is sanitized by default; do not add `--unsanitized` in captured output. Every real command passes `-p <name>` **before the command**. There is no global selection to change, so concurrent shells can use different Cores without rewriting configuration. The generated `default_profile` is the first sorted endpoint and is only a CLI fallback, not target-selection policy.

## Add, change or remove a connection

1. Identify the owning IaC change and its actual Core/credential source. Use `skill://iac-projects` if ownership is unclear. If the Core does not exist yet, route provisioning there rather than registering an imagined endpoint.
2. Edit the corresponding `${XDG_CONFIG_HOME:-$HOME/.config}/komodo/endpoints/<name>.toml` through the authorized credential path. Its filename becomes the profile name. Remove an endpoint only when its retirement is established; check consumers before removing their connection.
3. Render after inventory changes:

   ```bash
   bash ~/.claude/skills/km-endpoints/bin/render-config.sh
   ```

4. Expect a profile-name list, then inspect the selected sanitized config and make a read-only connection check:

   ```bash
   core=homelab  # replace with the endpoint just maintained
   km -p "$core" config
   km -p "$core" ls servers
   ```

A successful render proves local generation, not authentication or reachability. The Server listing must come from the intended Core.

The renderer checks that each file contains `host`, `key` and `secret` assignment lines; this is **not full TOML or nonempty-value validation**. It writes a temporary sibling and replaces the config only after generation succeeds. Empty inventory or missing key lines fail without replacing the existing config. Repair the inventory and rerender; never patch the generated output to hide the failure.

## Supply REST credentials without displaying them

`skill://km-api` consumes `show.sh`; ordinary CLI calls consume the rendered profiles. The helper emits secrets, so capture its output within the request shell, with shell tracing disabled, rather than invoking it as a visible standalone tool call.

```bash
bash <<'BASH'
(
  set +x
  endpoint_fields=$(bash ~/.claude/skills/km-endpoints/bin/show.sh homelab) || exit
  eval "$endpoint_fields" || exit
  # Use HOST / KEY / SECRET here for the scoped API request; do not echo them.
)
BASH
```

The helper requires **Python 3.11+** on `PATH`, using stdlib `tomllib` to decode TOML strings and `shlex.quote` to encode each assignment value safely for Bash. It emits only the fixed `NAME`, `HOST`, `KEY`, `SECRET` assignments after all required fields pass validation. Quotes, whitespace, shell metacharacters and embedded/trailing newlines remain literal data; NUL is rejected because Bash variables cannot represent it. No manual judgment of whether credentials are shell-safe is needed. Parsing errors report no TOML source text, and there is no unescaped output mode.

Use this trusted local helper as the only source of evaluated assignments; never evaluate an arbitrary file or response. Run the example explicitly in Bash, keep tracing disabled and check both capture and evaluation before any request. The subshell keeps credentials scoped and prevents accidental reuse for another Core. Encoding preserves data; it does not make unsupported HTTP header characters valid for the downstream API.

## Recovery

- **Missing profile:** list endpoint names first. If the endpoint exists, rerender; if it does not, resolve the IaC registration/credential gap. Do not switch to a different Core merely to make a command run.
- **`show.sh` failure:** establish Python 3.11+ availability or correct the explicit name/TOML/required fields through the authorized source; no request should proceed with stale variables. Do not print the file or parser source diagnostics.
- **Authentication/connectivity failure after rendering:** verify the selected sanitized host and owning IaC/secret path. Rendering cannot repair a network or credential problem; do not ask the user to paste keys.
