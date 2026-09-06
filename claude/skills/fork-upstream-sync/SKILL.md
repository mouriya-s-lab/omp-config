---
name: fork-upstream-sync
description: 配置或排查 fork 自动上游同步：干净前缀经 CI 自动合并，冲突尾部留待人工处理。使用本目录 sync-upstream.yml，重点检查 PAT、CI 闸门、固定分支与重入保护。
---

# Fork 自动上游同步

本教程和 [sync-upstream.yml](sync-upstream.yml) 是这套同步机制的本地操作入口。是否采用、fork 定制放哪里，遵循 `~/.claude/rules/fork-customization-placement.rule.md`；目标仓库的交付规则仍适用。不要从 gist 或记忆重建 workflow。

## 先理解会发生什么

模板每天 06:00 UTC 执行，也可手动触发。它用 merge PR 保留提交历史，不是对已发布分支执行 rebase。

| 检查结果 | 后续行为 |
|---|---|
| 存在带同步 label 的 open PR | 整轮跳过，不推送同步分支 |
| 上游没有新提交 | 输出 `No new upstream commits.`，不建 PR |
| 整批可干净合并 | 更新 `sync/merge`，创建或复用 PR，CI 通过后尝试合并 |
| 先有干净前缀、后有冲突 | 前缀 CI 通过且合并成功后，重新 fetch 接收分支，再创建 `sync/review` |
| 前缀 CI 未通过或合并失败 | 保留前缀 PR，本轮不创建尾部 PR；后续运行被 open PR 闸门挡住 |
| 第一个新提交就冲突 | 没有前缀 PR，只创建人工 review PR |

固定的 `(head, base)`、现有 PR 查询及创建失败后的回查共同避免重复 PR；`concurrency` 避免定时与手动运行互抢。不要为了让下一轮继续而移除 label、删除分支或强推正在人工处理的 PR。

`gate_and_merge()` 显式检查 CI 和 `gh pr merge` 的退出状态：只有两者都成功才返回 0 并打印 `auto-merged`；任一失败均返回非零。前缀调用方据此停止本轮，不开放冲突尾部。调用方使用 `||` 或 `if !`，因此该检查必须保留在函数内部，不能依赖 shell 的 `errexit`。细节见 [机制与故障分析](references/mechanism.md)。

## 1. 确认目标和自动合并影响

在 fork 的本地 checkout 中操作。先读目标仓库规则，确认 `origin` 是 fork、`upstream` 是同步源，以及实际默认分支。不要照抄模板中的 OpenAlice URL 或 `master`。

```bash
git remote -v
gh auth status
gh repo set-default <owner>/<fork-repo>
```

活跃 GitHub 账号应是 `RiriAgent`；不为解决权限问题擅自切换账号。`set-default` 防止双 remote 时后续 gh 操作落到上游。

接入前明确：

- CI 必须由同步 PR 真正触发，且结果能覆盖准备自动合并的改动；“没有 checks”不算通过。
- 自动合入默认分支是否触发发布或部署，要在目标仓库核实。模板注释里的“Release 已禁用”是实例背景，不会替新仓库禁用发布。
- 分支保护、仓库权限与目标仓库的 issue/PR 约定允许这条交付路径。
- Runner 的 Git 支持 `merge-tree --write-tree`。检查实际 runner 工具能力，不把某个历史版本号当成环境保证。

## 2. 接入 SYNC_PAT

模板同时把 `SYNC_PAT` 用于 checkout/push 和 `GH_TOKEN`。本流程要求 PAT，不替换成默认 `GITHUB_TOKEN`：需要推送 workflow 文件、创建同步 PR，并让该 PR 触发 CI。

优先复用已有凭据路径。`gh auth status` 可检查当前账号和 classic token scopes，但不要运行会把 token 明文输出到对话的命令。确认 classic token 有目标仓库访问权和 `repo`、`workflow`；fine-grained token 则核对目标仓库与 Contents、Pull requests、Workflows 写权限。

已有授权足够时直接管道存入目标仓库 secret：

```bash
gh auth token | gh secret set SYNC_PAT --repo <owner>/<fork-repo>
gh secret list --repo <owner>/<fork-repo>
```

