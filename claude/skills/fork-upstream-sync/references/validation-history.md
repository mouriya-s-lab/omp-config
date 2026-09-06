# 历史验证索引

本记录保留原教程的验证场景与证据入口，不代表当前部署已通过验证。引用结论前要检查对应仓库、提交和运行记录是否仍能支持它；新的接入必须按主教程观察本次运行。

## 来源入口

- [Demo fork](https://github.com/RiriAgent/fork-sync-demo) 与 [Demo upstream](https://github.com/RiriAgent/fork-sync-demo-upstream)。
- [Demo Actions](https://github.com/RiriAgent/fork-sync-demo/actions) 与 [历史 PR](https://github.com/RiriAgent/fork-sync-demo/pulls?q=is%3Apr)。
- 最初应用实例：[OpenAlice fork](https://github.com/mouriya-s-lab/OpenAlice)，同步源为 [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice)。这不是其他 fork 的默认配置。
- [gist 备份](https://gist.github.com/RiriAgent/98e72c42466c67bf780748f7e8190dbb) 只作远程历史备份；操作以本地教程和 workflow 为准。

## 原记录覆盖的场景

| 场景 | 当时记录的观察 |
|---|---|
| 所有新提交都可干净合并 | 一个干净同步 PR，CI 通过后自动合并 |
| 有干净前缀和冲突尾部 | 前缀合并，尾部留在人工 review PR |
| 人工解决冲突 | 完成 PR 后下轮恢复同步 |
| 重入闸门 | 存在 open 同步 PR 时 Fetch/Sync 跳过 |
| CI 失败 | PR 保持 open，不合并 |
| 创建竞态 | 临时竞态窗口中另一执行者先建同 head/base PR，模板创建失败后回查并复用 |

竞态案例使用过只存在于 demo 验证中的等待窗口，不应把该测试改动复制进生产模板。原历史摘要没有逐条固定 run ID；因此它是复查索引，不是可直接复用的当前验收报告。
