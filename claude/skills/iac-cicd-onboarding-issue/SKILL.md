---
name: iac-cicd-onboarding-issue
description: >-
  写一次性接入常驻 Komodo 自动 CD 的 iac:deploy onboarding issue；验收必须含首次部署和不同版本的第二次自动 rollout。已接入 workload 的版本迭代走 source/workload repo；host 层变更用 iac-auto-deploy-issue。
---

# iac-cicd-onboarding-issue

`iac:deploy` 的一种子形态。产物是**一条常驻 CD 链路**，不是一次部署。基础规则读 `iac-auto-deploy-issue`；本 skill 只列差异。

## 何时用

全部满足：

- workload 可容器化，无 host 层强耦合（无 SR-IOV、无 host bind-mount 到固定路径、无 host systemd unit、无 host kernel 参数）。
- 已明确选择 **Komodo 作为常驻自动 CD 终点**，并写明决策来源及 artifact/声明如何进入该链路；能归入 `local-cicd` 某个 Shape 本身不构成准入条件。
- 期望后续每次版本变化都自动 rollout。
- 首次需要 IaC 侧落一次东西（新 GARM pool / 新 ResourceSync / 新 Stack / 新 SOPS 授权路径 / 首次分配 placement）。

## 何时**不**用

- workload 已在跑，只是 bump image tag / 改 Variables：走 workload repo 的正常 issue/PR，不另开 `iac:deploy`。
- 需要 host / netbird / DNS / cloud-init / OpenBao / Step-CA / Keycloak realm / registry 后端 / Komodo Core 自身变更 → 走 `iac-auto-deploy-issue` 普通形态。
- 已明确选择非 Komodo 交付（例如 bounded app-level deploy、由既有非 Komodo workflow 消费 Release artifact 或 GARM-only）：继续走 `local-cicd` 对应路径；仅其确需 IaC 落地的独立范围用普通 `iac-auto-deploy-issue`，不因终点不是 Komodo 就转未决设计。
- workload 是否走 Komodo / 是否容器化尚未决定 → 走 `iac-issue-routing` 的 requirement-only handoff。

## 上游必写

- workload 一句话说明。
- 源码：`owner/repo`、default branch、tag policy。
- 已选部署终点：Komodo 常驻自动 CD、决策来源；具体 Core/Server/Stack 等待分配身份仍按下节处理。
- artifact/声明形态及消费路径：直接发布 container image、将既有 Release artifact 校验后封装成运行镜像，或由 ResourceSync 消费 repo-backed Stack 声明；按 `local-cicd` 保留单一构建产物权威，不为接入重复编译或强加镜像构建。
- artifact/声明可行性证据：现存 Dockerfile、release workflow、Stack/ResourceSync 声明路径，或明确需新增的部分及其已裁决实现边界。
- 运行接口：端口、health/version endpoint、webhook path、CLI 行为。
- 上下游：入站从哪、出站到哪，标 mesh / 公网。
- 持久化：可丢 cache / 不可丢的数据 / backup 期望。
- secrets by purpose：用途 + 权威来源，不写值。
- 产品硬约束（每条附理由）。
- out of scope。

## 不替 IaC agent 发明资源身份

已知的 app 监听口、外部硬约束和现存资源身份必须写，并附来源；不得把这些与待分配的基础设施身份混为一谈。没有现行证据时，将下列选择及其约束留给 IaC agent：

| 待分配项 | 决策依据 |
|---|---|
| VMID、hostname、暴露端口 | placement + mesh DNS 惯例；保留已知 app 监听口 |
| Komodo Core 名（homelab / trading） | 由消费端和 Core 覆盖度决 |
| Komodo Server / Stack / ResourceSync 名 | 由 owning workload repo 名 + Core 惯例决 |
| GARM pool label / flavor / extra_specs | 走 `local-cicd` 的 pool 模板 |
| registry pull account、Keycloak client 名 | `pve-vctcn/apps/registry` 决 |
| SOPS key 名、Komodo Variable 名 | secrets 惯例 + 本次用途 |


## body 模板

