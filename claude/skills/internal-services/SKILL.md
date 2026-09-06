---
name: internal-services
description: Inventory and count internal services across homelab-tf and pve-vctcn, including workload/Core ownership and skill coverage gaps. Recompute active totals from current sources; use service-specific skills only when the task becomes administration.
---

# Internal services inventory

Use this skill to answer inventory questions like “内网有多少服务”, “what runs where?”, or “which skills are missing for my apps?”. This is an overview skill: do **not** invoke service-specific skills such as `dns-check`, `km`, `keycloak`, or `local-cicd` just to count or describe services.

For implementation or operations on a specific service, route to the owning repo/skill after answering the inventory question.

## Counting policy

Never answer from a stored numeric total. Recompute on each request because workload repos and ResourceSync can change without this skill changing.

1. Read TF-managed CT/VM declarations from the owning IaC repos.
2. Read live homelab Stack inventory with `km -p homelab ls stacks -a -f json`; count only entries whose runtime state is active when the user asks for active services.
3. Read the trading Core separately with `km -p trading ls stacks -a -f json` when trading workloads are in scope.
4. Count vctcn top-level apps from current `apps/*/main.tf` plus live placement when available.
5. State the timestamp, granularity, included/excluded inactive workloads, and the concrete names behind the total.

Count active top-level services/workloads, not backing containers. Do not count Postgres, registry `docker_auth`, NPM proxy-host rows, CoreDNS/Unbound/Kea/dns-info sub-daemons, or `app01` rollback residue as separate top-level services. Count `moat-browser` once even though it has a VM and several containers. Keep Keycloak classified under `pve-vctcn`; legacy/down homelab Stack records with that name are not the primary service.

## Authority and placement guide

### homelab-tf

Use the following placement map to locate declarations, not as proof that each guest is still present or active: DNS/DHCP (CT 312), Step-CA (CT 313), OpenBao (CT 314), Komodo Core (VM 110), agent-runtime (VM 103), browser host (VM 104), nanoclaw (VM 106), trading-agent (VM 130), moat workload hosts (VM 111-113), and temporary moat-peercred experiment host VM 114. The recorded removal work for VM 114 is [homelab-tf#465](https://github.com/mouriya-s-lab/homelab-tf/issues/465); check current declarations before including it, and do not classify it as a long-lived service.

Application Stack names, activity, target hosts, and declaration repos must be derived live:

```bash
km -p homelab ls stacks -a -f json
km -p homelab ls syncs -f json
km -p trading ls stacks -a -f json
```

For a repo-backed Stack, the `repo`/`branch` fields identify its authority. `file_contents=true` with no repo marks a legacy control-plane-owned exception, not a template for new workloads. A stopped VM or down/stopped Stack is reported separately and excluded from an "active" count unless the user requests all declared services.

### pve-vctcn

Read current workspaces rather than a stored count:

- VM 180 `vctcn-app1`: primary Keycloak, Forgejo, and any other compose services currently declared in its workspace.
- VM 181 `vctcn-runner`: GARM/self-hosted runner control and worker host.
- VM 182 `vctcn-registry`: registry plus its auth helper (count the registry once).
- Manual CT 171 NPM is supporting public-ingress infrastructure; mention it but do not count it as an app unless the requested granularity includes control-plane services.

## Reporting format

Return a compact table grouped by owning repo with service name, active/inactive/unknown state, placement, declaration authority, and evidence command/path. Then give the computed total and explicit exclusions. If a live source is unavailable, distinguish declared inventory from confirmed-active inventory; do not present unknown state as active or silently omit that Core.

## Skill coverage

Existing relevant skills:

- `dns-check`: DNS discoverability/registration checks for new LAN hosts and failed DNS resolution. This is not a full DNS service-operations skill.
- `km-stack` / `km-gitops`: live Stack operations and ResourceSync inspection/execution; repo-backed declarations remain in the owning workload repo.
- `local-cicd`: delivery tutorial for GARM, image/registry, app-level deploy, plugin releases, ResourceSync, and E2E-only workflows; not every service uses the registry/Komodo shape.
- `iac-projects`: repo routing and IaC boundary skill.
- `keycloak`: SSO integration and safe Keycloak inspection. Global inventory/count questions stay here.

Missing or incomplete dedicated app/service skills:

- Forgejo;
- registry;
- Memos;
- Homepage;
- HAPI hub/runner;
- moat-browser;
- fulcrum;
- nanoclaw;
- OpenBao;
- Step-CA;
- full DNS service operations beyond `dns-check`.

## Authoritative sources

Before making a recommendation that the user may act on, verify current state from these sources.

homelab-tf:

- `/Users/mouriya/Ext/code/homelab-tf/AGENTS.md`
- `/Users/mouriya/Ext/code/homelab-tf/Makefile`
- `/Users/mouriya/Ext/code/homelab-tf/network/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/network/cts/312.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/network/cts/313.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/network/cts/314.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/apps/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/apps/vms/110.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/paas/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/paas/vms/103.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/browser/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/browser/vms/104.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/workstation/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/workstation/vms/106.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/moat/main.tf`
- `/Users/mouriya/Ext/code/homelab-tf/moat/vms/111.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/moat/vms/112.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/moat/vms/113.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/moat/vms/114.yaml`
- `/Users/mouriya/Ext/code/homelab-tf/_shared/ansible/inventory.yml`

pve-vctcn:

- `/Users/mouriya/Ext/code/pve-vctcn/AGENTS.md`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/vctcn-app1/main.tf`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/vctcn-app1/README.md`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/runner/main.tf`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/runner/README.md`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/runner/variables.tf`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/registry/main.tf`
- `/Users/mouriya/Ext/code/pve-vctcn/apps/registry/README.md`

Do not treat `/Users/mouriya/Ext/code/homelab-tf/docs/iac-drift-investigation/*` as current inventory authority. Those docs are historical drift/incident evidence and may contain stale placement, stale IPs, or sensitive operational details.

## When the answer turns into IaC work

Placement, VM/CT, DNS/NAT/storage/ports, migration, or infrastructure credential changes leave inventory scope. Use `iac-projects` for ownership and `iac-issue-routing` for execution context and issue subtype. To refresh this signpost from current evidence, use `update-internal-services`.
