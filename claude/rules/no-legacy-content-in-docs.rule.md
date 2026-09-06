---
alwaysApply: true
---

# 文档里不留遗留层 — 改了就直接替换

任何文档改变结论时，先调研到不再摇摆，再删除旧内容并写入新内容，使正文像从来只有当前结论；版本历史归 git。禁止用删除线、“更新/注/之前说错了/Edit/Correction”、旧段后追加否定、旧示例或旧路径历史对照，让相互否定的内容并存。

例外：

- 已合并 PR body、已发出的 issue/PR comment 和 review thread 按 `github-issue-pr-routing` 与 `review-pr` 保持不可变；出错时另开 issue/PR/comment。
- ADR、changelog、migration guide、decision log 等本来用于记录变更的体裁。
- 引用法规、协议或第三方文档固定原文的勘误对照。
