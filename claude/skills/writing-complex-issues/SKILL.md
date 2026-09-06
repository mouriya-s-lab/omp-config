---
name: writing-complex-issues
description: 将相关任务或审计、调查、review 的多个发现组织为 umbrella/RFC 与原子 children，审查树的覆盖与依赖，收口目标级决策；单个 issue 用 writing-issue。
---

# writing-complex-issues

交付的是能在 headless 环境仅凭完整 issue thread 执行的任务树：目标自包含，实现细节不预钉。每份任务需要业务（谁观察到什么、为何值得做）、架构（部件与边界、防什么漂移）和已核实代码锚点。

单个 issue 的原子性、引用真实性、中文正文、结果验收和完整 GitHub 抓取入口继承 `skill://writing-issue`；图边、讨论位置与已落地记录按 `~/.claude/rules/github-issue-pr-routing.rule.md`。不要重复发布相互关联却没有共享根的平铺 issues。

## 开树前：解析操作员方向

| 输入 | 落位 | 尚未确定时 |
|---|---|---|
| 指称对象（我们的 API/CLI/系统） | 具体 repo、环境与版本锚；umbrella 说明认定依据 | 写 unknown、定位步骤，由 audit child 建立事实；环境推断标假设及证伪方式，不编路径。 |
| 原文方向 | 逐字引用并标日期；只有方向一个来源也可以，不凑假引用 | 对照实际请求，不能复述成伪造引文。 |
| 业务动机 | 有来源的 Why，不用目标复读充当动机 | 先查已有上下文；操作员独有且缺失的事实回传，或显式登记假设及镜头修正入口。 |
| 交付约束 | 截止期转绝对日期、预算入契约；children 逐字快照继承 | 没给就不虚构。 |

按问题性质决定 parent，不按发现途径、repo 或批次机械分组。一个 child 只有一个 issue parent；跨线影响用引用。高风险第三方/跨环境假设先 spike 并 Blocks 实现。

## 成树判据（发现多于一个就先问树）

树有两个入口，本方法对两者同等适用：**自顶向下**（方向 → 拆解成 children）与**自底向上**（审计 / 调查 / review 先产出 N 个发现，再组织成树）。判据：同一方向或同一次调查产出 ≥2 个相关 issue 即是树——先写 umbrella 再写 children，因为契约、决策收口、共享根因、编排这些全局层**只在树根有家**，平铺发布后无处回填。

自底向上路径的失败模式（每条都让原子性合规掩盖树缺位）：

- **平铺 N 个原子 issue 各自发布**——每个 issue 单看合格，但共享根因不可见、跨 issue 的「二选一」留白原样转嫁给实现者、全局求解从未发生。
- **每个 issue「依赖关系：无」**——语义上无依赖，物理上多个 issue 同改一个文件；并行执行时互相冲突（见 references/umbrella-body.md 依赖图与编排）。
- 反向失败同样存在：真正互不相关的发现不强行同树——parent 归属由问题性质决定（见 references/child-body.md）。

## 内容分类

| 类别 | 处置 |
|---|---|
| 已知事实与约束 | 写来源；包括业务动机、架构不变量、锚点、已裁决目标级决策。children 对继承条款逐字快照，不仅放指针。 |
| 自由实现细节 | 内部命名、命令拼写、模块划分默认留实现者；不同选择不改变操作员结果就不预钉。验收命令本身仍须具体可执行。 |
| 不实验不知道 | 标未知、实验路径、结果分支和解决方 child，不把猜测写成契约。 |

不同选择会改变操作员观察结果的分叉属于目标级决策，必须收口；不能一句「归 PR 定」下推。流程见 decision-closure。

## 按任务读对应契约

| 当前工作 | 必读 |
|---|---|
| 写或改 umbrella / retroactive 层级 | [umbrella-body.md](references/umbrella-body.md) |
| 写或改 child；选 audit/spike/收尾类型 | [child-body.md](references/child-body.md) |
| 补齐决策、架构切片、log 义务或设计修正 thread | [comment-layers.md](references/comment-layers.md) |
| 全文有「归 PR 定 / 待定 / 再说」或目标级分叉 | [decision-closure.md](references/decision-closure.md) |
| 树完成后的对抗审查；用户要求重验 | [adversarial-review.md](references/adversarial-review.md) |
| 发布、挂接、re-parent、label | [mechanics.md](references/mechanics.md) |

只在相应工作不发生时跳过该文档；发布前自检总要过。除用户明确只要草稿外，完整 body + comment 层和对抗审查属于交付，不能把它们隐式留给下个会话。

## 完成方式

- 写不出的区块是调查缺口，不以空话填充。目标完备靠性质、外部契约与目标级裁决，不靠穷举实现。
- 对抗审查每轮换面，查实怀疑并记录反证；连续一轮无新发现才结束，零发现也记录。
- 操作员修正衡量尺时，先实证检查新解释，指出哪些旧产出复读了旧误解，再重扫全部产出；报告区分新发现、修正和重验通过。
- 维护本方法时，用非本方法生成的真实工件做生成性基准，逐区块及 child/comment 层检查方法能否引出它；不拿自己的产出循环确认。具体方法在 adversarial-review。
