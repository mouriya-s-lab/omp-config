---
name: local-cicd
description: Choose and implement self-hosted delivery through GARM/LXD, private registry, app-level deploy, release artifact consumption, or Komodo ResourceSync. Covers pool onboarding, mesh-aware CI, artifact authority, secrets sync, and evidence by delivery type.
---

# local-cicd: self-hosted CI/CD 体系

`runner-canary` 是当前 **image-service 样板**，不是所有 GARM 项目的唯一形态。先按项目类型判断，再套对应链路；不要把 registry image、healthz、Komodo DeployStack 强加给 plugin / sync / E2E-only repo。

## Authoritative sources first

Before asserting current state, verify from live/current sources:

1. **Live GARM sqlite on VM 181** — repo/pool truth:
   ```sh
   ssh root@vctcn-runner.mouriya.lan 'docker exec garm garm-cli repository ls; docker exec garm garm-cli pool ls'
   ```
2. **Runner/IaC docs** — `/Users/mouriya/Ext/code/pve-vctcn/apps/runner/README.md` and `/Users/mouriya/Ext/code/pve-vctcn/apps/registry/README.md`.
3. **Consumer repo latest default branch** — fetch/pull latest default branch or inspect `origin/<default>` if the working tree is dirty.
4. **Owning IaC repo** — for placement and install/deploy truth: `homelab-tf` or `pve-vctcn` current docs/state/submodules.

Static lists in this skill are examples/patterns. Treat live GARM + current repo docs as final.

## System boundaries

| Stage | Authority |
|---|---|
| Source repo | App/plugin/sync code, workflow YAML, artifact naming, app-level deploy trigger. |
| Runner seam | VM 181 `vctcn-runner` GARM + `garm-provider-lxd`; per-job LXD runners; host NetBird peer at `vctcn-runner.mouriya.lan`; pool state in GARM sqlite, not TF. |
| Private registry | VM 182 `vctcn-registry`, `registry.237575.xyz`, Keycloak `registry` realm, `sa-registry`; maintained by `pve-vctcn/apps/registry`. |
| Homelab deploy | `homelab-tf` owns Core/Periphery, ResourceSync provisioning, VMs/CTs, DNS/mesh/storage; workload repos own repo-backed Stack contents and secrets. |
| vctcn deploy/edge | VM 180 Keycloak/Forgejo, VM 181 runner, VM 182 registry, NPM/DNS/edge under `pve-vctcn`. |

## Decide the CI/CD shape by artifact type

### First decide the build artifact authority

Before writing a Docker workflow, inspect the repo's existing release/build
pipeline and choose exactly one compiler for each released version.

- **Source-built image:** use when the container image is the primary release
  artifact. The Docker build may run the project build once and publish the
  resulting image.
- **Release-artifact image:** use when an existing workflow already publishes
  the executable/package consumed at runtime. That workflow is the sole
  compiler. The image workflow waits for the release artifact, verifies it,
  and only packages it into the runtime image.

Do not rebuild an executable in Docker after its release workflow already compiled it. Verify the release checksum/digest and package those exact bytes; otherwise the same version can name different artifacts.

### A. Image service consumed by Komodo or a host

Use for services like `moat-browser`, `fulcrum`, and the `runner-canary` sample.

```mermaid
flowchart TD
    start[GitHub workflow on GARM] -->|image is primary artifact| build[Project-native build]
    start -->|release artifact already exists| download[Download and verify release artifact]
    build -->|one authoritative artifact| image[Docker runtime image]
    download -->|verified bytes only| image
    image -->|Keycloak token login| push[Push immutable registry tags]
    push -->|pull and inspect| evidence[Published image evidence]
    evidence -->|deployment in scope| deploy[Bounded Komodo or app redeploy]
```

Implementation expectations:

- A release-artifact image should trigger only after the artifact is complete
  (`release: published`, a successful upstream workflow, or an equivalent
  explicit dependency), not race a parallel release job on the same tag.
- Keep compilation and packaging separate: the compiler produces the artifact;
  the runtime Dockerfile copies it and installs only runtime dependencies.
