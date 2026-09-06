---
name: writing-issue
description: 起草或修订单个 GitHub issue，定义结果验收、spike 和 parent 归属；相关 issue 树转 writing-complex-issues。
---

# writing-issue

本 skill 管单个 issue 的问题、结果契约和归属。两个及以上相关 issue 用 `skill://writing-complex-issues` 组织成树；PR 证据用 `skill://writing-pr`，关闭裁决用 `skill://review-pr`。

## 先取得事实

- 按 `~/.claude/rules/github-issue-pr-routing.rule.md` 分配 issue/PR 语义；更严的 repo-local `CLAUDE.md` 优先。目标 repo 使用 coder-loop preset 时，先读 `presets/<preset>/contract.md` 的分类 label、必需段和 review replay 契约。
- 读取 issue/PR 必须按 `~/.claude/rules/gh-full-fetch-issues-prs.rule.md` 一次完整落盘：正文、全部讨论/评审、timeline、checks、labels、assignees、图边和附件，分页取全；随后只分析本地文件。先遵守该规则要求的落盘位置规则。不用 `gh issue view` 的窄输出或仅 ID 查询代替完整上下文；现有工具无法完成完整抓取时明确 tooling gap，不假设存在 helper。
- 每句动机可追溯到真实来源：原文引用 + issue/PR 链接、`owner/repo@<sha>`、代码或日志锚点，或操作员方向原文与日期。转述标清来源；不拼接不同来源伪装成一句引用，矛盾要点明。
- 起草前落实业务输入：具体 workload、样本总体、使用场景、验证对象及受益者。不能以未定义的「真实 / 目标 / 代表性 X」替代，也不把定义责任下推给实现者。源未指定且调查未能确定的行为、依赖、约束不自行添加。

## 一个问题，一份结果契约

**原子性：** 一段连贯 Why 能论证整个 issue；若自然裂成几个独立问题，就拆 children，由 umbrella 说明共同 driver。不要按版本、批次、repo、时间窗或标题关键词机械分组，归属要读实际 body 后判断。标题和正文不放草稿 ID、agent ID、working-group 名或临时源树路径；关联项用标题或真实链接。

**方案边界：** 定义问题、外部约束、预期结果和 checkpoint，不预钉内部结构、模块、协议、状态机或命名。源要求的外部契约除外；`iac:deploy` 按 `skill://iac-auto-deploy-issue` 写已决定的部署契约、目标 repo、artifact 和 live 验证。

**未知：** 未文档化第三方行为、跨环境可行性等高风险假设先 spike，并 Blocks 实现。环境暂不可用的验证必须有具名下游 owner，写入继承验证义务；继承义务不可二次延期。

### checkpoint 写法

future-work 的每行都有 `Dimension / Check / Command / Env / Expect`：具体可执行命令、目标环境、期望读数或 exit status。维度按真实风险选择 `function`、`environment`、`integration`、`assumption`；涉及 Docker、网络、部署、browser、外部服务或跨 repo 时不能 function-only。

`## 预期结果` 每条 bullet 必须由至少一行通过真实路径直接观察**该结果本身**，Check 列点名覆盖条目。typecheck、套件计数、残留 grep 仅作卫生补充，不计入覆盖。覆盖行也不能引用本次实现者将自写的测试；用固定文本 inline driver、真实 CLI/API/UI 或外部终态读数，避免测试注值绕过真实入口。运行强度遵从 `~/.claude/rules/runtime-verification-required.rule.md`。

checkpoint 验结果和被拒的无效行为，不用它强制个人实现偏好。某结果当前无法检验，改成可检验形态或明确进入具名继承义务，不留隐式缺口。发布前模拟最省事的通过路径：若用户问题没解决也能全绿，锐化结果 checkpoint；易混术语首次出现即消歧。

## 模板

正文中文、简练；代码标识符、命令、路径、API/label、维度名、`Depends on` / `Blocks` / `RFC:` 保留英文，源引文和工具输出保持原样。已落地用过去时，计划工作用祈使句。

### future-work 实现 issue

```markdown
# <中文标题：一个问题>

## 目标

<设计源或用户请求中的目标。>

## 上下文

- **Repo**: `owner/repo`（path: `/local/path`）
- **Working directory**: <如适用>
- **Design doc / source**: <路径、issue/PR 链接或用户请求原文>
- **Conventions**: <跨 repo 时明确遵从哪一份契约>

## 问题

<可观察的问题、Why 与来源，不写代码改法。>

## 预期结果

- 结果 1：<可观察终态。>

## 约束

<可选；源强加的外部约束。>

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | function | 覆盖结果 1：<直接观察什么> | `<可执行命令>` | <具体环境> | <读数 / exit code> |

## 继承验证义务

<可选；同验收表，加 From / Original # 列，注明 owner，不可二次延期。>

## 依赖关系

- Depends on: <issue 链接>（<需要的上游后置条件>）
- Blocks: <issue 链接>（<谁需要本结果>）
```

umbrella child 的继承快照、使用场景、baseline、不应残留等扩展按 [child-body.md](../writing-complex-issues/references/child-body.md)，不另设一套 child 模板。

### spike issue

```markdown
# Spike: <验证的一个假设>

## 目标

Verify assumption: <具体 claim>

## 上下文

- **Repo / Design source / Assumption source**: <原文与可核实来源>

## 验证步骤

1. <具体可执行步骤。>

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | assumption | <验证什么> | `<命令>` | <目标环境> | <期望读数> |

## 结果分支

- **If passed**: 进入 <实现 issue 链接>。
- **If failed**: 带证据开 design-question，不进入实现。

## 依赖关系

- Blocks: <依赖该假设的实现 issue 链接>
```

### retroactive umbrella

追溯性组织属于树，使用 [umbrella-body.md](../writing-complex-issues/references/umbrella-body.md) 的 retroactive 模板。它记录已落地事实，不使用未来 Acceptance 清单；不回写已落地 issue/PR。

## 归属、发布与修订

1. 按 driver 选 home repo：IaC 驱动归 IaC repo，app 驱动归 app repo；CICD onboarding parent 在应用 repo。
2. 先定 parent。通过完整本地 payload 确认已有 parent 仍合适；新层级先建 parent 再建 child。一个 child 一个 issue parent，另一条线用散文引用。跨 repo（同 org）可连接，无需复制任务。
3. API 操作及失败恢复见 [sub-issue-api.md](references/sub-issue-api.md)。PR 只用 closing keyword 连接 issue，不参与 sub-issue 边。
4. 发布前检查：原子 Why 与来源、具体业务输入、外部约束、逐条结果覆盖、可跑命令和真实风险维度、延期 owner、对抗捷径，以及 repo/preset 必需段。起草中的 Source bundle 和内部脚手架不落 GitHub。
5. 活跃 issue（包括 umbrella 和原子 child）的错误引用、作废前提、错误范围或过时铺垫直接替换；裁决、范围扩展、设计演进以 comment 留迭代记录。树内同时核对引用锚和活跃 child 的继承快照，按 [comment-layers.md](../writing-complex-issues/references/comment-layers.md) 保持当前任务与决策记录一致；已落地记录遵守全局不可变边界。

历史验收失败案例仅在需要理解反例时读 [acceptance-cases.md](references/acceptance-cases.md)。