body 一律中文，遵循 `writing-issue`。已知字段填事实；可由执行者选择的字段写「由 IaC agent 决定」并给约束；不适用的写原因。若缺的是执行前必须裁决的产品/安全事实，回到 `iac-issue-routing`，不靠占位触发部署。

```markdown
## 目标

<一句话：装配完成后，从 <source repo> 每次 <tag policy> 起，Komodo 上的 <workload> 自动完成 CD，无需再手动介入。>

## 自动部署入口

- **触发标签**: `iac:deploy`
- **子形态**: CI/CD onboarding
- **目标 IaC 仓库**: `mouriya-s-lab/<homelab-tf|pve-vctcn>`
- **收货即得**: 既定 source 事件触发所需的构建/打包/发布或声明同步，并自动部署到已选 Komodo 终点的常驻链路；不重跑已有产物构建
- **收货后运维**: 后续 workload 版本 rollout 由 source/workload repo 的 workflow / stack 完成；新 IaC 需求仍按边界另行路由

## Workload 契约

- **workload**: <一句话>
- **源码**: <owner/repo>、branch <…>、tag policy <…>
- **已选部署终点及依据**: <Komodo 常驻自动 CD；决策来源；已知身份或待分配约束>
- **artifact/声明形态及消费路径**: <…>
- **artifact/声明可行性证据**: <…>
- **运行接口**: <…>
- **调用方 / 被调方**: <…>
- **持久化**: <…>
- **secrets by purpose**: <…>
- **产品硬约束**: <…>
- **out of scope**: <…>

## 装配范围

只勾本次真正需要：

- [ ] GARM repository + pool 定义
- [ ] registry 授权 / Keycloak `registry` realm 拉取账号
- [ ] Komodo Server / ResourceSync 记录
- [ ] Stack 声明 + Variables + secret 授权路径
- [ ] source repo 里的 CI workflow
- [ ] 首次 apply / 首次 DeployStack

## 约束

- <目标 IaC repo 的 AGENTS/rules 摘要>
- <凭据来源：SOPS / Keychain / Komodo / OpenBao / 既有 CLI auth>
- <mesh 与 registry 惯例见 `local-cicd`>

## 验收标准

| # | 维度 | 检查 | 命令 | 环境 | 预期 |
|---|------|------|------|------|------|
| 1 | preview | IaC 变更边界 | `<plan/check>` | local | 无非预期 drift |
| 2 | apply | 装配 GARM / Core / Stack / workflow | `<apply/deploy>` | local + source repo | exit 0 |
| 3 | live-state | 读回装配 | `<当前 garm-cli 及 km-* / km-api 已确认的只读命令>` | live | pool、Server、Stack、ResourceSync 指向声明 |
| 4 | first-deploy | 首次 CD 端到端 | `<实际 tag / workflow_dispatch / 声明更新入口>` | source、GARM、Komodo 与 workload | 所需 artifact/声明生效、部署完成、runtime smoke 过 |
| 5 | 无人工链路 | workflow 已含本契约所需产物处理/声明同步及 RunSync/DeployStack；无手工缺口 | 核对实际 workflow 和第一次运行证据 | source repo + live | 后续版本只需既定 source 触发事件 |
| 6 | 复算 | 以第二个不同 workload 版本触发真实自动 rollout | `<既定 tag push / release publish / 声明更新入口>` | source、Komodo 与 workload | 自动 rollout 完成；实际运行实例的 image digest / artifact 或运行版本与首次不同、runtime smoke 过；仅声明版本变化不算 |

行 5、6 是本子形态独有的收货点：一次 apply 成功还不够，要证明**链路常驻**。

## 依赖关系

- Depends on: <…或「无」>
- Blocks: <…或「无」>
```

## 收货边界

首次 apply 成功不等于 onboarding 成功。缺第二次不同版本的自动 rollout，就仍未完成本契约；不能降级为普通部署来绕过验收。混入 host、网络或根信任变更时，用关联的 `iac-auto-deploy-issue` 承接其独立范围。

装配命令和终态从 `local-cicd`、当前 repo 和对应 `km-*`/`km-api` 取得；不要把模板中的操作名拼成未经核实的 CLI。
