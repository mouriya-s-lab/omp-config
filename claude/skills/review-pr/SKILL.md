---
name: review-pr
description: 审核 open PR、重试证据和 issue 关闭条件，裁决 request-changes、no-code、invalid、duplicate 或 blocked。
---

# review-pr

本 skill 决定检查顺序、证据是否成立和允许的裁决，不代替实现者补交付。问题契约见 `skill://writing-issue`，四层证据见 `skill://writing-pr`，parent/child 完备性见 `skill://writing-complex-issues`。

先按 `~/.claude/rules/gh-full-fetch-issues-prs.rule.md` 完整取得本地 issue/PR payload 和附件，包含所有 review/thread、timeline、checks 与图边；用完整上下文判断新决定和重试。源码和 diff 从本地 checkout 读取，不经 GitHub API 取代码。讨论位置及合并后不可变边界按 `~/.claude/rules/github-issue-pr-routing.rule.md`。

## Review 边界

- **把关，不代工：** 不替作者补缺失测试、截图、PR body 或代码。独立核实已有证据/发现可以做，但不能把自己补跑的结果当成作者已交证据；缺口要求作者在 PR thread 补。
- **结果优先：** 验收表全绿只是必要条件。每条预期结果还要有真实路径直接观察它的覆盖行；卫生检查和实现者本次自写测试不算覆盖。缺口是 issue 契约问题，先指出并要求修正契约；不能放行，也不能让实现者中途改契约来匹配实现。
- **关闭有语义：** 原子结果和 checkpoint 满足，且实现已合并或有正当 no-code 理由，才完成。parent/wrapper 还须全部 child/subtask 完成且 parent 级验证通过；连贯剩余交付物必须有 child 承载，不因它是 parent 就跳过。

## PR 审查与 issue 关闭

Gate 1–5 决定 open PR 是否可批准，按序检查，首个失败即停。Gate 6 独立决定 issue 是否可关闭：批准尚未合并的 PR 不等于接受 issue 已完成。open PR 的实现/证据反馈发 PR thread；issue 契约本身的争议按全局路由回 issue，并在 PR 指明阻塞。

### 1. 目标身份

确认 repo、base branch、预期目标与恰好一个真实 closing issue；diff 不是不相关问题的拼盘。无 PR 时，no-PR 路径要有 issue/PR 历史中的显式理由。身份或关闭条件不成立就说明缺失项，不进入代码 review。

### 2. 路由

问题、Why、scope、结果和 follow-up 在 issue；PR 是 diff cover letter 和证据。PR 出现后的实现/重试不能只留在 issue、本地 handoff 或 memory。证据错放时要求补 PR body/thread，而非 reviewer 搬运代交。

### 3. Body 与证据形式

按 `writing-pr` 或更严的 repo-local 契约核对：closing keyword 第一行、默认中文、必需段、四层内容或明确不适用理由、总体分析。每段输出都说明它证明哪个结果/checkpoint。形式不全先补，再进代码 review。

### 4. 证据实质

逐条把预期结果映射到真实观察，重放行数不能替代业务覆盖。命令、环境、exit status、具体读数、日志/工件足以复现；正面与负面/错误/禁用路径符合 issue 和 `writing-pr` 要求。截图必须 reviewer 可见，Web 路径与 UI 截图满足 `~/.claude/rules/runtime-verification-required.rule.md`。CI 或本地 CI-parity 状态如实记载，但不是业务证明。过期、局部、仅本地、凭记忆或含糊的证据要求作者重新采集。

### 5. 代码与检查

前四 gate 通过后，交执行层检查本地 diff：实现是否满足目标、有没有越界、测试/检查是否覆盖风险、是否泄漏 secret/运行时文件/生成垃圾、是否符合 repo 惯例与安全要求。执行层只产出发现，不替本协议裁决；不能用手工 grep 冒充执行层已完成。

### 6. 关闭资格

- 原子 issue：实现 PR 已合并，或 no-code 理由已明确发布。
- parent：全部 child/subtask 完成，parent 级标准也满足；无合并 PR 的 child 有可引用的 no-code/duplicate/invalid/out-of-scope/already-satisfied/moot 理由。
- blocked：外部 blocker 具体且已发布，写明解除条件。
- invalid/duplicate/moot：理由持久、带链接/引用。

存在剩余交付物则要求原子 child，不能靠 wrapper 标签接受关闭。Gate 1–5 全过的 open PR 可以按 repo 政策 approve；在实际合并前，关联 issue 仍不满足 Gate 6。执行层的 Ready to merge 既不代替前五个 gate，也不授权提前关闭 issue。

## OMP 执行层

使用当前 `task` 工具的 `unrestricted` 子代理执行只读代码审查。按全局能力档位配置使用最强档，不使用禁用的 bundled `reviewer` 或省略 agent 字段后落到默认 `task`。不依赖旧插件 slash command，也不因磁盘上有插件文件就声称它在 OMP 可调用。

交给执行者的任务应包含：

- 本地 checkout、真实 base/head commit 或未提交改动范围；完整本地 issue/PR payload 与附件位置。
- 目标契约、作者提供的证据位置、repo-local 规则，以及需要特别核对的类型、错误恢复、安全或交互风险。
- 只读边界：不修改代码，不替作者补测试/截图/证据，不创建或修改 GitHub 对象，不运行会改变环境的验证。
- 输出契约：每个发现包含 `file:line`、可观察后果和依据；区分已证实缺陷、疑点和未覆盖范围；找不到问题时如实报告检查范围，不凭空凑发现。

同一 diff 同一目的不重复分派。按实质独立范围拆任务，而不是固定凑多个角色。Main 核实发现并裁决，不能把子代理的结论直接当成已通过全部 gate。

所需子代理能力实际不可用时报告 Gate 5 blocker，不偷偷安装插件或退回更弱档；源码仍只从本地 checkout 读，GitHub 元数据仍走完整本地 payload。

## 消化报告

审查发现按以下步骤消化；这些是本协议的核实步骤，不要求加载其他插件，也不进入实现：

1. 读完整发现，理解主张；不懂先澄清。
2. 对照本地 diff、周边代码、repo 契约与设计记录核实。agent 可能判断错，严重级别不是证据。
3. 评估本 repo 的既有架构决策与风险容忍度；与它们冲突的建议给出技术反驳。
4. 存活发现转为带 `file:line`、可观察影响和具体要求的 PR-thread 评论；未成立的丢弃或说明反证，不原样转发每条 Critical/Important。

## 裁决

| 裁决 | 条件 / 后续 |
|---|---|
| Approve / accept PR | Gate 1–5 全过；按 repo 政策处理合并。issue 关闭资格另按 Gate 6 判断。 |
| Request changes | PR 协议、证据、代码或检查不足；要求在 PR thread。 |
| Needs PR-thread response | 反馈仅在 issue/handoff 处理；要求补 PR 评论并按需更新 body。 |
| Needs issue split / child issues | 拼盘或 parent 有连贯剩余交付物；要求按 issue 树契约拆分/挂接。 |
| No-code close | duplicate/invalid/out-of-scope/already-satisfied/moot，理由在 issue。 |
| Blocked | 具体外部依赖或不可用执行能力阻塞，发布解除条件。 |
| Do not close | 证明或 child 完成度不足。 |

输出指出首个失败 gate、依据链接/文件锚点、已确认与未确认部分及下一步责任人。已合并后的缺陷另开 issue，不回写旧 PR。
