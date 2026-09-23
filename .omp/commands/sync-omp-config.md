---
description: 把本机 ~/.omp/agent 配置同步进本仓库快照（单向）
---

把本机 `~/.omp/agent`（先展开为绝对路径）单向同步到仓库 `agent/`，再提交推送。只读本机，绝不写 `~/.omp`、`omp` 安装目录、PATH 或 shell 配置；本机文件 mtime 前后不变。不使用 subagent，直接执行。

`$ARGUMENTS`：为空执行完整流程；`check` 只做第 1 步并报告差异。

## 同步范围

本机与仓库按同名一一对应：`config.yml`、`settings.json`、`APPEND_SYSTEM.md`、`thinking-translator.json`、`config-light.yml`、`APPEND_SYSTEM_LIGHT.md`、`omp-light.ts`、`agents/`、`extensions/*.ts`、`extensions/lang-nag.json`。

不进仓库：
- 运行时文件：`*.db*`、`*-wal`、`*-shm`、`*.lock`、`models.yml`、`models.yml.bak-*`、`commandcode-models.json`、`last-changelog-version`、`sessions/`、`terminal-sessions/`、`blobs/`、`cache/`、`logs/`。
- `omp` 安装目录里的 `omp-light`、`omp-light.ts`、`omp-light.cmd`；light 三件只从 `~/.omp/agent` 取。
- 应用托管的扩展：首行为 `@orca-managed-pi-extension`，或任意位置含 `marker: _otty`。以标记为准，不凭文件名判断。
- `config.yml` 中的本机字段，仓库保留原值：`providers.webSearchOrder`、`modelRoles`、`defaultThinkingLevel`、`skills`、`symbolPreset`、`theme`、`colorBlindMode`、`hideThinkingBlock`、`statusLine`、`terminal`、`tui`、`display`、`worktree`。

## 步骤

1. 逐文件比对，列出仓库缺失、内容不同、本机已删除三类差异；`agents/`、`extensions/` 用 `diff -rq`。无差异就报告已同步并结束。
2. 把差异写入仓库。结构化配置（`config.yml`、`settings.json`、各 JSON）先 `read` 两边、比出有差异的字段，再用 `edit` 只改这些行，不整文件覆盖、不重新序列化；`config.yml` 的本机字段不写。
3. `~/.omp/plugins/package.json` 的依赖与 `install-plugins.sh` 的列表不一致时，重写列表：URL/Git 依赖原样保留，npm 依赖去掉版本号。
4. 校验：
   - 普通文件与本机 `cmp` 一致；结构化配置除 `config.yml` 的本机字段外，与本机逐字段一致。
   - `config.yml`、`config-light.yml` 能用 `Bun.YAML.parse` 解析，`settings.json`、`thinking-translator.json`、`lang-nag.json` 能用 `JSON.parse` 解析。
   - 仓库里没有明文凭据：`sk-`、`ghp_`、超长的 `apiKey:` 值。
   - `git status --short` 里没有运行时文件、插件运行时文件或已安装入口。
5. 提交并推送，commit message 用 `chore: sync snapshot with local omp config`，正文列出本机实际变化。
