---
description: 把本机 OMP provider 凭据经 SSH 迁到远端 OMP 主机
---

把本机当前 OMP 的 provider 凭据搬到一台远端 OMP 主机。只做直传，不轮换、不刷新。

不要使用 subagent，直接执行。

## 目标

`$ARGUMENTS` 为空时，用 OMP ask 工具向操作者要一个 SSH 目标（如 `user@host` 或 SSH alias），仍拿不到或目标无效时停止，不继续。

## 路径

本地用当前 active 库：`PI_CODING_AGENT_DIR` 非空时取其下 `agent.db`，否则 `~/.omp/agent/agent.db`。远端同样按此规则取 active/default 库。任一端缺 `agent.db`、缺 `ssh`/`sqlite3` 或传输失败都直接中止。

## 步骤

1. 确认远端已装 OMP，不需要检查远端有没有OMP在运行；迁完由操作者手动重启，本命令不自动启停。
2. 在远端先用 `sqlite3` 的 `.backup` 给 `agent.db` 做带时间戳的备份（不要直接复制主库文件），再覆盖凭据。
3. 只迁 `auth_credentials` 全列（`id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at`），不迁整个仓库，不迁 sessions/history/cache/models 等运行时状态。
4. 本地用 `sqlite3` 把 `auth_credentials` 导出为临时 SQL payload（逐行 `INSERT`，值用 `quote()` 包裹），经 SSH 传到远端；远端先清空 `auth_credential_blocks` 和 `auth_credential_refresh_leases`，再在单个 SQLite 事务里替换远端 `auth_credentials` 全表。
5. 警告：这是覆盖式替换，远端原有凭据行会被改写/删除，写前向操作者说明并确认后再写。
6. 全程绝不打印 `data` 列或任何凭据原文；失败只报通用错误和备份路径。
7. 不轮换、不刷新凭据；不运行 `omp -p`，不做任何测试。

## 参数

`$ARGUMENTS`

- 为空：先询问目标，拿不到有效目标就停止，不执行数据库步骤。
- 有目标：按上面步骤执行。
