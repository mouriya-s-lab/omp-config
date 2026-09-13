# omp-config

这不是完整的 `~/.omp` 备份。仓库只保存可审查的配置和安装入口。

## 从本机同步

更新快照时在仓库根目录启动 OMP，执行项目级命令：

```
/sync-omp-config
```

方向严格单向（`~/.omp/agent` → 仓库 `agent/`），只读本机文件。加 `check` 参数只报告差异、不写入也不提交：

```
/sync-omp-config check
```

命令定义在 `.omp/commands/sync-omp-config.md`，包含同步范围、排除项和校验步骤。

## 同步两台不同机器上的omp供应商密钥，避免换一台机器就要登录

在仓库根目录启动 OMP，执行仓库级命令（定义见 `.omp/commands/migrate-omp-keys.md`），把本机 active 数据库（`PI_CODING_AGENT_DIR` 非空时取其下 `agent.db`，否则为 `~/.omp/agent/agent.db`）里的 `auth_credentials` 记录经 SSH 传到指定远端 OMP 主机：

```
/migrate-omp-keys <target>
```

`target` 为单个 SSH 地址（`user@host` 或 SSH alias）；为空时先询问目标，拿不到有效目标就停止。覆盖式替换远端凭据，远端原有记录会被改写/删除，写前先说明并确认；只迁 `auth_credentials`，不迁会话、历史、缓存、模型等运行时状态。远端 OMP 需先关闭，迁完由操作者手动重启；写前先用 SQLite `.backup` 做远端备份。不轮换、不刷新密钥，不打印凭据原文，不运行 `omp -p`，不做测试。

这与仓库快照是两条路径：仓库快照仍不收录数据库，此处是主机间直传。

## Subagent 配置设计

OMP 把 subagent 分成三类：`task:*` 负责执行，`discuss:*` 只读讨论，`mentor:default` 只读指导。`agent/APPEND_SYSTEM.md` 定义全局编排流程和能力边界，`agent/agents/` 的定义文件补充每个 agent 的职责；模型与推理强度由 `agent/config.yml` 单独绑定。职责与模型分离，换模型不会改变 agent 的能力边界。

当前定义的职责分层：

| 类型 | 名称 | 设计职责 |
| --- | --- | --- |
| 执行 | `task:high` | 处理开放式、歧义、跨模块或需要裁决的任务，负责定方案并可拆分任务。 |
| 执行 | `task:mid` | 默认处理有界工程切片，负责调查、实现、调试和端到端验证。 |
| 执行 | `task:low` | 执行输入、规则和验收明确的任务，不自行扩展设计，发现矛盾就上报。 |
| 讨论 | `discuss:divergent` | 只读发散视角，寻找问题边界外的替代方案及其代价。 |
| 讨论 | `discuss:steady` | 只读保守视角，检查风险、隐藏假设、遗漏状态和简单方案。 |
| 指导 | `mentor:default` | 无工具的持续导师，负责调查前审计划、调查后核对证据和遗漏。 |

`task` 和 `sonic` 不属于常规 tier，也不是 `agent/agents/` 中的定义；OMP 的 Vibe 模式把第一层 subagent 派发写死为这两个固定内置 subagent。因此它们只作为 Vibe 首层的特殊模型覆盖保留，常规任务不按它们选模型。

实际模型绑定、运行开关和禁用入口只保留在 `agent/config.yml`，不在 README 重复维护。调整职责边界时改 `APPEND_SYSTEM.md` 或对应定义；调整模型时改配置中的模型绑定。

## 直接迁移

以下内容直接复制到 `~/.omp/agent/`：

- `agent/config.yml`：OMP 配置和 UI 行为
- `agent/settings.json`：扩展加载路径
- `agent/APPEND_SYSTEM.md`：追加系统提示词
- `agent/agents/`：agent 定义
- `agent/extensions/`：本地扩展代码

不要复制整个 `agent/` 目录。数据库、WAL、日志、会话、缓存和锁文件是运行时状态，不属于迁移内容；`models.yml` 和 `commandcode-models.json` 含本机 API key 或本机生成的目录，同样不迁移。

Orca 与 Otty 在运行时生成并重写 `agent/extensions/` 下的 `orca-*.ts` 和 `otty-integration.ts`，它们由各自应用的安装器维护，本仓库不收录。

迁移前先备份并检查差异；迁移后重启 OMP：

```bash
mkdir -p "$HOME/.omp/agent"
cp agent/config.yml "$HOME/.omp/agent/config.yml"
cp agent/settings.json "$HOME/.omp/agent/settings.json"
cp agent/APPEND_SYSTEM.md "$HOME/.omp/agent/APPEND_SYSTEM.md"
cp -a agent/agents agent/extensions "$HOME/.omp/agent/"
```

## 执行安装

插件不随仓库复制。执行根目录脚本：

```bash
./install-plugins.sh
```

脚本对每个插件执行不带版本号的 `omp install`。OMP 会自行解析当前版本，并把安装结果写入用户运行目录：

- `~/.omp/plugins/package.json`
- `~/.omp/plugins/bun.lock`
- `~/.omp/plugins/node_modules/`
- `~/.omp/plugins/omp-plugins.lock.json`

这一步需要网络，并会安装、加载和校验第三方扩展代码。重复执行可能更新插件。

## 检查副作用

迁移或安装后检查：

```bash
omp config list --json
omp plugin list --json
git status --short
```

确认：

- 配置值符合预期
- 插件名称、版本、路径和 `enabled` 状态符合预期
- 第三方插件没有引入不需要的扩展
- 仓库没有出现数据库、WAL、日志、会话、缓存或插件运行时文件
