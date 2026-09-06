---
alwaysApply: true
---

# GitHub issue / PR routing rule

# 回复提到github的issue，pr时必须附带链接

跨 repo 默认：Issue 承载 problem、Why、scope、ownership、parent/child、follow-up 和 blocker 等任务语义；PR 承载 closing keyword、diff cover letter、evidence、checks 和实现 review 等实现语义。repo-local `CLAUDE.md` 的更严规则优先。

## 创建与技能

- 没有真实 issue 就不开 PR；先创建或认定 issue，PR body 以 closing keyword 关联它。
- 一个 PR close 一个 issue；多个独立问题拆成多个 issue/PR，除非同属一个连贯 refactor issue。
- Issue body/图位置用 `writing-issue`，PR body/closing/evidence 用 `writing-pr`，review gates、feedback、关闭语义和合并后不可变用 `review-pr`，大型 umbrella/RFC 与原子 children 用 `writing-complex-issues`。

## 对话位置

- PR 出现前，scope、blocker、invalidity、duplicate、no-code 和 retry feedback 放 issue。
- PR 出现后，实现与 review 对话放 PR thread，不得以 issue comment、本地 handoff 或 memory 替代；只有 issue 主题争议、blocked/skipped/no-code 或当前 PR 明确作废时才回 issue。
- Open PR 的 evidence、closing keyword 或 reviewer-visible evidence 不全、错误或过时时更新 PR body；review 后另发 PR comment 总结修改和 evidence。Retry 继续已有 open PR/branch，除非它明确作废或不可用。

## 合并后与图边界

合并后的 PR 是不可变记录，不得回填 closing keyword、改写 evidence 或重建上下文。有缺陷或 follow-up 时新建 issue 和关闭它的新 PR；遗漏 closing keyword 时接受孤立图边，或用新 issue/umbrella 在散文中引用旧 PR。

Issue 可以是 parent/child；PR 不能作 sub-issue child，只能通过 body closing keyword 连接 issue，不能使用 `addSubIssue`。追溯性组织放新 issue/umbrella，不回写已落地的 PR/issue body。
