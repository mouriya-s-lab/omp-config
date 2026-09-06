---
alwaysApply: true
---

# Full-fetch issues and PRs via `gh`, then read locally

选择本地文件的落盘位置时，必须先遵从 `no-tmp-directory.rule.md`。

用 `gh` 读取 issue/PR 时，一次拉取完整对象到本地文件：body、全部 comments、review threads、reviews、timeline、checks、labels、assignees、sub-issue/closing-keyword links，以及 body/comments 引用的全部 attachments；同一步下载 attachments。存在分页时穷尽所有页并合并，再用本地 `Read`/`Grep`/`Glob` 分析。

禁止从 `gh` stdout 分块读取，禁止管道给 `head`/`tail`/`sed`/`awk`/`grep` 截取，禁止用多次窄调用、不同 `--limit` 或 `--json` 字段子集拼装对象；所有切片只对完整本地文件进行。仅在状态可能因新 comment、CI 或用户报告的新活动而变化时重新拉取，且每次仍完整拉取。

完整本地 payload 必须保留最新决定和 review comment、attachment、timeline 之间的上下文，避免分片视图造成错误结论。
