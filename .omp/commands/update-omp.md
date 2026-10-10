---
description: 用本仓库工作区更新本机 OMP 配置和 pi-bansos 状态（repo → 本机）
---

用当前仓库工作区（含未推送的改动）手动执行一次 repo → 本机更新，与 `/sync-omp-config` 方向相反。实际写入全部由 `agent/omp-config-update.ts` 完成，规则以它文件头的说明和代码为准；本命令只负责运行、补上脚本不做的插件卸载判断、报告结果。不使用 subagent，直接执行。

平时不需要这个命令：装好之后，`omp-config-autoupdate` 扩展在每次 OMP 启动时从 GitHub 默认分支自动更新。它用于新机器首次安装更新器，以及把未推送的本地改动先应用到本机。

`$ARGUMENTS`：
- 为空：执行更新。
- `check`：只读，报告会写入、删除的文件和缺失的插件，并跑 `./plugin-audit.sh` 报告卸载候选；不写任何文件，不装卸插件。

## 步骤

1. 在仓库根目录运行：
   - 更新：`bun agent/omp-config-update.ts apply --source .`
   - `check`：`bun agent/omp-config-update.ts apply --source . --check`

   agent 目录默认取 `PI_CODING_AGENT_DIR`，否则 `~/.omp/agent`；使用 named profile 时加 `--agent-dir <omp config path 的输出>`。脚本报告 `another update holds …` 时，说明有一次自动更新正在进行，稍后重跑。
2. 跑 `./plugin-audit.sh`，只处理 `[卸载候选]`：问用户是否 `omp plugin uninstall <name>`，并告知作者从脚本移除通常已经验证过，可以直接删。`[安装]` 已由脚本补装，`[保留]` 不动。
3. 本机初始化项（`extensions/doc-polish.json`、`unified-exec-bun-pty` 的 PTY 原生包缓存、`commandcode-model-spec` 依赖的 `commandcode-models.json`）脚本不碰。已存在就不动；缺失时问用户是否创建、内容填什么，未确认就跳过并在报告里说明。
4. 报告脚本输出的写入、删除、跳过（应用托管文件）、补装的插件、note 和 error，以及卸载结果和初始化项的处理。

## 手动更新与自动更新的差别

- 手动更新不删除文件、不删除结构化配置里的键：删除只按 git 记录的“上次自动应用的提交 → 新提交”之间仓库删掉的内容计算，工作区没有这个基准。
- 手动更新不改写 `<agent 目录>/.omp-config-applied`。下次启动时，只要 GitHub 默认分支的提交与这个记录不同，自动更新就会用它覆盖本机，包括手动应用的、尚未推送的改动；推送并合并后再启动即可保持一致。
- 本机初始化项只有手动更新会问；自动更新从不创建它们。

## 生效时机

报告结束时提醒：`APPEND_SYSTEM.md`、扩展、插件在下次启动时加载；`config.yml` 由 OMP 实时重载；`APPEND_SYSTEM_MODEL.md`、`system-prompt-replace.json` 从下一条 prompt 开始生效；`PROMPT-INJECT-*.md` 和 `agents/` 从下一个派出的 subagent 开始生效；`pi-bansos-relay-state.json` 在已运行的会话里要到下次会话启动或下一次 `/bansos` 改动时才生效。
