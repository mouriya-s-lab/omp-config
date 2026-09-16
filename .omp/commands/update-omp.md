---
description: 用本仓库快照更新本机 OMP 配置（repo → 本机）
---

用本仓库快照更新本机 OMP 配置。方向与 `/sync-omp-config` 相反。

## 方向

严格单向：仓库 `agent/` → 本机 `~/.omp/agent`（**会写本机**）。与 `/sync-omp-config`（本机→仓库、只读本机）互为反向。本机 agent 目录取值：`PI_CODING_AGENT_DIR` 非空时取其目录，否则 `~/.omp/agent`。

## 更新范围

常规只更新下面四项。其余（`config.yml`、`settings.json`、`models*`、数据库、WAL、会话、缓存、日志等）默认**不动**，只有初始化（`init` 参数）时才迁移：

| 仓库 | 本机 |
| --- | --- |
| `agent/agents/` | `~/.omp/agent/agents/` |
| `agent/extensions/*.ts` | `~/.omp/agent/extensions/` |
| `agent/APPEND_SYSTEM.md` | `~/.omp/agent/APPEND_SYSTEM.md` |
| `install-plugins.sh` 的插件列表 | 本机已装插件 |

## APPEND_SYSTEM 与 agents

- `agent/APPEND_SYSTEM.md` 直接覆盖本机同名文件。
- `agent/agents/` 覆盖到本机，先 `diff -rq` 确认范围再复制。

## 扩展（extensions）

1. 把仓库 `agent/extensions/*.ts` 复制/覆盖到本机（同名覆盖，缺的补齐）。
2. **绝不删除、绝不覆盖**本机由应用安装器管理、仓库不收录的文件：首行为 `// @orca-managed-pi-extension` 的 `orca-*.ts`、任意行含 `marker: _otty` 的 `otty-integration.ts`、以及 `README.txt` 等仓库没有的文件。命中标记就跳过，不能仅凭文件名判断。
3. 复制之外不删除本机多出来的扩展；仓库删掉某扩展不等于要在本机移除（扩展的移除请人工处理，本命令不自动卸）。
4. 有的扩展要初始化、写配置文件或下载资产才生效，且配置本机相关：
   - `doc-polish.ts` 需要同目录 `doc-polish.json`（模型名 / 并发）。
   - `unified-exec-bun-pty.ts` 需要 PTY 原生包缓存。
   - `commandcode-model-spec.ts` 依赖本机生成、不迁移的 `commandcode-models.json`。
   这类初始化 / 配置文件：**本机已存在就不动**；不存在则询问用户是否创建、内容怎么填（模型等本机相关值），拿不到确认就跳过该项并在报告里说明，绝不擅自写。

## 插件（plugins）

插件更新较复杂，分两步，全部以脚本输出为准，不要自己再手工扫描 / 判定一遍：

1. 跑 `./plugin-audit.sh`，直接读它的分类结论。该脚本以基准提交 `5974c4fa` 起扫 `install-plugins.sh` 的历史插件名（仅这一个脚本），归一后与 `omp plugin list` 对比，直接给出：
   - `[安装]` 脚本要求但本机缺 → 跑 `./install-plugins.sh` 补齐（`omp install` 幂等，只装缺的）。
   - `[卸载候选]` 历史存在过、当前脚本已移除、本机仍装 → 询问用户是否卸载。并告知用户：如果不清楚这些插件是干什么的，配置作者把它从脚本里移除通常已经过验证，可以直接删。用户确认后 `omp plugin uninstall <name>`。
   - `[保留]` 本机装、脚本历史从未登记 → 用户自装的，勿动。
2. 脚本已经把历史并集与 `omp plugin list` 的对比算好，直接按它的四类结论行动，不要凭记忆或再跑一次扫描重算。

## 初始化（`init` 参数）

只有初始化时才额外迁移平时不动的项（覆盖本机，会盖掉本机 machine-specific 值，**逐项先向用户确认**）：`agent/config.yml`、`agent/settings.json`。数据库、WAL、日志、会话、缓存、`models.yml`、`commandcode-models.json`、`last-changelog-version` 一律不迁。

## 校验

1. 复制的普通文件与仓库源 `cmp` 一致。
2. 动过 `config.yml` / `settings.json` 时用 `bun -e` 确认可解析（`Bun.YAML.parse` / `JSON.parse`）。
3. 不打印凭据；不把明文凭据写进本机。
4. 报告实际改了哪些文件、装 / 卸了哪些插件、哪些初始化或配置项因等用户确认被跳过。
5. 生效需**重启 OMP**：APPEND_SYSTEM、扩展、插件在下次启动加载。

## 参数

`$ARGUMENTS`

- 为空：常规更新（agents / extensions / APPEND_SYSTEM / plugins）。
- `check`：只逐项比对并报告差异（含跑 `plugin-audit.sh` 展示插件对比），不复制、不装卸、不写本机。
- `init`：在常规更新基础上，额外迁移 `config.yml` / `settings.json` 等初始项，逐项先确认。
