---
name: iac-projects
description: 定位个人基础设施的 owning repo（homelab-tf 或 pve-vctcn），用于 Proxmox、VM/CT、DNS、mesh、存储、placement 和跨 repo 不变量。执行权限与 issue 子形态另见 iac-issue-routing。
---

# iac-projects — repo 路标

两个互相独立的 repo 管理 operator 的个人基础设施：各有自己的 TF state、文档、惯例、`AGENTS.md` 和 repo-local rules/skills。动手前先分清归属；跨 repo 事实一律现场核实，不凭记忆编。

本 skill 只是路标。真实规则在各 repo 自己的文档里——定位到 repo 后先读它的 `AGENTS.md`，跟着它指向的 rules/skills 走。记忆与 repo 现行文档冲突时，以文档为准，并回头更新过时的全局 skill。

## 两个 repo

### homelab-tf — 家庭 LAN homelab

- 本地路径 `/Users/mouriya/Ext/code/homelab-tf`；GitHub `mouriya-s-lab/homelab-tf`。
- 单台 Proxmox host 在家庭 LAN `192.168.1.67`，ISP NAT 之后。多个 TF workspace 管 CT/VM，`<app>/` 下是 per-app Ansible role submodule（各自独立 git repo，parent 跟踪指针）。
- 先读 `/Users/mouriya/Ext/code/homelab-tf/AGENTS.md`；当前 checkout 的 rules/skills 可能还在 `.claude/` 下，以现场文件为准。

### pve-vctcn — OVH 云主机 / 应用边缘

- 本地路径 `/Users/mouriya/Ext/code/pve-vctcn`；GitHub `mouriya-s-lab/pve-vctcn`。
- 单台 OVH 裸金属 Proxmox host `192.99.9.212`，单公网 IP NAT；guest 内网 `172.16.1.0/24` 于 `vmbr1`；SSH key-only。TF workspace 在 `apps/` 下管 VM，与既存手工 guest（如 NPM CT 171）共存。
- 先读 `/Users/mouriya/Ext/code/pve-vctcn/AGENTS.md`；它的规则与 homelab-tf 各自独立。

## 跨 repo 不变量

- `vctcn-runner`（pve-vctcn 的 VM 181）经 Netbird mesh 伸进 homelab 做 CI/CD。影响 runner 在 homelab 侧所见的变更——DNS 记录、Netbird ACL、homelab endpoint、Komodo target——归 `homelab-tf`，即使 runner workspace 本身在 `pve-vctcn`。
- 两个 repo 不共享 TF state、provider、secrets backend 或 Ansible inventory。区分 PVE host 与 guest 的 NetBird 接入；不能从 guest 可达推断其 PVE host 已入 mesh。
- 根信任服务（OpenBao CT 314、Step-CA CT 313）永久留在 homelab；vctcn 服务需要时经 Netbird 伸进来用。没有显式的 homelab IaC issue + 设计，绝不把根信任外移。

## 任务开工顺序

1. 判断是否 IaC-adjacent（判据与边界：`iac-issue-routing`）。
2. 按上面的两分定位 owning repo；服务名分不清用 `internal-services`。
3. 进入该 repo 工作目录，读 `AGENTS.md` 及其指向的 rules/skills。
4. 按 `iac-issue-routing` 选择直接实现、可执行部署 issue、首次 CD onboarding 或 requirement-only handoff；issue body 用 `writing-issue` 及对应子形态契约。
5. 然后才计划或实现。
