---
name: container-management
description: >-
  Entry point for homelab Docker via Komodo: choose a Core, inspect workloads, then route Stack, container, GitOps, build, cleanup, database or API work. Keycloak/Forgejo belong to pve-vctcn on vctcn-app1, not these Cores.
allowed-tools: Bash, Read
---

# Homelab Docker via Komodo

`km` talks to a **Core**, which manages resources and sends work to **Periphery** agents on Servers. A **Stack** is a Compose project on a Server; its containers are runtime instances, not independent declaration sources. Prefer Stacks over legacy single-container **Deployments**.

## Select and inspect before acting

1. Find the target Core. `homelab` is on `moat-app1` (VM 110); `trading` is the independent Core on `trading-agent` (VM 130). Memos, HAPI, homepage, fulcrum, cliproxyapi and moat-browser are homelab routing examples, not an authoritative inventory. Trading workload ownership starts with `skill://homelab-trading`.
2. Every invocation uses `-p <name>`. There is **no active profile**: another shell's selection changes nothing. The rendered config's `default_profile` is not permission to omit `-p`.
3. Discover Servers and all Stacks, including down ones, before choosing a lifecycle action. Names and IDs are Core-local.

```bash
bash ~/.claude/skills/km-endpoints/bin/list.sh
# Example: choose homelab from the request and endpoint inventory.
core=homelab
km -p "$core" ls servers
km -p "$core" ls stacks -a -f json
km -p "$core" ps -a
```

For homelab, `Local` denotes the Periphery on moat-app1 and `browser` the Periphery on VM 104; verify the listing rather than carrying these names to another Core. If the requested resource is absent, include down resources and check the other relevant Core. Ask only if the target remains genuinely ambiguous. Missing profiles or endpoint inventory changes go to `skill://km-endpoints`; do not hand-edit the generated CLI config.

**Excluded:** Keycloak and Forgejo run on `vctcn-app1` (VM 180) under `pve-vctcn` Compose, not either Core. Historical down Stack records do not transfer ownership. Use `skill://keycloak` for Keycloak and `skill://iac-projects` for the owning pve-vctcn path.

## Choose the resource-level workflow

| Intent | Load | What it owns |
|---|---|---|
| Deploy, pull, restart or tear down a Compose project | `skill://km-stack` | Stack runtime operations; declaration-authority check before config changes |
| Inspect or operate one raw container; identify its host | `skill://km-container` | Container and Server inspection; bounded exceptions to Stack operations |
| Apply declarations or run orchestration | `skill://km-gitops` | ResourceSync, Procedure (chained executions), Action (custom code) |
| Build an image or clone/pull/build a repo on Periphery | `skill://km-build-pipeline` | Build and Repo resources; distinguish the GitHub Actions pipeline |
| Reclaim Docker disk space | `skill://km-cleanup` | Host-scoped prune/delete with explicit impact and authorization |
| Back up or restore Core metadata | `skill://km-database` | Komodo database, not application databases or volumes |
| Operation missing from the CLI | `skill://km-api` | Version-matched REST request, IDs and credential helper |
| List/register Core connections or render profiles | `skill://km-endpoints` | Local endpoint inventory and generated config |

A ResourceSync applies declarations; it is not itself proof that a Stack deployed or an application works. Likewise, a running container is not proof of a successful user operation. Each workflow ends by checking its terminal execution result, resulting resource state and relevant runtime behavior.

## Authority and safety

- For repo-backed Stacks, the owning workload repo and its ResourceSync workflow own durable changes. Use live `km` for inspection, bounded retries and runtime lifecycle operations, not as a competing declaration store.
- Host, VM, networking, storage or Core provisioning changes route through `skill://iac-projects` and `skill://iac-issue-routing`; CLI/API access does not authorize bypassing IaC.
- Before destroy, prune, restore or broad host operations, inspect the exact scope and obtain explicit authorization covering its impact. Keep interactive confirmation prompts; `-y` belongs only in already-authorized automation.
- Do not turn an uncertain operation into a broader retry. Inspect the execution error and current state, then follow the specialized recovery path.
