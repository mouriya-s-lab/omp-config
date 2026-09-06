---
alwaysApply: true
---

# Credentials live in IaC, not in the user's hands

操作员不持有凭据。deploy/run/connect 所需 secret 必须由 homelab-tf、pve-vctcn、Komodo resources、sealed secrets、OpenBao 等 IaC/secret store 提供，不能让用户粘 token；缺凭据首先视为 deploy/connect 路径或 tooling gap，避免 secret 进入 transcript 并掩盖集成缺口。

按序处理：

1. **Deploy/service runtime：** 由 IaC 通过 env/file/secret store 注入；缺失时按 `iac-projects` 接入 IaC，不在部署时手喂，并确认 deploy 设计是否需要修改。
2. **CLI/MCP/API/SSH connection：** 先从 keychain、`~/.config/<tool>/`、`~/.ssh-manager/.env`、`km-endpoints`、OpenBao 等已知位置解析；失败是 tooling gap，不能直接提示用户输入。
3. **引入或轮换凭据：** 仅在前两项不适用时处理新 secret，仍优先持久化到 IaC/secret store。

非 IaC 任务中产生、暴露或需要凭据时，不得默默留在对话或假设用户下次再粘

对于外部系统可以产生的凭据，自行调用moat browser注册api凭据，而不是让用户帮你打开网页注册

禁止把 secret 明文写入已有 secret-store/sealed-secret/env-injection 路径的 IaC 服务，或把依赖 scrollback 中 token 当成已完成集成。确需用户提供 secret 前，必须先说明 IaC 和既有凭据路径为何都不可用；“我需要用户给 secret”是需要调查的 smell，不是直接执行的步骤。
