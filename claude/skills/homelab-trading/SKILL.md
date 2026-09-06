---
name: homelab-trading
description: Workload-only routing for VM 130 trading-agent stacks, moomoo OpenD, trading Komodo declarations, and homelab-trading secrets/sync workflow. Host provisioning, SR-IOV, DNS, mesh, registry, and Core/ResourceSync provisioning belong to IaC; existing stack operations use km-* with -p trading.
---

# homelab-trading — workload-only signpost

`mouriya-s-lab/homelab-trading`, at `/Users/mouriya/Ext/code/homelab-trading`, owns Docker Compose workloads for VM 130 `trading-agent`, not the VM or its infrastructure. Read its current `AGENTS.md`, then the referenced rules/skills before changing stacks or secrets. This guide locates authority; it does not establish live runtime state.

## Owned surface

| Path | Authority |
|---|---|
| `stacks/<name>/compose.yaml` | One directory per workload; optional Dockerfile/app files belong with their stack |
| `komodo/syncs/stacks.toml` | Stack/Variable declarations consumed by the trading Core's ResourceSync |
| Repo-root `secrets.yml` | SOPS+age, flat top-level keys, single runtime secret source; no per-stack secrets file or committed populated `.env` |
| `.github/workflows/sync-to-komodo.yml` | Routes secrets into Komodo and triggers `RunSync`; individual custom-image stacks may have a dedicated build workflow |

The **ResourceSync object** that points at `komodo/syncs/` is provisioned by IaC; its **declaration contents** belong here. `trading-agent` is the VM name, not a Compose service name.

Read repo-local `.claude/rules/{topology,dev-conventions,secrets-handling,deploy-plane,pr-evidence}.md`. For cross-stack conventions use `.claude/skills/stack-baseline/`; OpenD deployment/SMS/account/restart specifics use `.claude/skills/opend/`. Client quote connections use global `opend-client`.

## Ownership outside this repo

| Task | Route |
|---|---|
| VM 130 lifecycle, sizing, disks, SR-IOV, cloud-init | `iac-projects`, `homelab-tf/trading/` |
| Trading Core install, Periphery, host bootstrap | `iac-projects`, `homelab-tf` Ansible |
| ResourceSync object provisioning | `homelab-tf/komodo/roles/komodo-stacks-gitsource` via IaC workflow |
| DNS / NetBird enrollment | `iac-projects`, current homelab DNS/VM authority |
| `registry.237575.xyz` | `pve-vctcn/apps/registry` |
| GARM runner VM 181 | `pve-vctcn/apps/runner`, `local-cicd` |
| Core endpoint/auth/profile lookup | `km-endpoints` |
| Existing Stack deploy/restart/stop/list | `km-stack` with `-p trading` |
| Container ps/inspect/restart | `km-container` with `-p trading` |

Apply `iac-issue-routing` to work crossing those boundaries. Workload changes use this repo's issue/PR; infrastructure work uses its owning repo and appropriate issue subtype. Routine version rollout through the existing CD path is not a new `iac:deploy` task.

## Connection and secret invariants

- Pass `km -p trading` on every call. `km -p homelab` is a separate Core/state; there is no active-endpoint switch.
- Connection guide: VM LAN `192.168.1.225`, mesh name `trading-agent.mouriya.lan`, trading Core `http://trading-agent.mouriya.lan:9120`. Verify current reachability/config before operating. The SSH MCP key is normalized by `ssh-mcp-sync` (the trading-agent name becomes `TRADINGAGENT`).
- The sync job uses `vctcn-runner` VM 181's mesh path. The workload repo's `AGENTS.md` distinguishes the VM's mesh access from its PVE host; do not infer PVE mesh membership from VM reachability. For Core-unreachable failures, inspect runner mesh/DNS and the target path before changing stacks.
- Age identity is shared with homelab-tf (Bitwarden note `homelab-tf-sops-age-key`; recipient in each repo's `.sops.yaml`). Resolve it through the existing local setup; never print decrypted secrets as a verification step.
- Follow the current secret-routing table, not “publish every key raw”: `KOMODO_TRADING_SYNC_WEBHOOK_SECRET` sets the Sync's `webhook_secret`; stack-consumed values become secret Variables. `FUTU_RSA_PEM` remains the multi-line source, with `FUTU_RSA_PEM_B64` derived only when the sync spec references that single-line variable. `secrets.yml.example` and `secrets-handling.md` document the contract.

## Select the deployment mode

Read `deploy-plane.md` for exact current commands and authorization before applying one of these distinct paths:

| Change | Mode and persistence |
|---|---|
| Compose/Stack structure, new or deleted stack, or structure plus secret change | Normal repo PR, then main-branch sync workflow. Update compose, declarations, and SOPS source together as applicable; CI routes Variables and runs ResourceSync. |
| Only a Variable value during iteration | `km -p trading update variable` followed by `execute deploy-stack`; the standing repo rule avoids a CI run solely for that runtime iteration. Reconcile the authoritative SOPS source for durable persistence: later CI can overwrite an unreconciled runtime value. |
| Short-lived alternate image/args smoke | Authorized `UpdateStack` inline `file_contents` override and DeployStack via `km-api`; next RunSync restores repo/branch/file paths and git-sourced compose. Make persistent changes in the repo, not inline state. |
| Force redeploy without config change | `km -p trading execute deploy-stack <stack>`; no structural edit needed. |

After any mode, inspect the terminal deployment result and actual workload behavior on VM 130 using `pr-evidence.md`. A successful `RunSync`/DeployStack is control-plane evidence, not proof the app works. Use `local-cicd` for delivery-shape details rather than adding another deployment implementation here.
