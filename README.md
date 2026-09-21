# omp-config

这不是完整的 `~/.omp` 备份。仓库只保存可审查的配置和安装入口。

## 从本机同步

更新快照时在仓库根目录启动 OMP，执行项目级命令：

```
/sync-omp-config
```

方向严格单向（本机 active agent 目录 → 仓库 `agent/`，将 `PI_CODING_AGENT_DIR` 去除首尾空白后非空则取其值，否则为 `~/.omp/agent`），只读本机文件。同步范围包含普通配置、扩展、`thinking-translator.json` 以及轻量模式的 `config-light.yml`、`APPEND_SYSTEM_LIGHT.md`、`omp-light.ts`；`thinking-translator.json` 按本机 agent 根目录 → 仓库对应文件比对后覆盖，写入前后用 `bun -e` 以 `JSON.parse` 确认可解析；已安装的 `omp-light` / `omp-light.cmd` 不属于同步内容。加 `check` 参数只报告差异、不写入也不提交：

```
/sync-omp-config check
```

命令定义在 `.omp/commands/sync-omp-config.md`，包含同步范围、排除项和校验步骤。

## 用仓库更新本机

反向操作：用本仓库快照更新本机 OMP 配置。在仓库根目录启动 OMP 执行项目级命令：

```
/update-omp
```

方向严格单向（仓库 `agent/` → 本机 active agent 目录，将 `PI_CODING_AGENT_DIR` 去除首尾空白后非空则取其值，否则为 `~/.omp/agent`，会写本机）。常规只更新 `agents/`、`extensions/*.ts`、`APPEND_SYSTEM.md`、`thinking-translator.json`、轻量模式三项资产（`config-light.yml`、`APPEND_SYSTEM_LIGHT.md`、`omp-light.ts`）和插件；`config.yml`、`settings.json` 等其余项默认不动，只有 `init` 参数才逐项确认后迁移。`thinking-translator.json` 是 agent 根目录的常规托管文件（供 `omp-thinking-translator` 读取），有差异直接覆盖，覆盖前后用 `bun -e` 以 `JSON.parse` 确认可解析；这与 `doc-polish.json`（本机相关、本机已存在就不动，否则询问用户）、`commandcode-models.json`（本机生成、不迁移）不同。更新同时把轻量入口安装到 PATH 上已解析的 `omp` 可执行文件同目录：POSIX/macOS/Linux 为 `omp-light`，Windows 为 `omp-light.ts` 加 `omp-light.cmd`。扩展需要初始化或写配置文件时（如 `doc-polish.json`）若本机已存在就不动，否则询问用户。`check` 参数只报告差异、不写本机：

```
/update-omp check
```

插件部分先跑根目录 `./plugin-audit.sh`：它以基准提交 `5974c4fa` 起扫 `install-plugins.sh` 的历史插件名，归一后直接与 `omp plugin list` 对比，给出待安装、卸载候选（历史存在过、现已从脚本移除、本机仍装）、保留和已同步四类结论。缺的插件跑 `./install-plugins.sh` 补齐；卸载候选先询问用户。命令定义在 `.omp/commands/update-omp.md`。

## 轻量模式

轻量入口由 `/update-omp` 从仓库安装，不是 checkout 内的脚本，也不需要创建 symlink。安装源是 `agent/omp-light.ts`；安装位置是 PATH 上已经解析的 `omp` 可执行文件所在目录，所以不需要把 checkout 或固定的 `~/.local/bin` 额外加入 PATH。安装后 `omp-light` 应解析到这个已安装入口；`check` 会比对三项轻量资产和安装入口，并报告 PATH 中的旧副本遮蔽（PATH shadowing）。

POSIX/macOS/Linux 原子安装为可执行的 `omp-light`，入口使用 `#!/usr/bin/env bun` shebang；bash、zsh、fish 和 Unix `pwsh` 使用同一个 shebang 入口，不依赖 Bash 专用脚本。Windows 原子安装为同目录的 `omp-light.ts` 与最小 `omp-light.cmd`；Windows PowerShell 使用生成的 `.cmd` shim。

入口从 active agent 目录读取 `config-light.yml` 和 `APPEND_SYSTEM_LIGHT.md`（非空 `PI_CODING_AGENT_DIR` 优先，否则 `~/.omp/agent`），并只为本次进程使用短提示替换完整提示，通过配置覆盖禁用本仓库 `agent/extensions/` 下恰好 10 个可选行为扩展：`bro.ts`、`commandcode-usage.ts`、`ctx-post-compact-hint.ts`、`ctx-tasklog.ts`、`ctx-tool.ts`、`doc-polish.ts`、`lang-nag.ts`、`repo-rules.ts`、`tool-policy-nag.ts`、`watchdog-agent.ts`。以下 4 个兼容性/运行时修复仍保持加载：`commandcode-model-spec.ts`、`unified-exec-bun-pty.ts`、`v2-compaction-timeout.ts`、`xai-oauth-cost-ticks.ts`。这些是本次进程的覆盖，不会修改扩展文件。

