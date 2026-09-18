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

## 用仓库更新本机

反向操作：用本仓库快照更新本机 OMP 配置。在仓库根目录启动 OMP 执行项目级命令：

```
/update-omp
```

方向严格单向（仓库 `agent/` → 本机 `~/.omp/agent`，会写本机）。常规只更新 `agents/`、`extensions/*.ts`、`APPEND_SYSTEM.md` 和插件；`config.yml`、`settings.json` 等其余项默认不动，只有 `init` 参数才逐项确认后迁移。扩展需要初始化或写配置文件时（如 `doc-polish.json`）若本机已存在就不动，否则询问用户。`check` 参数只报告差异、不写本机：

```
/update-omp check
```

插件部分先跑根目录 `./plugin-audit.sh`：它以基准提交 `5974c4fa` 起扫 `install-plugins.sh` 的历史插件名，归一后直接与 `omp plugin list` 对比，给出待安装、卸载候选（历史存在过、现已从脚本移除、本机仍装）、保留和已同步四类结论。缺的插件跑 `./install-plugins.sh` 补齐；卸载候选先询问用户。命令定义在 `.omp/commands/update-omp.md`。

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

## 本地扩展的运行时行为

`agent/extensions/` 下的扩展修正 OMP 与已安装插件的缺陷，或补充上下文、计费、主题和压缩等运行时能力。它们随 `agent/extensions/` 一起迁移，但在本机还有仓库之外的行为，迁移后需要知道。

### `commandcode-model-spec.ts`

修 `--model` 指定 commandcode 模型时的失败。`models.db` 的 `model_cache` 把 commandcode 模型持久化成 `openai-completions`/`anthropic-messages`，启动期 `--model` 解析信任这些缓存行，于是走宿主 transport 并把字面量 `$COMMANDCODE_API_KEY` 当凭据发出，认证失败；不填 `--model` 时持久化模型走 live registration，所以一直正常。扩展在会话内把这类模型重选回插件的 `commandcode-custom`，不注册 provider、不写默认模型、不改缓存，每次重定向打印一行提示。

成员判定读 `agent/commandcode-models.json`。该文件不迁移，换机器后在插件首次写出它之前扩展静默不生效。这是绕过而非根因修复：根因在宿主把自定义 `api` 的扩展 provider 降级持久化，`omp models commandcode refresh` 不会改写那些行。

### `unified-exec-bun-pty.ts`

这个扩展只解决一个平台兼容问题：在 macOS Apple Silicon（`darwin-arm64`）上，让 `pi-unified-exec` 的 `exec_command` 支持 `tty: true`。`tty: false` 不经过这条兼容路径；其他平台也不会介入。

**PTY 原生包的下载和放置**

这里要下载的不是 `pi-unified-exec` 插件，而是它的可选依赖 `@homebridge/node-pty-prebuilt-multiarch` 的 macOS Apple Silicon 原生预编译包。插件本身必须已经安装，扩展才能找到这个包及其构建文件。

