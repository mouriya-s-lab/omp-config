---
name: iac-issue-routing
description: 判断 app/外部上下文中的任务是否触及 IaC，以及能否直接执行或应移交 owning repo。覆盖 VM/CT、网络、存储、placement、secret 路径；未决设计用 requirement-only handoff，已就绪部署用可执行 issue。
---

# iac-issue-routing — IaC 边界与执行上下文

本 skill 决定工作是否越过 app 边界、在哪里执行，以及交付哪一种 issue。repo 归属用 `iac-projects`；服务定位用 `internal-services`；CI/CD 实现教程用 `local-cicd`。

## IaC-adjacent 判据

触及以下任一项，就不能仅当作普通 app 修改：

- Proxmox CT/VM 生命周期、规格、磁盘、bind mount、PCI/SR-IOV/iGPU。
- OpenTofu state/module/workspace/provider/output，或 IaC 使用的 Ansible role/playbook/inventory。
- DNS/CoreDNS/Unbound/Kea、DHCP 保留、主机可发现性；NetBird 拓扑、ACL、runner 私网访问。
- NPM、公网 ingress、NAT、host 网络、防火墙、SSH 加固。
- 服务 placement、hostname/暴露端口、存储、备份、根信任或 deploy/runtime secret 的权威路径；包括 OpenBao、Step-CA、Keycloak、registry、Komodo Core/Periphery、GARM 配套。

## 执行权限取决于上下文

| 上下文 | 可以做 | 边界 |
|---|---|---|
| app/workload repo、外部 agent、普通对话，未加载 owning IaC rules | 非机密调查；写 app deploy contract；认定/创建 IaC issue 并双向链接 | 不改 IaC 文件，不跑 apply/destroy、基础设施 playbook 或 host-mutating 操作；不直接改 Proxmox、DNS、网络、存储、根信任、Komodo placement |
| owning IaC repo，已读 `AGENTS.md`/rules，已有 issue 或用户明确指派 | 按 repo 流程实现、做批准的 plan/check | apply/Ansible/live 操作还须符合 repo 规则、issue 范围、环境权限与授权；runtime 变更不能以 plan-only 收货 |
| 用户明确要求跨 repo 端到端修复 | 逐个进入 owning repo、加载规则、认定 issue、实施并验证完整链路 | 不停在开 issue；也不把跨 repo 请求当作跳过各 repo 边界的许可 |

跨入 IaC 时明确：app 出运行契约，infra 出 placement/基础设施实现。凭据遵循 `credentials-belong-in-iac`，不把授权路径缺失转成向用户索要 token。

## 选择交付路径

1. **已接入的 workload 迭代**：仅 image tag/digest、有界 Komodo Variables、DeployStack 或 owning workload repo 的声明/workflow 改动，且既有 CI/CD 能完成时，走 workload repo PR（`local-cicd`）。不要额外开 `iac:deploy` 让 agent 手动重跑自动链路。
2. **具体的基础设施部署/修复**：已能写出可执行契约，走 `iac-auto-deploy-issue` + `iac:deploy`。只承接 CI/CD 未覆盖的部分。
3. **容器化 workload 首次接入常驻 Komodo CD**：符合子形态条件时用 `iac-cicd-onboarding-issue`；它要求首次部署和第二个不同版本的自动 rollout。
4. **尚不能执行**：合理调查后仍存在产品行为、artifact 可用性、owner、placement/安全设计分叉，写下面的 requirement-only handoff，不加触发标签。

任务同时含 workload 与 IaC 修改时按所有权拆分，互链 issue/PR；不要把 CI 已负责的 build/push/RunSync 抄成 IaC agent 的手工任务。

## Requirement-only handoff

用于真正未决的事实，不用于省略已经知道的部署信息。遵循 `writing-issue`，body 至少包含：

- 驱动方：app repo、issue/PR、用户请求。
- 服务用途、入站调用方和流量形态、出站依赖。
- 持久化/备份预期、secrets 的用途与权威来源（不含值）。
- app/产品固定的约束及理由、out of scope。
- **阻止 `iac:deploy` 的确切未决事实**，以及由谁裁决/什么证据能解除。

没有外部硬约束或现行声明证据时，不替 IaC agent 指定 VMID、hostname、暴露端口、Stack 名、NetBird ACL、存储布局。已知的 app 监听口、health 接口和已有资源身份仍须写清。Blocker 解除后将 body 替换成可执行契约，再加标签。

## 不把基础设施决策转成聊天问答

app/外部上下文需要 placement、网络暴露、存储/备份、硬件映射、registry 拉取授权、mesh 可达性或根信任配置时，将需求写入 owning IaC issue。只在调查后仍有会改变产品设计的真实选择、优先级或安全分叉时问 operator；不要让用户代替 IaC 分配资源或粘凭据。

## 工件与后续

已有原子 issue 覆盖就复用；否则按 `writing-issue` 创建。实现 PR 用 `writing-pr`，关闭自己的 issue、提供分层证据，与驱动 app contract 双向链接。实现 review 与重试对话遵循 `review-pr`；已合并 PR 不回写，后续修复新建 issue/PR。

进入具体服务后再加载 `km-*`、`keycloak`、`dns-check` 等操作 skill；这些工具不改变上述所有权或授权边界。