其余能力和设置保持不变：OMP 默认配置、已安装插件、tools、`AGENTS/context`、`rules`、`skills`，以及 `model`/`thinking`/`profile`/`auth`/`session` 设置均保留。`omp-light` 后面的 CLI 参数会原样转发给 `omp`，后置参数可以覆盖 launcher 先设置的同名参数。

普通 `omp` 始终是完整模式；轻量入口不持久化开关，也不改写完整模式配置。要恢复完整模式，直接执行 PATH 上的 `omp`，不要再调用 `omp-light`。安装输出由 `/update-omp` 管理；轻量部分由 `/sync-omp-config` 只同步三项 agent 轻量资产，不同步 PATH 中的入口或 shim。

## 同步两台不同机器上的omp供应商密钥，避免换一台机器就要登录

在仓库根目录启动 OMP，执行仓库级命令（定义见 `.omp/commands/migrate-omp-keys.md`），把本机 active 数据库（`PI_CODING_AGENT_DIR` 非空时取其下 `agent.db`，否则为 `~/.omp/agent/agent.db`）里的 `auth_credentials` 记录经 SSH 传到指定远端 OMP 主机：

```
/migrate-omp-keys <target>
```

`target` 为单个 SSH 地址（`user@host` 或 SSH alias）；为空时先询问目标，拿不到有效目标就停止。覆盖式替换远端凭据，远端原有记录会被改写/删除，写前先说明并确认；只迁 `auth_credentials`，不迁会话、历史、缓存、模型等运行时状态。远端 OMP 需先关闭，迁完由操作者手动重启；写前先用 SQLite `.backup` 做远端备份。不轮换、不刷新密钥，不打印凭据原文，不运行 `omp -p`，不做测试。

这与仓库快照是两条路径：仓库快照仍不收录数据库，此处是主机间直传。

## Subagent 配置设计

OMP 把 subagent 分成三类：`task:*` 负责执行，`discuss:*` 只读讨论，`mentor:default` 只读指导。`agent/APPEND_SYSTEM.md` 定义全局编排流程和能力边界，`agent/agents/` 的定义文件补充每个 agent 的职责；模型与推理强度由 `agent/config.yml` 单独绑定。职责与模型分离，换模型不会改变 agent 的能力边界。

当前定义的职责分层与共同拆分规则如下。所有 `task:*` 都是通用执行 agent，能处理相同范围的调查、设计、实现、调试、拆分和验证；tier 只表示模型成本与单次结果的预期可信度，不表示任务难度、歧义程度、设计权限或适用场景。

所有 `task:*` 都由当前切片 owner 在实现前作本地 keep-or-split 决定。三项独立性检验是：每个单元有独立验收标准、可不依赖其他单元输出启动、文件/状态所有权不重叠；至少两个有界单元同时满足时，必须一次并行派发，否则把耦合或依赖工作留在本地。递归上限的子代理只能接收可直接执行的叶子。

| 类型 | 名称 | 设计职责 |
| --- | --- | --- |
| 执行 | `task:high` | 通用最高成本 tier；任务范围与 mid/low 相同，用于错误代价高、证据难以取得或便宜模型相互冲突，购买更强的预期判断力与可信度。 |
| 执行 | `task:mid` | 通用中等成本 tier，也是 low 结果的必需验证层；任务范围与 high/low 相同，独立复现关键检查、用实际产物和 runtime 证据核验 low 的结论并裁决冲突。 |
| 执行 | `task:low` | 通用零成本 tier，几乎可无限并发；任务范围与 mid/high 相同，但单个结果低可信，只负责产出候选工作和证据，不能相互验证，关键结果必须由 `task:mid` 独立验证。 |
| 讨论 | `discuss:divergent` | 只读发散视角，寻找问题边界外的替代方案及其代价。 |
| 讨论 | `discuss:steady` | 只读保守视角，检查风险、隐藏假设、遗漏状态和简单方案。 |
| 指导 | `mentor:default` | 无工具的持续导师，负责调查前审计划、调查后核对证据和遗漏。 |

`task` 和 `sonic` 不属于常规 tier，也不是 `agent/agents/` 中的定义；OMP 的 Vibe 模式把第一层 subagent 派发写死为这两个固定内置 subagent。因此它们只作为 Vibe 首层的特殊模型覆盖保留，常规任务不按它们选模型。

实际模型绑定、运行开关和禁用入口只保留在 `agent/config.yml`，不在 README 重复维护。调整职责边界时改 `APPEND_SYSTEM.md` 或对应定义；调整模型时改配置中的模型绑定。

## 直接迁移

以下内容直接复制到本机 active agent 目录（非空 `PI_CODING_AGENT_DIR` 优先，否则为 `~/.omp/agent`）：

- `agent/config.yml`：OMP 配置和 UI 行为
- `agent/settings.json`：扩展加载路径
- `agent/APPEND_SYSTEM.md`：追加系统提示词
- `agent/config-light.yml`：轻量模式配置覆盖
- `agent/APPEND_SYSTEM_LIGHT.md`：轻量模式短追加提示词
- `agent/omp-light.ts`：轻量入口的可移植 Bun shebang 源
- `agent/thinking-translator.json`：思考过程翻译配置（`omp-thinking-translator` 读 agent 根目录）
- `agent/agents/`：agent 定义
- `agent/extensions/`：本地扩展代码

