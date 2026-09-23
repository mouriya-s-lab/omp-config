---
description: 把本机 OMP provider 凭据经 SSH 迁到远端 OMP 主机
---

把本机 `~/.omp/agent/agent.db` 里的 `auth_credentials` 经 SSH 覆盖到远端同路径的 `agent.db`。只直传，不轮换、不刷新。不使用 subagent，直接执行。

目标取 `$ARGUMENTS`，为单个 SSH 地址（`user@host` 或 SSH alias）。为空时用 ask 工具询问；拿不到有效目标就停止，不碰数据库。

1. 确认远端装了 OMP，不检查它是否在运行。任一端缺 `agent.db`、`ssh` 或 `sqlite3`，或传输失败，就中止。
2. 写之前向操作者说明：这是覆盖式替换，远端原有凭据行会被改写或删除。确认后再继续。
3. 远端用 `sqlite3` 的 `.backup` 给 `agent.db` 做带时间戳的备份，不直接复制主库文件。
4. 本地把 `auth_credentials` 全列（`id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at`）导出为逐行 `INSERT`、值用 `quote()` 包裹的临时 SQL，经 SSH 传到远端。远端先清空 `auth_credential_blocks` 和 `auth_credential_refresh_leases`，再在单个事务里整表替换 `auth_credentials`。
5. 只迁这张表，不迁 sessions、history、cache、models 等运行时状态。
6. 全程不打印 `data` 列或任何凭据原文；失败只报通用错误和备份路径。
7. 迁完由操作者手动重启远端 OMP。本命令不启停 OMP，不运行 `omp -p`，不做测试。
