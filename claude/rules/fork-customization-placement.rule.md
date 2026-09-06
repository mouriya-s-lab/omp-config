---
alwaysApply: true
---

# Fork customization placement rule

适用于存在 `upstream` remote、定期 rebase 保持接近上游、正在增加 fork feature/fix 而非修复继承的 upstream bug 的仓库。Fork customization 必须尽量离开 upstream-owned 文件，以降低 rebase 成本。

## 放置顺序：首个可行项即停止

1. 上游存在 `register*`、`setHandler*`、`addProvider*`、`on*Callback` 或 barrel-import self-registration API 时，在 `fork-features/` 新文件顶层注册，只增加一个使其进入执行路径的 barrel import。
2. 没有注册 API 时仍提取到 `fork-features/`，upstream 文件最多增加一行 `import './fork-features/...'`；实现必须自包含，禁止 monkey patch 或伸入上游内部。
3. 前两项都不可行才直接 patch upstream 文件，并逐项记录到 `fork-features/trunk-patches.md`：文件/行、缺失的 API surface、无法提取的原因。每个 trunk patch 都是持续 rebase 成本。

禁止因直接修改更快就碰 upstream 文件、复制上游函数只改一行、把 fork-only 分支塞进上游 `switch/if`，或仅以“现在能工作”保留 trunk patch。每次 rebase 都检查上游是否新增注册 API、原生实现该功能、改变 schema 或删除概念；能迁移就移入 `fork-features/`，过时就删除。

## Upstream sync

用 fork 上的 CI workflow 自动同步，不靠人工定期 `git pull upstream`：

- 最长 cleanly-mergeable prefix 进入 `sync/merge` PR，CI green 后 auto-merge；conflicting tail 进入独立 `sync/review` PR 交给人工。无冲突时只有 auto-merge PR。
- 每种 PR 最多一个，依靠 GitHub `(head, base)` open-PR uniqueness 和 duplicate 422 fallback，而非计数；任一带 sync label 的 PR open 时 re-entrancy gate 跳过运行，禁止 force-push 覆盖人工解决过程。红 CI 保持 PR open 并暂停后续运行。
- 使用 repo secret 中的 PAT，禁止 `GITHUB_TOKEN`：默认 token 不能在 fork 开 PR、无权 push `.github/workflows/*`，且其 PR 不触发 `pull_request` CI。

完整 PAT 配置、workflow、理由和验证记录以 `fork-upstream-sync` skill 的 `SKILL.md` 与 `sync-upstream.yml` 为本地事实源，不使用 gist backup。Clone 同时有 `origin` 和 `upstream` 时，`gh` 默认可能指向上游 parent，必须先执行 `gh repo set-default <owner>/<fork>`，避免 PR/list/run 操作错 repo。
