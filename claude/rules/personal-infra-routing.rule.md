---
alwaysApply: true
---

# Personal infrastructure skill routing

任务触及 `homelab-tf`、`pve-vctcn`、`homelab-trading`、其 CT/VM、Komodo、vctcn edge services、netbird mesh 或本地 CI/CD 时，先调用下表 skill，再 grep；skill 是权威路由层，ad-hoc 搜索和 memory 只是 fallback。

| 主题 | 首先调用 |
|---|---|
| Repo owner、homelab-tf/pve-vctcn 边界、cross-repo invariant | `iac-projects` |
| 是否 IaC-adjacent、禁止外部 agent 修改主机、部署任务路由到 `iac:deploy` | `iac-issue-routing` |
| 把容器化 workload 一次性接入 Komodo 自动 CD、之后 tag 即自动 rollout | `iac-cicd-onboarding-issue` |
| VM 130 trading-agent compose/secrets/sync、opend/moomoo 及 `homelab-trading` repo | `homelab-trading` |
| 服务清单、数量、运行位置、missing-skill audit | `internal-services` |
| source→GARM VM 181→registry VM 182→Komodo 的本地 CI/CD | `local-cicd` |
| Docker-on-homelab 通用入口 | `container-management` |
| Komodo stack deploy/pull/restart/stop/destroy/list/batch | `km-stack` |
| 单容器 ps/inspect/restart、server list | `km-container` |
| prune/delete image/volume/network | `km-cleanup` |
| procedure/action/resource sync | `km-gitops` |
| build/repo clone/pull/build | `km-build-pipeline` |
| Komodo metadata DB backup/restore/migrate/prune | `km-database` |
| CLI 不支持的 Komodo REST API 操作 | `km-api` |
| Komodo Core endpoint 与凭据 | `km-endpoints` |
| Keycloak realm/client/user/OIDC/SAML/protocol mapper | `keycloak` |
| 新 VM/CT DNS discoverability、LAN DNS 故障 | `dns-check` |
| 上传截图到 `img.237575.xyz` 供 PR/issue 使用 | `image-share` |
| Browser automation、moat-browser routing | `agent-browser` |
| IaC 变更后刷新服务清单 | `update-internal-services` |

无匹配项时按序调用：

1. `internal-services`，使用其 inventory 和 missing-skills 列表覆盖 Mattermost、Forgejo、OpenBao、step-ca、nanoclaw、fulcrum、homepage、agent-runtime 和完整 DNS ops。
2. `iac-projects` 确定 owner，再用 `iac-issue-routing` 确定边界；具体部署/修改优先 `iac-auto-deploy-issue` + `iac:deploy`，requirement-only handoff 只用于未决事实或决策。
3. 以上 signpost 都检查后才 grep repo 或使用 memory。

本表不替代 skill 说明；不确定时读取 `SKILL.md`。不得绕过目标 repo 的 `CLAUDE.md`/rules。本规则不适用于普通编程、第三方库或非个人基础设施任务。
