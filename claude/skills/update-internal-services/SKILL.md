---
name: update-internal-services
description: Refresh internal-services from current IaC declarations and live workload inventory, preserving its counting policy. Reconcile stale service-skill ownership guidance without duplicating inventory or turning maintenance into infrastructure operations.
---

# Update internal-services

Maintain `skills/internal-services/SKILL.md` in the authoritative `mouriya-s-lab/internal-services-skill` repository as an inventory/ownership signpost. `internal-services` owns the counting definitions, placement guide, source list, and skill-coverage list; this skill owns the refresh procedure, not another copy of that inventory. Installed copies under `~/.agents/skills` and `~/.claude/skills` are npx-managed deployment artifacts, not editing destinations.

## 1. Establish scope and authority

Read the `internal-services` entry in `~/.agents/.skill-lock.json`, including `source`, `skillPath`, and `ref` when present. Verify that its source is the authoritative `mouriya-s-lab/internal-services-skill` repository. Locate an existing checkout and verify its Git remote; if absent, clone that repository into an authorized workspace. Resolve and select the recorded `ref` before reading the maintenance baseline; an installed PR branch must not silently become an empty or stale default-branch checkout. When no `ref` is recorded, resolve the repository's current default branch. Read repo-local instructions and establish the source revision before editing the recorded `skillPath`. Preserve existing working-tree changes and branches: never reset or overwrite user work to select a ref; use a separate authorized checkout when the existing checkout cannot safely provide that revision. Read the source `skills/internal-services/SKILL.md`, not a stale installed duplicate, as the maintenance baseline.

For related service-skill corrections, resolve each installed entry's `source`, `skillPath`, and optional `ref` from `~/.agents/.skill-lock.json`, then apply the same verified-checkout and revision-selection procedure before editing. If ownership or revision cannot be resolved, report that specific blocker rather than guessing a default. For example, Keycloak source is `mouriya-s-lab/keycloak-skill`, with `skills/keycloak/SKILL.md` and `skills/keycloak/token.sh`. Do not derive a source checkout by following an installed skill symlink or assume the workload/IaC repo owns a global skill with the same name.

Read `internal-services`, then both entrypoints:

- `/Users/mouriya/Ext/code/homelab-tf/AGENTS.md`
- `/Users/mouriya/Ext/code/pve-vctcn/AGENTS.md`

Follow repo-local rules for inspection. Keep the active top-level workload counting policy unless the user changes it. Preserve the separation between primary services and legacy/down records with the same names; Keycloak is classified under `pve-vctcn`, not homelab rollback residue. Do not infer a migration from a stale duplicate record.

## 2. Collect current evidence

Start with the authoritative paths in `internal-services`, then discover additions rather than assuming its list is exhaustive:

| Source | What to inspect |
|---|---|
| `homelab-tf/Makefile` | Current workspace list |
| Homelab workspace `main.tf`, `vms/*.yaml`, `network/cts/*.yaml` | Declared guest identity, placement, lifecycle scope |
| `_shared/ansible/inventory.yml`, `.gitmodules`, `git submodule status` | Host mappings and relevant role ownership/revisions |
| Relevant `dns/`, `komodo/`, `openbao/`, `step-ca/` docs | Service detail only where the inventory needs it |
| `pve-vctcn/host/README.md`, `host/main.tf`, `apps/*/{README.md,main.tf,variables.tf}` | Managed app and supporting-host declarations |
| App compose templates | Top-level service names or ports when not established by workspace declarations |
| Live homelab/trading Stack and ResourceSync inventory | Runtime state and owning workload repo/branch/file paths; use the commands in `internal-services` |

If a relevant submodule is unavailable, determine whether its detail is actually needed. Initialize only the required submodule under the investigation's authorized scope; do not blanket-initialize or claim its unseen content. Report unavailable evidence as unknown.

`homelab-tf/docs/iac-drift-investigation/*` is historical incident evidence, not current inventory authority. It can supply a lead but must not be copied into the inventory as present state or expose sensitive details.

## 3. Recalculate and classify

Apply `internal-services`' counting policy to a concrete named list, not a remembered total. Separate confirmed-active, inactive, and unknown; inspect both Komodo Cores when in scope. Reconcile:

- top-level workloads versus backing containers/helpers;
- homelab versus vctcn ownership and actual host placement;
- supporting infrastructure mentioned but excluded at the requested granularity;
- decommissioned/rollback residue and duplicate service names;
- declaration authority, source paths, and missing/stale service skills.

Include the evidence timestamp and exclusions in the refresh report. If live access is unavailable, report declared inventory separately and do not invent an active total. Do not store a numeric total in the skill that future answers can reuse without recomputation.

## 4. Replace stale guidance

Edit the authoritative checkout's `skills/internal-services/SKILL.md` with verified placement/source pointers and current coverage. Keep operational runbooks in their service skills. Replace superseded prose directly; do not append a contradictory warning or a second inventory snapshot.

Inspect conflicting service-specific guidance and helper contracts in the same pass in their authoritative source checkouts. For Keycloak, the relevant pair is `skills/keycloak/SKILL.md` and `skills/keycloak/token.sh`; compare documentation to the helper without printing credentials. Update source Markdown within the authorized maintenance scope. Helper code changes or unrelated skills require their own authorized scope; report them rather than silently expanding a documentation refresh.

Deliver each repository's source changes through its issue/PR workflow using `writing-issue`, `writing-pr`, and `review-pr`; each PR closes its real issue and carries the evidence. After merge, deploy only the changed skills explicitly with npx skills, rather than copying files into installed directories or running a blanket update. For the inventory skill:

```bash
npx skills add mouriya-s-lab/internal-services-skill --skill internal-services --global --agent codex claude-code --yes
```

For each related changed skill, run the same explicit command with its verified repository and exact skill name. Confirm the installed payload matches the merged source, its lock entry names that repository and skill path, and the `~/.claude/skills/<name>` symlink resolves to `~/.agents/skills/<name>`. Exercise the refreshed skill through the agent's normal discovery/reading path and record that deployment evidence separately from live service-health observations.

The resulting report should name changed files, evidence used, unchanged counting definitions, and unresolved source conflicts. A refreshed static document is not proof that a service is healthy; keep live observations distinct from ownership documentation.

## Infrastructure changes discovered during refresh

Use `iac-projects` and `iac-issue-routing` if evidence calls for changes to placement, hosts, networks, storage, or credentials. Choose the appropriate executable issue or record the specific blocker. An inventory-maintenance task does not itself authorize IaC edits, Proxmox operations, host networking, or service repair.
