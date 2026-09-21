---
description: 把本机 ~/.omp/agent 配置同步进本仓库快照（单向）
---

把本机 OMP 配置同步到本仓库快照。

不要使用 subagent，直接执行。

## 方向

严格单向：本机 `~/.omp/agent` → 本仓库 `agent/`。只读本机文件，**绝不写回 `~/.omp`**；本机文件 mtime 必须在本命令执行前后保持不变，作为未回写的证据。先把 `~/.omp/agent` 展开为绝对路径。

## 同步内容

| 本机 | 仓库 |
| --- | --- |
| `~/.omp/agent/config.yml` | `agent/config.yml` |
| `~/.omp/agent/settings.json` | `agent/settings.json` |
| `~/.omp/agent/APPEND_SYSTEM.md` | `agent/APPEND_SYSTEM.md` |
| `~/.omp/agent/thinking-translator.json` | `agent/thinking-translator.json` |
| `~/.omp/agent/config-light.yml` | `agent/config-light.yml` |
| `~/.omp/agent/APPEND_SYSTEM_LIGHT.md` | `agent/APPEND_SYSTEM_LIGHT.md` |
| `~/.omp/agent/omp-light.ts` | `agent/omp-light.ts`（light 源资产） |
| `~/.omp/agent/agents/` | `agent/agents/` |
| `~/.omp/agent/extensions/*.ts` | `agent/extensions/`（见排除项） |

三个 light 源资产只从 `~/.omp/agent` 同步。绝不扫描、复制或提交安装目录（`dirname(Bun.which("omp"))`）中的 `omp-light`、`omp-light.ts` 或 `omp-light.cmd`；这些是机器上的已安装入口，不属于仓库快照。此命令也不安装启动器、不 chmod、不修改 PATH 或任何 shell rc/profile。

## 排除项

绝不复制：`*.db*`、`*-wal`、`*-shm`、`*.lock`、`models.yml`、`models.yml.bak-*`、`commandcode-models.json`、`last-changelog-version`、`sessions/`、`terminal-sessions/`、`blobs/`、`cache/`、`logs/`。

`agent/extensions/` 下由应用安装器生成并重写的文件不收录，命中任一标记即排除：

- 文件第 1 行是 `@orca-managed-pi-extension`（`orca-agent-status.ts`、`orca-prefill.ts`、`orca-titlebar-spinner.ts`）
- 文件任意位置出现 `marker: _otty`（`otty-integration.ts` 第 15 行的注释，**不在首行**）

标记缺失时按普通扩展同步，不要仅凭文件名排除。
## 不同步字段

`agent/config.yml` 以下字段不参与同步到 remote：

- `providers.webSearchOrder`
- `modelRoles`
- `defaultThinkingLevel`
- `skills`
- `symbolPreset`
- `theme`
- `colorBlindMode`
- `hideThinkingBlock`
- `statusLine`
- `terminal`
- `tui`
- `display`
- `worktree`


## 步骤

1. 先把 `~/.omp/agent` 展开为绝对路径，再逐文件比对本机与仓库，列出“仓库缺失 / 内容不同 / 本机已删除”三类差异；差异清单必须包含 `~/.omp/agent/config-light.yml`、`~/.omp/agent/APPEND_SYSTEM_LIGHT.md`、`~/.omp/agent/omp-light.ts`。三个 light 源资产从 `~/.omp/agent` 读取，安装目录中的 `omp-light`、`omp-light.ts`、`omp-light.cmd` 不进入扫描；无差异就直接报告已同步，不做多余改动。
2. 差异文件按上述排除字段规则覆盖到仓库；`config.yml` 不得覆盖排除字段。`thinking-translator.json` 先比对本机与仓库，有差异再覆盖到仓库（本机→仓库）。三个 light 源资产按表中一一对应关系同步到 `agent/`；`agents/` 与 `extensions/` 先 `diff -rq` 确认范围再同步。此步骤只写仓库工作树，绝不写本机、安装目录、PATH 或 shell rc/profile。
3. 若本机 `~/.omp/plugins/package.json` 的依赖集合与 `install-plugins.sh` 的插件列表不一致，按下述规则重写列表：URL/Git 依赖原样保留，npm 依赖写成不带版本号的名字。
4. 校验：普通同步文件（含三个 light 源资产与 `thinking-translator.json`）与源文件 `cmp` 一致；安装目录的任何启动器都不参与校验；`config.yml` 只比较未排除字段，排除字段不参与同步校验；`bun -e` 能分别用 `Bun.YAML.parse` 解析 `~/.omp/agent/config-light.yml` 和 `agent/config-light.yml`，并能解析 `agent/config.yml`（`Bun.YAML.parse`）、`agent/settings.json` 和 `agent/thinking-translator.json`（`JSON.parse`）。
5. 扫描仓库无明文凭据：`sk-`、`ghp_`、以及超长的 `apiKey: <值>`。
6. `git status --short` 确认没有数据库、WAL、sessions、缓存、插件运行时文件或已安装的 `omp-light` shims 进入仓库。
7. 提交并推送，commit message 用 `chore: sync snapshot with local omp config`，正文列出本机实际变化。

## 参数

`$ARGUMENTS`

- 为空：执行完整同步流程。
- `check`：只做第 1 步并报告差异，不复制、不提交。
