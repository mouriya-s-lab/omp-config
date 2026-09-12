---
description: 把本机 ~/.omp 配置同步进本仓库快照（单向）
---

把本机 OMP 配置同步到本仓库快照。

## 方向

严格单向：`~/.omp/agent` → 本仓库 `agent/`。只读本机文件，**绝不写回 `~/.omp`**。本机文件 mtime 必须在本命令执行前后保持不变，作为未回写的证据。

## 同步内容

| 本机 | 仓库 |
| --- | --- |
| `~/.omp/agent/config.yml` | `agent/config.yml` |
| `~/.omp/agent/settings.json` | `agent/settings.json` |
| `~/.omp/agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM.md` |
| `~/.omp/agent/agents/` | `agent/agents/` |
| `~/.omp/agent/extensions/*.ts` | `agent/extensions/`（见排除项） |

## 排除项

绝不复制：`*.db*`、`*-wal`、`*-shm`、`*.lock`、`models.yml`、`models.yml.bak-*`、`commandcode-models.json`、`last-changelog-version`、`sessions/`、`terminal-sessions/`、`blobs/`、`cache/`、`logs/`。

`agent/extensions/` 下由应用安装器生成并重写的文件不收录，命中任一标记即排除：

- 文件第 1 行是 `@orca-managed-pi-extension`（`orca-agent-status.ts`、`orca-prefill.ts`、`orca-titlebar-spinner.ts`）
- 文件任意位置出现 `marker: _otty`（`otty-integration.ts` 第 15 行的注释，**不在首行**）

标记缺失时按普通扩展同步，不要仅凭文件名排除。

## 步骤

1. 逐文件比对本机与仓库，列出"仓库缺失 / 内容不同 / 本机已删除"三类差异；无差异就直接报告已同步，不做多余改动。
2. 差异文件用 `cp` 覆盖到仓库；`agents/` 与 `extensions/` 先 `diff -rq` 确认范围再同步。
3. 若本机 `~/.omp/plugins/package.json` 的依赖集合与 `install-plugins.sh` 的插件列表不一致，按下述规则重写列表：URL/Git 依赖原样保留，npm 依赖写成不带版本号的名字。
4. 校验：每个同步文件与源文件 `cmp` 一致；`bun -e` 能解析 `agent/config.yml`（`Bun.YAML.parse`）和 `agent/settings.json`（`JSON.parse`）。
5. 扫描仓库无明文凭据：`sk-`、`ghp_`、以及超长的 `apiKey: <值>`。
6. `git status --short` 确认没有数据库、WAL、sessions、缓存或插件运行时文件进入仓库。
7. 提交并推送，commit message 用 `chore: sync snapshot with local omp config`，正文列出本机实际变化。

## 参数

`$ARGUMENTS`

- 为空：执行完整同步流程。
- `check`：只做第 1 步并报告差异，不复制、不提交。