- Runner: `runs-on: [self-hosted, linux, vctcn]` plus `netbird` / `vctcn-runner` / `x64` only when the live pool labels require or clarify capability.
- Pool: Docker build/push jobs need `flavor=docker` and VM181 helper-generated `extra_specs`.
- Registry auth: use `Mouriya-Emma/keycloak-token-action@v1`, then `docker login registry.237575.xyz -u sa-registry --password-stdin`.
- Push immutable tags; add convenience tags only when appropriate (`short-sha`, `latest` on main, release tag, PR tag).
- For Komodo delivery, CI may update bounded version/env fields and invoke deployment. Repo-backed durable Stack contents and workload secrets follow Shape D; registry pull authorization, host storage, mesh, Core provisioning, and placement remain IaC responsibilities.
- If the service has HTTP semantics, prefer `/healthz` and `/version`; if not, use an equivalent runtime smoke.

Canonical sample docs:

- `/Users/mouriya/Ext/code/runner-canary/README.md`
- `/Users/mouriya/Ext/code/runner-canary/docs/cicd-template.md`
- `/Users/mouriya/Ext/code/runner-canary/deploy/komodo/README.md`

### B. Bounded app-level deploy without registry publish

Use when the target VM builds or runs from rsynced artifacts and the runner only performs a narrow delivery action (example: `nanoclaw`).

```mermaid
flowchart LR
    build[Project test/build/package on GARM] -->|verify tooling| transfer[rsync/scp via narrow deploy user]
    transfer -->|allowed command only| restart[Bounded restart or target build]
    restart -->|observe target| smoke[Service state and app smoke]
```

Rules:

- Use a narrow deploy user/key and exact allowed sudo commands.
- Do not mutate host placement, DNS, broad packages, storage, or secrets from the app workflow.
- Target-side Docker build is acceptable when that is the app contract; do not force registry publishing just because GARM is involved.
- Evidence is target-side service active/running plus relevant app smoke, not registry pullback.

### C. Release artifact consumed through the owning deployment workflow

Use when an existing authoritative build publishes a release artifact and checksum for a separate consumer.

- Keep that build as the sole compiler; the consumer verifies and uses the published bytes, without rebuilding the same version.
- Choose the consumer and deployment workflow from the actual project contract; this shape does not imply a particular live workload or deployment endpoint.
- Do not force Docker registry publication or Komodo DeployStack. Use IaC only for the scope that actually requires it; normal artifact/version delivery stays with the owning workflow.
- Evidence is the published artifact and checksum plus consumer verification; when deployment is in scope, its owner supplies deployment and runtime evidence.

### D. Komodo ResourceSync / secrets-sync repo

Use for repo-backed homelab workloads such as `homelab-apps`, `homelab-moat`, `moat-browser`, `runner-canary`, and `homelab-trading`, where the owning repo owns Stack declarations, release state, and workload secrets but not VM/Core provisioning.

```mermaid
flowchart TD
    tools[GARM job with sops/age/yq/jq/curl] -->|decrypt source without logging secrets| source[Repo-root SOPS]
    source -->|validate declarations| declarations[komodo/syncs and stacks]
    declarations -->|bounded upserts| config[Variables and ResourceSync webhook_secret]
    config -->|RunSync and wait| terminal[Terminal sync result]
    terminal -->|read back and smoke| runtime[Declared Stack and actual workload]
    runtime -->|remove transient key material| cleanup[Job cleanup]
```

Rules:

- New Stack compose authority belongs in the owning workload repo (`komodo/syncs/` + `stacks/`), not in `homelab-tf/komodo` file_contents templates.
- No repo-level image build unless an individual stack introduces a custom image contract.
- No VM/Core/Periphery provisioning in the workload repo; that remains in `homelab-tf`.
- Evidence is Variables/ResourceSync API success, terminal `RunSync`, live Stack repo/branch/file path, and real runtime smoke.

### E. GARM-only E2E / notification / runner canary

Use when the repo is not a deployed service, e.g. PR bridge E2E or runner capability checks.

Rules:

- GARM may be required for mesh reachability or parity with production runners.
- No registry, Komodo, or IaC deploy evidence is required unless the workflow actually publishes/deploys something.
- Evidence is the workflow's target behavior (notification sent, bridge template executed, toolchain check passed, canary HTTP/DNS probe passed).

## When GARM/local-cicd is mandatory

