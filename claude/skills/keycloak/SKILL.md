---
name: keycloak
description: Guide vctcn-owned Keycloak SSO/OIDC/SAML integration, realms, clients, users, and protocol mappers. Includes read-only Admin REST inspection; durable changes are IaC-first. Use internal-services for global inventory.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch, mcp__ssh-manager__ssh_execute
---

# Keycloak SSO integration

## Authority and realm selection

Use these current checkout sources before acting on placement or configuration:

- `/Users/mouriya/Ext/code/pve-vctcn/apps/vctcn-app1/main.tf`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/vctcn-app1/templates/compose.yaml.tftpl`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/registry/main.tf`

The placement guide is VM 180 `vctcn-app1`, public/admin URL `https://keycloak.237575.xyz`, owned by `pve-vctcn`. Verify it against those sources and live state for an operational task; this skill is not a live inventory.

| Realm | Purpose / selection |
|---|---|
| `moat` | Human SSO, including Forgejo. Use for human-facing apps unless current IaC specifies otherwise. |
| `registry` | Machine authentication for `registry.237575.xyz` and `sa-registry`; keep separate from human login. |
| `master` | Admin authentication only; do not create application clients here. |

A similarly named realm or service record elsewhere does not establish ownership. Check current IaC before selecting it.

## Durable integration workflow

Changes to clients, redirects, realm settings, users, mappers, or IaC-managed secrets follow `iac-projects` and `iac-issue-routing`. Load `pve-vctcn/AGENTS.md` and its rules before implementation; external app agents supply the integration contract rather than editing IaC from app context. Execution-ready handoffs use `iac-auto-deploy-issue` with `iac:deploy` and explicit login/token verification.

1. Classify the consumer as human-facing or machine-facing.
2. Establish its client ID, public URL, exact redirect URIs, web origins, required claims/groups/roles, and confidential/public-client requirements from the app contract.
3. Implement the realm/client/mapper or compose-managed configuration in the owning OpenTofu workspace, using its issue/PR and apply boundaries.
4. Verify the real browser login or token flow, claims, redirect, and resulting authenticated app behavior. API resource existence alone is not proof of an SSO integration. Put layered evidence in the PR via `writing-pr`.

Admin REST examples below are inspection, not an alternative persistent configuration path. Emergency/manual reconciliation requires explicit scope and authorization and must be reconciled to IaC.

## Authentication helper

`token.sh` consumes existing environment credentials; it does not discover or store them. Resolve them from the authorized IaC/secret-store or existing local CLI setup under `credentials-belong-in-iac`, without printing values. If that path is unavailable, investigate the integration gap rather than asking the user to paste secrets or run the command for you.

| Variable | Contract |
|---|---|
| `KC_ADMIN_USERNAME` | Required, nonempty |
| `KC_ADMIN_PASSWORD` | Required, nonempty |
| `KC_HOST` | Optional; defaults to `https://keycloak.237575.xyz` |
| `KC_TOKEN` | Set by the sourced helper after master-realm password grant using client `admin-cli` |

```bash
# Source only after credentials are supplied through the authorized local path.
source /Users/mouriya/.claude/skills/keycloak/token.sh
```

Stop on a nonzero source result. Missing env produces `KC_ADMIN_USERNAME and KC_ADMIN_PASSWORD must be set`; an empty/null token produces `Failed to obtain Keycloak admin token`. Inspect reachability, host/realm, credential source, and grant policy without echoing the password/token. A successful source permits the inspection request; it does not establish that the token has every admin permission. Treat token responses and shell traces as sensitive.

## Read-only examples

List client IDs in the first page:

```bash
REALM=moat
curl -fsS "$KC_HOST/admin/realms/${REALM}/clients?first=0&max=100" \
  -H "Authorization: Bearer $KC_TOKEN" | jq '.[].clientId'
```

For a complete inventory, continue pagination until exhausted; the example's 100-row page is not a total. For a known client, set `CLIENT_ID` from the task-confirmed app contract before running the query; do not use a placeholder or infer a client from another service example. The query fails before any request when `CLIENT_ID` is unset or empty and requires exactly one result before using its UUID:

```bash
(
  set -o pipefail
  : "${CLIENT_ID:?Set CLIENT_ID from the task-confirmed app contract}"
  REALM=moat
  CLIENT_UUID=$(curl -fsS --get "$KC_HOST/admin/realms/${REALM}/clients" \
    --data-urlencode "clientId=${CLIENT_ID}" \
    -H "Authorization: Bearer $KC_TOKEN" | jq -er 'if length == 1 then .[0].id else error("expected one client") end') || exit
  printf '%s\n' "$CLIENT_UUID"
)
```

Use OIDC discovery to confirm endpoints for the selected realm:

| Endpoint | URL pattern |
|---|---|
| Issuer | `https://keycloak.237575.xyz/realms/<realm>` |
| Discovery | `https://keycloak.237575.xyz/realms/<realm>/.well-known/openid-configuration` |
| Authorization | `<issuer>/protocol/openid-connect/auth` |
| Token | `<issuer>/protocol/openid-connect/token` |
| Userinfo | `<issuer>/protocol/openid-connect/userinfo` |
| Logout | `<issuer>/protocol/openid-connect/logout` |
| JWKS | `<issuer>/protocol/openid-connect/certs` |

## Consumer-specific sources

For Forgejo, read `apps/vctcn-app1/main.tf`, its `templates/compose.yaml.tftpl`, and `scripts/register-forgejo-oidc.sh` before changing SSO settings.

For registry machine auth, read `apps/registry/main.tf`, `README.md`, `templates/docker_auth.yml.tftpl`, and `templates/ext_auth.sh.tftpl`. Do not turn the registry service-account flow into a human-login client in `moat`.
