---
description: 用本仓库快照更新本机 OMP 配置（repo → 本机）
---

把仓库 `agent/` 单向写入本机 `~/.omp/agent`（先展开为绝对路径），与 `/sync-omp-config` 方向相反。不使用 subagent，直接执行。

`$ARGUMENTS`：
- 为空：常规更新。
- `check`：只读，逐项比对并报告差异，包括 light 已安装入口、PATH shadowing 和 `./plugin-audit.sh` 的结论；不 mkdir、复制、chmod、rename、装卸插件，不改 PATH 或 shell 配置。
- `init`：常规更新之外，再覆盖 `config.yml` 和 `settings.json`。会盖掉本机特有值，逐项先向用户确认。

## 常规更新项

| 仓库 | 本机 | 规则 |
| --- | --- | --- |
| `agent/APPEND_SYSTEM.md` | 同名 | 直接覆盖 |
| `agent/thinking-translator.json` | 同名 | 有差异才覆盖 |
| `agent/agents/` | `agents/` | `diff -rq` 确认范围后覆盖 |
| `agent/extensions/*.ts` | `extensions/` | 同名覆盖、缺的补齐，见「扩展」 |
| `agent/config-light.yml`、`agent/APPEND_SYSTEM_LIGHT.md`、`agent/omp-light.ts` | 同名 | 三件整体更新并安装入口，见「Light 启动器」 |
| `install-plugins.sh` 的插件列表 | 已装插件 | 见「插件」 |

数据库、WAL、会话、缓存、日志、`models.yml`、`commandcode-models.json`、`last-changelog-version` 在任何模式下都不迁。

## 扩展

- 不删除本机多出来的扩展；仓库删掉的扩展也不在本机卸载。
- 应用托管的文件跳过、不覆盖：首行为 `// @orca-managed-pi-extension`，或任意行含 `marker: _otty`。以标记为准，不凭文件名判断。
- 本机相关的初始化项（`doc-polish.json`、`unified-exec-bun-pty.ts` 需要的 PTY 原生包缓存、`commandcode-model-spec.ts` 依赖的 `commandcode-models.json`）已存在就不动；缺失时问用户是否创建、内容填什么，未确认就跳过并在报告里说明。

## Light 启动器

1. 预检：三件源文件齐全，且 `Bun.which("omp")` 能得到绝对路径。任一不满足就报告原因并停止，不写任何 light 文件。
2. 三件复制到 `~/.omp/agent`，并在 `dirname(omp)` 安装入口：
   - POSIX：`omp-light`，内容就是 `agent/omp-light.ts` 原文（带 shebang，不套 wrapper），权限 `0755`。
   - Windows：`omp-light.ts` 加一个只转发参数的 `omp-light.cmd`：
     ```
     @echo off
     bun "%~dp0omp-light.ts" %*
     ```
   每个目标都先写同目录临时文件，再原子 rename 替换。
3. 不改 PATH 和 shell rc/profile，不替换 `omp`。目录不可写时报告绝对路径和错误，不换目录。
4. 安装后重新解析 `omp-light`；解析到的不是刚装的入口时，报告 PATH shadowing 及实际和期望路径，不修复。

## 插件

跑 `./plugin-audit.sh`，按它的分类行动，不自行重新扫描：
- `[安装]`：跑 `./install-plugins.sh` 补齐。
- `[卸载候选]`：问用户是否 `omp plugin uninstall <name>`，并告知作者从脚本移除通常已经验证过，可以直接删。
- `[保留]`：用户自装的，不动。

## 校验与报告

- 复制的文件与仓库 `cmp` 一致；安装入口检查内容、权限和解析路径。
- 动过的 YAML/JSON 两端都要能解析：`config-light.yml`、`init` 时的 `config.yml` 用 `Bun.YAML.parse`；`thinking-translator.json`、`init` 时的 `settings.json` 用 `JSON.parse`。
- 不打印凭据，不把明文凭据写进本机。
- 报告改了哪些文件、装卸了哪些插件、哪些项因等待确认被跳过，并提醒重启 OMP：APPEND_SYSTEM、扩展、插件在下次启动时加载。