第二条只核对 secret 名称，不读取值。权限不足先检查当前账号、授权与既有 secret store；确需引入新 PAT 时按全局凭据规则通过受支持认证流程创建并持久化，不要求用户粘贴 token，也不把交互输密码写成自动化兜底。

## 3. 安装模板

将本目录 `sync-upstream.yml` 作为源模板带入目标仓库 `.github/workflows/sync-upstream.yml`，通过该仓库的正常交付流程提交并验证。模板已包含 merge 失败传播；接入时保留该闸门，按实际目标设置：

| 字段 | 取值来源 |
|---|---|
| `UPSTREAM` | 核实过的 upstream remote URL |
| `UPSTREAM_BRANCH` / `BASE_BRANCH` | 上游同步分支 / fork 接收分支 |
| `MERGE_BRANCH` / `REVIEW_BRANCH` | 两条长期同步分支；默认 `sync/merge`、`sync/review` |
| `SYNC_LABEL` | open PR 重入闸门使用的 label |
| `on.schedule` | 本仓库期望的运行频率 |

保留完整历史 checkout、PAT、CI 闸门、PR 复用、重入保护和 concurrency。模板中的 PR 文案还有 `upstream/master` 等实例文字；更换分支时一并校正文案，不改算法来掩盖配置错误。

修改同步行为时再读 [机制与故障分析](references/mechanism.md)，对照实际 YAML 修改；不要复制一份 helper 另起实现。

## 4. 触发并验收

确认模板已进入目标分支且具备预期权限后：

```bash
gh workflow run "Sync upstream" --repo <owner>/<fork-repo>
gh run list --workflow=sync-upstream.yml --repo <owner>/<fork-repo> --limit 5
gh run view <run-id> --repo <owner>/<fork-repo> --log
```

结合日志与实际分支/PR 状态检查，而不只看 workflow 的绿色状态：

- 本轮走的是“无新提交”“已有 PR 跳过”“单 PR”还是“前缀/尾部”。
- 干净前缀的 CI 确实运行并通过，目标分支确实推进。
- 冲突尾部保持 open，未被自动合并；前缀 CI 失败时没有提前创建尾部。
- 在受控验收中让“CI 通过、合并被拒”成立，确认 workflow 不打印 `auto-merged`、不创建尾部；同时直接核对前缀 PR 和目标分支，不能仅采信日志或绿色 run。
- 有同步 PR 未解决时再次触发，只跳过、不覆盖人工提交。

需要检查 PR 讨论、review 或证据时，遵循完整拉取后本地阅读的规则，不靠零散 API 字段重建状态。历史案例入口见 [历史验证索引](references/validation-history.md)，不能把旧案例当成本次运行证据。

## 5. 失败后怎么处理

| 现象 | 检查与恢复路径 |
|---|---|
| 每轮都跳过 | 查未解决的同步 PR。修 CI 或处理冲突并完成该 PR；不要绕过 label 闸门 |
| push workflow 文件或创建 PR 被拒 | 查本轮实际使用的 `SYNC_PAT`、账号权限和目标仓库；不要盲目扩大权限 |
| CI 未运行或无法合并 | 查触发身份、目标仓库 workflow 与分支保护；不移除 CI 闸门求绿 |
| 有前缀、没有尾部 PR | 查前缀 CI 和合并结果；任一失败时不创建尾部是预期行为。核对实际 PR/目标分支，再处理阻塞 |
| 日志称 auto-merged，但前缀未合并或尾部提前出现 | 对照本目录模板核对目标仓库的 `gate_and_merge()` 和调用方，确认显式失败返回及尾部闸门未丢失；核对实际 PR/目标分支，不继续叠加手动同步 |
| 怀疑创建了重复 PR | 核对固定 head/base、label、并发运行及 helper 回查日志，不凭总数量判断 |
| 目标仓库或分支不对 | 查 remote、`gh repo set-default` 和 env；确认未把 fork 操作发到 parent |
| 输出中的 PR 号混入日志 | helper 的诊断必须走 stderr，stdout 只返回 PR 号 |

冲突处理完成后使用保留历史的 merge；保留两条长期同步分支。轮换 PAT 时更新仓库 secret，并重新确认 push、PR CI 与合并这条完整路径。