安装目录中的 `omp-light`（POSIX）以及 Windows 的 `omp-light.ts` / `omp-light.cmd` 是安装输出，不属于仓库复制集。直接迁移除复制上述三项轻量资产外，还必须在目标机运行 `/update-omp`，或按同一安装契约把入口安装到 PATH 上已解析的 `omp` 同目录；只复制 `agent/` 文件不会让 `omp-light` 出现在 PATH。

不要复制整个 `agent/` 目录。数据库、WAL、日志、会话、缓存和锁文件是运行时状态，不属于迁移内容；`models.yml` 和 `commandcode-models.json` 含本机 API key 或本机生成的目录，同样不迁移。

Orca 与 Otty 在运行时生成并重写 `agent/extensions/` 下的 `orca-*.ts` 和 `otty-integration.ts`，它们由各自应用的安装器维护，本仓库不收录。

迁移前先备份并检查差异；迁移后重启 OMP：

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
mkdir -p "$agent_dir"
cp agent/config.yml agent/settings.json agent/APPEND_SYSTEM.md \
  agent/thinking-translator.json \
  agent/config-light.yml agent/APPEND_SYSTEM_LIGHT.md agent/omp-light.ts \
  "$agent_dir/"
cp -a agent/agents agent/extensions "$agent_dir/"
```

复制后按上面的安装契约安装 `omp-light`；其中 PATH 上的 `omp` 必须先存在。Windows PowerShell 需要生成的 `omp-light.cmd` shim，不能把 POSIX 可执行文件当作 Windows 入口。

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

### `watchdog-agent.ts`

由 `WATCHDOG-*.md` 文件驱动的「按目标」reviewer（watchdog），补足原生 advisor 的一个空档：原生 advisor 能按 agent 开关（`task.agentAdvisor` / agent frontmatter `advisor:`），但它发现到的 `WATCHDOG.md`/`WATCHDOG.yml` 会推给所有被顾问的会话，无法把审阅内容只投给某个目标。ExtensionAPI 没有介入原生 advisor 的钩子，所以本扩展是自带的独立 reviewer（用 `createAgentSession`，与 `lang-nag`/`doc-polish` 同型），不是对原生子系统的扩展。

文件名为 `WATCHDOG-<标签>.md`，头部用 Claude `rule.md` 式 frontmatter：

- `target`（必填）：`main` | 子 agent 名（如 `task:mid`、`discuss:divergent`） | `*` | `subagents` | 逗号分隔列表。决定这份 watchdog 监视谁，正文只投给匹配的目标。
- `model`（可选）：reviewer 模型，支持 `:effort` 后缀；缺省用 `advisor` 角色（`@advisor`），再退到当前会话模型。
- `tools`（可选）：reviewer 可用的内置工具，默认只读 `read`/`grep`/`glob`；非白名单名（read/grep/glob/ast_grep/web_search/edit/write/bash/eval）被丢弃。
- `name` / `enabled`（默认 `true`） / `delivery`（`aside`|`steer`|`nextTurn`|`followUp`，默认 `aside`） / `maxPerContext`（默认 `6`）。

frontmatter 之后的正文是交给 reviewer 的审阅重点。发现路径：用户级 `<agent dir>/WATCHDOG-*.md`（默认 `~/.omp/agent`，受 `PI_CODING_AGENT_DIR` 影响），仓库级从 cwd 向 git root 逐层取 `<dir>/WATCHDOG-*.md` 与 `<dir>/.omp/WATCHDOG-*.md`。会话身份：主会话文件名匹配 `<时间戳>_<uuid>.jsonl`，子 agent 从会话文件的 `session_init.agent` 读出 agent 名。

运行：在每个结算轮次（`agent_end` 且非 `willContinue`）、且会话身份匹配某个 watchdog 时，渲染有界的最近 transcript（排除自身注入的 `<watchdog>` 消息），对每个匹配的 watchdog 用其模型+工具各跑一遍 reviewer；判定不通过时以 `<watchdog name=… severity=…>` 通过 `sendUserMessage` 注入回该会话。按归一化文本去重，并按 context 上限封顶以防循环。任何失败路径（无匹配、模型解析失败、reviewer 出错或超时、文件损坏）都降级为不提示，绝不阻塞或破坏主轮次。

隔离与无递归：扩展会随 restricted children 被 rebind 进 subagent 会话，因此能作用于子 agent；reviewer 自身的 `createAgentSession` 用 `disableExtensionDiscovery: true` + 内存态 `SessionManager`，不会递归加载本扩展。

仓库之外的运行时行为：需在 `~/.omp/agent/` 或仓库 `.omp/` 放置 `WATCHDOG-*.md` 才生效，无匹配文件时完全静默；reviewer 按其模型独立消耗额度。子 agent 上的注入是尽力而为——只有在该轮于执行器收走切片结果前重新打开时才落地；主会话上，空闲时注入会开启新一轮（标准 advisor 行为）。

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