从 [Homebridge `node-pty-prebuilt-multiarch` releases](https://github.com/homebridge/node-pty-prebuilt-multiarch/releases) 下载与已安装 PTY 包版本匹配的 `darwin-arm64` 归档。归档文件名格式为：

```text
node-pty-prebuilt-multiarch-v<包版本>-node-v<Node ABI>-darwin-arm64.tar.gz
```

`<包版本>` 从已安装包的 `package.json` 读取；`<Node ABI>` 从 release 中选择实际存在且能被当前 Bun 加载的资源，不要直接把 Bun 的 ABI 当成 Node ABI。下面的 `node_abi=137` 只是当前 release 的示例值：

```bash
pty_package_dir="$HOME/.omp/plugins/node_modules/@homebridge/node-pty-prebuilt-multiarch"
pty_version="$(node -p "require(process.argv[1]).version" "$pty_package_dir/package.json")"
node_abi=137  # 示例值；按 release 中可用的 darwin-arm64 资源调整
pty_archive="$HOME/Downloads/node-pty-prebuilt-multiarch-v${pty_version}-node-v${node_abi}-darwin-arm64.tar.gz"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
pty_root="$(dirname "$agent_dir")/unified-exec-bun-pty-binding/${pty_version}-darwin-arm64"

mkdir -p "$HOME/Downloads" "$pty_root"
curl -fL \
  "https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${pty_version}/node-pty-prebuilt-multiarch-v${pty_version}-node-v${node_abi}-darwin-arm64.tar.gz" \
  -o "$pty_archive"
tar -xzf "$pty_archive" -C "$pty_root"
```

解压后必须存在 `${pty_root}/build/Release/pty.node` 和 `${pty_root}/build/Release/spawn-helper`。默认缓存位置是 `~/.omp/unified-exec-bun-pty-binding/<包版本>-darwin-arm64/`；设置 `PI_CODING_AGENT_DIR` 时，缓存位于该 agent 目录的上一级。`.ts` 扩展文件仍按上面的本地扩展迁移规则放在 `~/.omp/agent/extensions/`（或自定义 agent 目录的 `extensions/`），不要把 PTY 归档解到那里。

如果不手动预置缓存，扩展首次启动也会从对应 release 自动下载；下载失败才回退到 `node-gyp` 源码构建。

### `ctx-tool.ts`

注册只读 `ctx` 工具，支持 `ctx list [page=N]` 与 `ctx show <id>`。它从当前会话、subagent registry、transcript、compaction、sidecar summary 和 task log 组合上下文树。`list` 每行给出状态、summary 和任务计数（`done/total`），每页固定 20 条 DFS 前序结果，未指定或越界的 `page` 会被夹到有效区间，末行给出 `Page N/M — contexts a–b of N` 和下一页提示。`show` 输出 handoff 与 `## Tasks` 时间线：从 task-log 事件重放出每个任务的最新状态，`Completed` 与 `Open` 两段按本地时间升序展开，同一任务只保留最终状态（`start`/`block`/`unblock` 折叠为 open；`done` 覆盖为 completed；`drop`/`rm` 从时间线剔除），`block` 的原因作为 open 项后缀展示。不修改会话或文件。

### `ctx-tasklog.ts`

监听成功的 `todo`/`goal` 工具结果，把操作、目标、计数和本地时间串行追加到 local root 下的 `task-log/<agent-id>.md`，供 `ctx` 汇总和恢复使用。写入失败只记录 warning，不让工具结果失败。

### `ctx-post-compact-hint.ts`

compact 完成后调用 `ctx-tool.ts` 导出的 `renderCtxListText` 与 `renderCtxShowText`，在 `<post-compact-ctx>` 块里同时注入 `## List`（默认 page 1，与 `ctx list` 逐字一致）和 `## Current session`（主会话的 handoff + Tasks 时间线，与 `ctx show <main-id>` 逐字一致）；`list` 总页数 > 1 时在头部注明当前页和下一页命令，subagent 详情仍需模型自己 `ctx show <id>` 拉取。同时监听 `session_compact` 与成功的 `auto_compaction_end`（跳过 aborted/skipped/无 result），用 5 秒窗口去重两个事件；只对主会话生效，subagent 不注入。渲染失败只记录 warning，不影响 session。

### `tool-policy-nag.ts`

监听 `bash`/`bash_bg` 中用 `cat`、`sed`、`head`、`tail` 等命令读取文件的行为。前三次只记录状态，超过阈值后发送一次 aside 提示并暂停检测，直到 compaction 或会话边界；状态写入 session custom entry，不拦截命令。

### `commandcode-usage.ts`

为已安装的 `pi-commandcode-provider` 注册运行时用量 provider，调用 Command Code billing endpoint 展示 5 小时与 7 天额度。它复用插件的凭据解析，只在会话启动时注册、关闭时移除，不重新注册模型 provider。

### `xai-oauth-cost-ticks.ts`

包装 `fetch`，从 `xai-oauth` 的 Responses SSE 中捕获 `usage.cost_in_usd_ticks`，并在 `message_end` 持久化前补回 `usage.cost.total`。只处理 `xai-oauth` assistant 消息，重复加载不会重复包装 `fetch`。

### `v2-compaction-timeout.ts`

只把 compaction 使用的 `AbortSignal.timeout(180000)` 延长到 `600000`，其他超时保持原值。安装具有进程级幂等保护，并记录扩展安装与延长事件。

### `repo-rules.ts`

补齐 OMP 原生 rule discovery 不读的 repo 级目录。原生 project rule 只来自 `.omp/rules`、`.agent(s)/rules`、`.cursor/rules`、`.windsurf/rules`、`.clinerules` 和 `.github/instructions`，且仅当 rule 有 `alwaysApply: true` 或 `description` 时才进 bucket；没有 frontmatter 的文件不进任何 bucket。扩展从 cwd 向 repo root 扫 `.claude/rules`、`.agents/rules`、`.pi/rules`，`alwaysApply`（含无 frontmatter）注入正文，只有 `description` 的列成目录项附文件路径供 `read`。同名文件就近者胜。

注入在 `before_agent_start` 追加一个 `<repo-level-rules>` prompt block，注入前把正文按空白归一后与现有 system prompt 比对，已经出现过的内容跳过，因此与原生 `<generic-rules>`、用户级 `~/.claude/rules`（由 `settings.json` 的 `extensions` 作为 plugin root 载入）不会重复。只处理 project 级目录，用户级 rule 一律交给宿主。

### `doc-polish.ts`

注册模型可调用的 `polish_doc` 工具与人可调用的 `/polish-doc <path…>` 命令。对 `.md`/`.txt` 文档在不改变原意的前提下，按工程师可读性重排、润色，产出 `改之前 / 改之后 / 点评` 三段式评审文件到 `/tmp/doc-polish/<时间戳>-<名>/`（原文先拷贝一份到同目录）。

三个子代理各自是一个受限的内存态 `createAgentSession`，复用宿主的 provider/模型（`ctx.modelRegistry`，不额外请求），模型以 `provider/model:effort` 全名指定，可给逗号分隔的回退链：

模型与并发可由与扩展同目录的 `doc-polish.json` 预定义（键 `splitModel`/`polishModel`/`checkModel`/`concurrency`；cwd 下同名文件优先）。优先级：显式参数 > `doc-polish.json` > 当前会话模型。加载时仅按模型列表核对 `doc-polish.json` 里的模型是否存在（不发测试请求）；若不存在则**直接中止本次调用、不润色**（无挂起状态，需修正后重新调用），并把一段说明返回给主 agent——请其向用户解释三个模型设置的作用、并把决定权交给用户。

模型存在于列表、但运行时请求失败（如 403 未在套餐内、限流、网络错误——子代理里这类失败不抛异常，而是以 stopReason 为 error 的助手轮次落地）是另一类情况：对该子代理重试至多 3 次，仍失败则报一段可读、自足、不误导的错误（含子代理角色、模型全名、连续失败次数与 provider 原始报错），无需额外排查。`polish_doc` 工具把它作为 `isError` 工具结果返回；`/polish-doc` 命令通过 `ctx.ui.notify` 直接告知用户。

- **拆分代理**：标准子代理，仅 `read`+`write`；prompt 不含原文，自己读文件并写出带原始行号（起止）的切分索引与完整关键词词表。
- **润色代理**：无工具；按 ≤5000 码点分批、不截断、超长段独立成批，每批只发送与该批相关的词表，返回润色文本与词表变更记录。
- **校验代理**：无工具；对合并后的编组判定语义是否保持、如何理解；未指定时缺省回退到拆分模型。

拆分之后全部为程序行为：把块按 ≤5000 码点打包后，**结构化并发**地并行分析——所有润色批次并发执行、汇齐后重编组，再对所有编组并发校验，全部完成后按原始索引依次写回（并发上限默认 6，可用 `concurrency` 调整）。按原始行号取权威原文、并查集依 `sourceIndices` 识别段落合并并重新编组、逐组语义校验、渲染评审。子代理均 `restrictToolNames` + `disableExtensionDiscovery`，不会递归加载本扩展。仓库之外的运行时副作用：向 `/tmp/doc-polish/` 写文件，并按批消耗所指定模型的额度。

返回语义：模型调用 `polish_doc` 时，评审文件路径与「参考方向、非权威结论」的使用说明作为工具结果返回，由调用模型自行判断如何采纳。人用 `/polish-doc` 调用时不直接展示给人，而是把同样的结果作为新输入交给当前会话的主 agent（`pi.sendUserMessage`），由主 agent 阅读评审并决定如何使用。

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