Use GARM or a GARM job for any workflow that must:

- reach `*.mouriya.lan`, NetBird peers, homelab services, Komodo, OpenBao, Step-CA, vctcn registry/NPM/edge, or other private endpoints;
- publish to `registry.237575.xyz` from inside the mesh/private path;
- validate production-like nested Docker/LXD runner behavior;
- call Komodo APIs without public ingress;
- prove a release/deploy path that is consumed by homelab/vctcn infra.

A repo may mix runner classes by responsibility. Public/cheap tests can run on cloud runners; mesh/publish/deploy/integration jobs should use GARM.

## GARM onboarding / pool shape

Current runner onboarding lives in GARM sqlite and is mutated with `garm-cli` on VM 181:

1. GARM repository entity.
2. Pool with labels matching workflow `runs-on`.
3. GitHub webhook installed by GARM.
4. Docker build/push or job-container workflows require Docker-capable pool shape.

Standard Docker-capable pool pattern (resolve `<repo-id>`, verify current CLI/helper options, and execute only within the authorized runner-onboarding scope):

```sh
garm-cli pool add \
  --repo <repo-id> \
  --enabled \
  --provider-name lxd_local \
  --flavor docker \
  --image ubuntu:24.04 \
  --max-runners 1 \
  --min-idle-runners 0 \
  --runner-bootstrap-timeout 60 \
  --os-arch amd64 \
  --os-type linux \
  --tags self-hosted,linux,x64,vctcn,netbird \
  --extra-specs "$(ssh root@vctcn-runner.mouriya.lan \
    /opt/runner/scripts/build-extra-specs.sh \
    --docker \
    --extra-packages 'unzip,zip,jq,git,make,wget,gnupg,ca-certificates,xz-utils,build-essential')"
```

For existing pools, update live state with `garm-cli pool update ...`; do not expect OpenTofu to manage repository registrations, pool labels, or `extra_specs`.

Tooling notes:

- VM181 host NetBird peer provides mesh access; GARM-created LXD instances route via LXD bridge/NAT.
- `registry-mesh-hosts.sh` pins `registry.237575.xyz` to VM182 mesh IP for docker-in-LXD push.
- `sops` and `yq` are installed by `binary-tools-install.sh` when requested because Ubuntu apt packages are unsuitable/missing.
- Do not inject old per-runner `netbird-install.sh`; use gateway mode.


## CI/CD 与 IaC handoff

已接入的 workload 版本迭代默认由其 repo 的 workflow、`komodo/syncs/`、`stacks/` 完成。Image tag/digest、有界 Variables、RunSync/DeployStack 不需要另开 `iac:deploy`。

出现 host/VM/CT、DNS/mesh/ingress、根信任、GARM pool、Core provisioning，或需 IaC 落地的 secret 配置时，用 `iac-issue-routing` 分清边界。一般执行契约用 `iac-auto-deploy-issue`；首次装配常驻 Komodo CD 用 `iac-cicd-onboarding-issue` 并证明第二次不同版本 rollout；未决设计记录明确 blocker，不触发部署。

Issue 只承接 CI/CD 未覆盖的工作，写清已发布的 artifact 和剩余 IaC 责任；不要让执行 agent 重跑已有自动 build/push/RunSync。

## Evidence matrix

Pick evidence by CI/CD shape:

| Shape | Required evidence |
|---|---|
| Image service | artifact-authority decision; one project build; release checksum/digest match when packaging an existing artifact; Docker build; pushed immutable image; pull/inspect pushed image; GARM job success; deploy/run smoke if deploy in scope. |
| App-level deploy | project tests/build, artifact transfer, bounded remote command output, target service active/running, app smoke. |
| Release artifact consumption | authoritative build/release success; published artifact + checksum; consumer checksum verification; owning deployment workflow and runtime evidence when deployment is in scope. |
| ResourceSync | SOPS decrypt/tooling check, Komodo Variable/ResourceSync API success, `RunSync` accepted/completed, stack smoke if runtime changed. |
| E2E-only/canary | Workflow success plus the behavior being tested; no synthetic registry/deploy evidence. |

PR bodies still follow `writing-pr`. If app and infra are split, say exactly which repo owns each evidence layer and link the owning issue/PR.
