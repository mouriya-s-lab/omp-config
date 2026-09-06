---
alwaysApply: true
---

# GitHub 账号路由

操作员有两个个人账号、两个 org，共四个 owner：

| Owner | 类型 | 说明 |
|---|---|---|
| **RiriAgent** | 个人账号 | AI agent 专用，日常操作的默认账号 |
| **Mouriya-Emma** | 个人账号 | 操作员本人账号，非特殊情况不使用 |
| **moat-lab** | org | — |
| **mouriya-s-lab** | org | — |

## 默认账号

`gh auth` 活跃账号必须始终是 **RiriAgent**，所有日常 git/gh 操作（clone、push、issue、PR、review、comment）默认以其身份执行。未经用户确认禁止切到 Mouriya-Emma；若某操作需临时切（如该账号独有权限），切前在正文声明切到谁、为什么，切完立即 `gh auth status` 验证已切回 RiriAgent 并在正文告知；切回失败则停止所有 gh 操作并告知用户。

## 创建仓库 / fork 必须先问 owner

执行 `gh repo create` / `gh repo fork` 前，必须在正文用自然语言确认目标 owner，列出全部四个（RiriAgent / Mouriya-Emma / moat-lab / mouriya-s-lab），等用户明确指定再执行。不得预设默认值，**不得用 `AskUserQuestion` 工具**。若用户同轮已指定 owner（如"fork 到 moat-lab"），无需再问，直接执行。
