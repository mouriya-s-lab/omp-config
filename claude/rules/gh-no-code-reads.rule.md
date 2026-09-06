---
alwaysApply: true
---

# No reading code via `gh`

禁止用 `gh`、GitHub API、GraphQL 或 raw URL 读取源码文件、局部文件、blob、range 或作为源码替代品的 PR diff hunk，包括 `contents`、`git/blobs`、`pulls/<n>/files`、`gh browse`、`gh repo view`、`object.text` 和同类调用。

远端源码必须 `git clone` 到本地（可 shallow/partial），checkout 目标 ref 后使用本地 `Read`/`Grep`/`Glob`；无法 clone 就停止并告知用户，不得退回 API 读取。`gh` 仍用于 issue/PR 元数据与变更、reviews、comments、labels、checks、workflow runs/logs、repo metadata、releases、auth 和 gists。

本地 checkout 提供完整上下文和跨文件搜索，并避免 API size cap、base64 和截断产生的假完整内容。
