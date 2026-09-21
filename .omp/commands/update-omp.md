---
description: 用本仓库快照更新本机 OMP 配置（repo → 本机）
---

用本仓库快照更新本机 OMP 配置。方向与 `/sync-omp-config` 相反。

不要使用 subagent，直接执行。

## 方向

严格单向：仓库 `agent/` → 本机活动 agent 目录（**会写本机**）。与 `/sync-omp-config`（本机→仓库、只读本机）互为反向。本机 agent 目录取值：`PI_CODING_AGENT_DIR` 非空时取其目录，否则 `~/.omp/agent`；以下统一记为 `$AGENT_DIR`。先将其解析为绝对路径，再开始写入。

## 更新范围

常规只更新下面仓库快照项。其余（`config.yml`、`settings.json`、`models*`、数据库、WAL、会话、缓存、日志等）默认**不动**，只有初始化（`init` 参数）时才迁移：

| 仓库 | 本机 |
| --- | --- |
| `agent/agents/` | `$AGENT_DIR/agents/` |
| `agent/extensions/*.ts` | `$AGENT_DIR/extensions/` |
| `agent/APPEND_SYSTEM.md` | `$AGENT_DIR/APPEND_SYSTEM.md` |
| `agent/thinking-translator.json` | `$AGENT_DIR/thinking-translator.json` |
| `agent/config-light.yml` | `$AGENT_DIR/config-light.yml` |
| `agent/APPEND_SYSTEM_LIGHT.md` | `$AGENT_DIR/APPEND_SYSTEM_LIGHT.md` |
| `agent/omp-light.ts` | `$AGENT_DIR/omp-light.ts`（light 源资产） |
| `install-plugins.sh` 的插件列表 | 本机已装插件 |

`agent/config-light.yml`、`agent/APPEND_SYSTEM_LIGHT.md`、`agent/omp-light.ts` 必须作为一个整体更新；缺任一仓库源文件就报告精确缺失项并停止 light 安装，不以旧文件或根目录旧版 `omp-light` 代替。

## Light 启动器（`omp-light`）

`/update-omp` 必须先预检这三个源资产和 PATH 上的 `omp`，再写入任何 light 文件：

1. 解析 `$OMP_PATH = Bun.which("omp")`，要求结果是 PATH 上已有的绝对路径；找不到 `omp` 或无法得到绝对路径时报告精确原因并停止，不创建目录、不留下半套安装。
2. 预检全部成功后，若 `$AGENT_DIR` 或其所需父目录不存在才创建；将 `agent/config-light.yml`、`agent/APPEND_SYSTEM_LIGHT.md`、`agent/omp-light.ts` 分别复制到 `$AGENT_DIR` 对应路径。每个目标先写入同目录临时文件，完成内容校验后以原子 rename 替换；不得直接截断目标文件。
3. 取 `$OMP_BIN_DIR = dirname($OMP_PATH)`，把启动器安装在这个**已经在 PATH 上的目录**，不另选目录：
   - **POSIX（macOS / Linux）**：将 `agent/omp-light.ts` 的原始内容以同目录临时文件写入 `$OMP_BIN_DIR/omp-light`，先设置可执行权限 `0755`，再原子 rename 覆盖目标。它必须是带 `#!/usr/bin/env bun` 的源内容本身，不得套一层 wrapper。
   - **Windows**：将同一源内容以同目录临时文件写入 `$OMP_BIN_DIR/omp-light.ts`，并原子写入同目录的 `$OMP_BIN_DIR/omp-light.cmd`。`.cmd` 只做 Bun 转发并保留所有参数，例如：
     ```
     @echo off
     bun "%~dp0omp-light.ts" %*
     ```
     两个文件都先完成后再各自原子替换；不向 `.cmd` 写入配置或凭据。
4. 不修改 `PATH`，不改动 fish/zsh/bash/PowerShell 的 rc/profile，也不替换普通 `omp`；`omp` 继续使用完整模式。若目标目录不可写，报告绝对路径和权限错误，不降级到其他目录。
5. 安装后用同一 PATH 查找规则重新解析 `omp-light`：POSIX 期望 `$OMP_BIN_DIR/omp-light`，Windows 期望 `$OMP_BIN_DIR/omp-light.cmd`。若解析结果不是期望目标，报告“PATH shadowing”并同时列出实际路径和期望路径；只报告，不修改 PATH。

调用方式：fish、zsh、bash 和 Unix PowerShell 都直接使用同一个带 shebang 的 `omp-light` 入口；Windows PowerShell 使用生成的 `omp-light.cmd`。这里仅规定安装/解析行为，不宣称这些 shell 已完成 runtime 测试。

## `check` 模式的 light 检查

`check` 必须只读：按同样的 `$AGENT_DIR`、`Bun.which("omp")` 和 `$OMP_BIN_DIR` 解析，逐项比较三个 light 源资产、已复制到 `$AGENT_DIR` 的文件、已安装入口的内容与权限，并重新解析 `omp-light` 检查 PATH shadowing。若 `omp` 缺失或无法绝对化，仍报告源资产差异，并明确报告安装入口无法定位。缺失、内容不同、权限不符、解析到其他路径都要报告实际路径和期望路径。不得 mkdir、复制、chmod、rename、覆盖、安装/卸载插件或修改任何 shell/PATH；`plugin-audit.sh` 只能按现有规则读取并报告。

## APPEND_SYSTEM 与 agents

- `agent/APPEND_SYSTEM.md` 直接覆盖本机同名文件。
- `agent/agents/` 覆盖到本机，先 `diff -rq` 确认范围再复制。

## thinking-translator.json

- `agent/thinking-translator.json` 是常规托管的根文件（非初始化项）：先比对仓库与本机差异，有差异再覆盖到本机 agent 目录。
- 与 `doc-polish.json`（本机相关、缺失需询问才建）、`commandcode-models.json`（本机生成、不迁移）不同，本文件直接随常规更新迁移。
- 覆盖前后都用 `bun -e` 以 `JSON.parse` 确认可解析。

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

1. 复制的普通文件（含三个 light 源资产）与仓库源 `cmp` 一致；已安装入口按上节的内容、权限和解析路径规则校验。

2. 三个 light 源资产复制后，仓库 `agent/config-light.yml` 与本机 `$AGENT_DIR/config-light.yml` 都用 `bun -e` 的 `Bun.YAML.parse` 分别确认可解析；`init` 动过 `config.yml` / `settings.json` 时，对仓库源和本机目标分别用 `Bun.YAML.parse` / `JSON.parse` 确认可解析；复制或动过 `thinking-translator.json` 时用 `bun -e` 以 `JSON.parse` 确认可解析。
3. 不打印凭据；不把明文凭据写进本机。
4. 报告实际改了哪些文件、装 / 卸了哪些插件、哪些初始化或配置项因等用户确认被跳过。
5. 生效需**重启 OMP**：APPEND_SYSTEM、扩展、插件在下次启动加载。

## 参数

`$ARGUMENTS`

- 为空：常规更新（agents / extensions / APPEND_SYSTEM / thinking-translator.json / 三个 light 源资产 / plugins，并安装或原子替换 `omp-light`）。
- `check`：只逐项比对并报告差异（含 thinking-translator.json、三个 light 源资产、已安装入口、PATH shadowing，以及跑 `plugin-audit.sh` 展示插件对比），不复制、不装卸、不写本机。
- `init`：在常规更新基础上，额外迁移 `config.yml` / `settings.json` 等初始项，逐项先确认。
