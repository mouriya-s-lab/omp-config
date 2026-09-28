# omp-config

OMP 配置里可以审查、可以迁移的那部分。不是 `~/.omp` 的完整备份：数据库、会话、缓存、日志、锁文件和凭据都不在这里。

|路径|内容|本机位置|
|---|---|---|
|`agent/config.yml`|OMP 配置、UI 行为、subagent 模型绑定|`~/.omp/agent/`|
|`agent/settings.json`|扩展加载路径|`~/.omp/agent/`|
|`agent/APPEND_SYSTEM.md`|追加系统提示词|`~/.omp/agent/`|
|`agent/config-light.yml`、`agent/APPEND_SYSTEM_LIGHT.md`、`agent/omp-light.ts`|轻量模式的配置覆盖、短提示词、入口源码|`~/.omp/agent/`|
|`agent/thinking-translator.json`|`omp-thinking-translator` 插件配置|`~/.omp/agent/`|
|`agent/agents/`|subagent 定义|`~/.omp/agent/agents/`|
|`agent/extensions/`|本地扩展|`~/.omp/agent/extensions/`|
|`pi/agent/pi-bansos-relay-state.json`|`pi-bansos` 插件状态|`~/.pi/agent/`|
|`install-plugins.sh`、`plugin-audit.sh`|插件安装和漂移检查|—|

## 日常命令

在仓库根目录启动 OMP 后执行。三个命令的完整规则在 `.omp/commands/` 下同名文件里。

|命令|方向|写入|
|---|---|---|
|`/sync-omp-config`|本机 → 仓库|只写仓库，完整模式会提交并推送|
|`/update-omp`|仓库 → 本机|写本机，并安装 `omp-light`|
|`/migrate-omp-keys <target>`|本机 → 远端主机|覆盖远端凭据|

前两个命令加 `check` 参数时只报告差异，不写入。

### `/sync-omp-config`

把本机状态收回仓库，只读本机文件。范围是上表中的配置文件、agent 定义、扩展和轻量模式三项资产。已安装到 PATH 的 `omp-light` / `omp-light.cmd` 不收回。

### `/update-omp`

用仓库更新本机：

- `config.yml`、`settings.json` 和各 JSON 按字段比对，只改有差异的行，不整文件覆盖。改完用 `bun -e` 确认能解析。
- `config.yml` 中的本机字段（如 `modelRoles`、`theme`，完整列表见 `sync-omp-config.md`）两个方向都不动。
- agent 定义和 `config.yml` 里的模型绑定一起更新，避免 agent 名和模型对不上。
- `extensions/doc-polish.json` 是本机配置：本机已有就不动，没有时先询问。`commandcode-models.json` 由本机生成，不迁移。
- 安装 `omp-light`，见[轻量模式](#轻量模式)。
- 插件：先跑 `./plugin-audit.sh`，缺的用 `./install-plugins.sh` 补，卸载候选先询问。

`plugin-audit.sh` 从基准提交 `5974c4fa` 起收集 `install-plugins.sh` 出现过的插件名，和 `omp plugin list` 对比，分成四类：待安装、卸载候选（脚本里删掉了但本机还装着）、保留、已同步。

### `/migrate-omp-keys <target>`

换机器后不用重新登录各个供应商：把本机 `~/.omp/agent/agent.db` 的 `auth_credentials` 表经 SSH 复制到远端。

- `target` 是一个 SSH 地址（`user@host` 或 alias）。没给就先问，问不到就停止。
- 会覆盖远端已有凭据，写之前说明并确认，并用 SQLite `.backup` 备份远端库。
- 远端 OMP 要先关掉，迁完手动重启。
- 只迁凭据，不迁会话、历史、缓存或模型。不轮换密钥，不打印凭据。

这条路径与仓库快照无关，仓库仍然不收数据库。

## 轻量模式

`omp-light` 启动一个精简的 OMP 进程：

- 用 `APPEND_SYSTEM_LIGHT.md` 替换完整的追加提示词。
- 按 `config-light.yml` 禁用 10 个可选行为扩展：`ctx-post-compact-hint`、`ctx-tasklog`、`ctx-tool`、`doc-polish`、`fork-task`、`isolation-nudge`、`lang-nag`、`task-split-check`、`tool-policy-nag`、`watchdog-agent`。其余扩展照常加载。
- 插件、工具、rules、skills、上下文文件，以及 model、thinking、profile、auth、session 设置都不变。
- 后面的参数原样传给 `omp`，可以覆盖入口预设的同名参数。

这些覆盖只对这一个进程有效，不改任何文件。直接运行 `omp` 就是完整模式。

**安装。** `/update-omp` 把 `agent/omp-light.ts` 安装到 PATH 上 `omp` 所在的目录，所以不用改 PATH，也不用建 symlink：

- POSIX（macOS、Linux）：可执行文件 `omp-light`，靠 `#!/usr/bin/env bun` 运行，bash、zsh、fish、Unix `pwsh` 通用。
- Windows：`omp-light.ts` 加一个生成的 `omp-light.cmd`，PowerShell 通过 `.cmd` 启动。

安装出来的入口不属于仓库。`/update-omp check` 会比对三项资产和已安装入口，并报告 PATH 里遮住它的旧副本。

## 手动迁移

不走 `/update-omp` 时，按下面的复制集操作。不要复制整个 `agent/`：里面还有运行时状态、`models.yml`（含 API key）和 `commandcode-models.json`（本机生成）。`orca-*.ts` 和 `otty-integration.ts` 由 Orca、Otty 自己安装和改写，本仓库不收录。

先备份并检查差异，然后：

```bash
mkdir -p "$HOME/.omp/agent"
cp agent/config.yml agent/settings.json agent/APPEND_SYSTEM.md \
  agent/thinking-translator.json \
  agent/config-light.yml agent/APPEND_SYSTEM_LIGHT.md agent/omp-light.ts \
  "$HOME/.omp/agent/"
cp -a agent/agents agent/extensions "$HOME/.omp/agent/"
mkdir -p "$HOME/.pi/agent"
cp pi/agent/pi-bansos-relay-state.json "$HOME/.pi/agent/"
```

复制完还要做两件事：

1. 安装 `omp-light`：在目标机跑一次 `/update-omp`，或按上一节的方式手动放到 `omp` 旁边（`omp` 必须已在 PATH 上）。只复制文件不会让 `omp-light` 可用。
2. 重启 OMP。

`pi-bansos-relay-state.json` 放在 `~/.pi/agent/` 而不是 `~/.omp/agent/`，因为插件从那里读。它记录 relay 开关、当前 relay、已存 relay 列表和状态栏设置，由 `/bansos` 写入。状态栏默认显示 `relay: ON/OFF`，隐藏设置只存在这个文件里，缺了它新机器会重新显示。

## 插件

插件不在仓库里，用脚本安装：

```bash
./install-plugins.sh
```

脚本对每个插件执行不带版本号的 `omp install`，由 OMP 解析当前版本，结果写入 `~/.omp/plugins/`（`package.json`、`bun.lock`、`node_modules/`、`omp-plugins.lock.json`）。需要联网；会下载并加载第三方代码；重复执行可能升级插件。

## 迁移后检查

```bash
omp config list --json
omp plugin list --json
git status --short
```

确认配置值、插件名称、版本、路径和 `enabled` 状态符合预期，第三方插件没有带进不需要的扩展，仓库里没有出现数据库、WAL、日志、会话、缓存或插件运行时文件。

## Subagent 设计

分三类：`task:*` 执行，`discuss:*` 只读讨论，`mentor:default` 只读指导。

改哪里：

|要改的|位置|
|---|---|
|编排流程、各类 agent 如何配合|`agent/APPEND_SYSTEM.md`|
|某个 agent 的职责（`description`）和它自己的角色提示（正文）|`agent/agents/<name>.md`|
|模型、推理强度、运行开关、禁用入口|`agent/config.yml`|

harness 会把 `APPEND_SYSTEM.md` 和每个 agent 的 `description` 都注入主 agent，所以两处不写重复内容。换模型不改变 agent 的职责，但要同步它 `description` 里和下表中的模型档次与成本。

|名称|模型与成本（每 1M token，综合）|可派发|用途|
|---|---|---|---|
|`task:high`|Claude Opus 5.5，约 0.45 USD|全部 `task:*`、两个 discussant、mentor|必须一次做对，或更便宜的 tier 裁决不了的工作；负责所派子批次的契约、验收与集成|
|`task:mid`|Opus 级，约 0.3 USD|mentor|默认 tier：委派的实现、调查、调试和验证；也裁决便宜 tier 之间的冲突|
|`task:low`|Opus 级，约 0.01 USD|mentor|成本优先、结果可直接交付的工作：批量机械改动、查询、例行检查；也负责验证 `task:free` 的结果|
|`task:free`|Opus 级，免费，并发几乎不限|mentor|结果不需要独立验证的工作：找候选代码或文档、列方案、探索性试验|
|`discuss:divergent`|—|—|发散视角：找问题边界之外的替代方案及其代价|
|`discuss:steady`|—|—|保守视角：查风险、隐藏假设、遗漏状态和更简单的方案|
|`mentor:default`|—|—|无工具导师：调查前审计划，调查后核对证据和遗漏|

规则：

- **tier 按成本和所需可信度选，不按难度选。** 默认派 `task:mid`；成本比多出的判断力更重要时（批量机械改动、查询、验证 `task:free`）降到 `task:low`。验证也算成本：需要验证才能采信的结果，用 `task:free` 再加验证者比 `task:low` 做一次更贵。进仓库的改动、会被直接采信的结论和裁决都给 `task:low` 及以上。`task:free` 的结果不能互相验证。
- **`task:free`、`task:low`、`task:mid` 不接设计和核心工作**：架构、领域类型与状态模型、接口与跨切片契约、改动的核心逻辑，以及文档、prompt、skill、agent 定义的设计。`task:high` 没有这条限制。
- **核心代码、小改动和文档设计由当前负责人自己写**，不交给任何 `task:*`。小改动按整件工作判断：写派工单不比直接改省事，就自己改。
- **其余工作切到最小、各有验收标准的单元，一次并行派出。** 单元能并行的条件：各有验收标准、启动不依赖别的单元输出、文件和状态归属不重叠。只因接口或文件边界没定而不满足的，先定边界再并行。确实拆不开的，主 agent 交给一个 worker，worker 则自己做。
- **只有 `task:high` 能派 worker**，因为切单元、定验收、划文件归属本身就是契约设计。递归最多两层：`task:high` 派出的孙代只能接可直接执行的叶子任务。

**并行写入的隔离**由派发方每次决定，不写在 agent 定义里：

- 不带 `isolated: true` 的 `task:*` 在派发方目录里运行。同一仓库同时有两个以上写入者（同一批，或前一个还在跑）时，每个写入者都要 `isolated: true`。只调查的保持共享，结束后还能用 `write agent://<id>` 续聊。
- 给隔离 worker 的路径写成仓库相对路径。OMP 的隔离只靠提示约束，绝对路径会让 worker 的命令跑回派发方的目录。
- 隔离不能代替划分文件归属，改动重叠只会变成应用失败的 patch。
- 规则分布：派发方的写在 `APPEND_SYSTEM.md` 和 `task-high.md`；worker 在隔离工作树里的路径规则写在四个 `task-*.md` 里（subagent 收不到 `APPEND_SYSTEM.md`）。模型忘了隔离时，`isolation-nudge.ts` 拦一次作提醒。

`task` 和 `sonic` 是 OMP 内置 subagent，不在 `agent/agents/` 里。Vibe 模式的第一层派发固定用它们，所以 `config.yml` 只为这个场景保留它们的模型覆盖，常规任务不用。

## 本地扩展

`agent/extensions/` 里的扩展修补 OMP 和插件的缺陷，或补充上下文、计费、压缩等能力。每个扩展下面说明它做什么、在仓库之外有什么副作用。

所有扩展内部建的辅助会话（`bro`、`doc-polish`、`lang-nag`、`watchdog-agent` 的聊天 reviewer、`fork-task` 的 shake）都必须传 `taskDepth: 1`。不传的话 SDK 把它当主会话，`dispose()` 时会销毁全局 `AgentLifecycleManager`，所有空闲 subagent 变成 `Unknown agent`，无法再续聊。`lang-nag` 每次回复后都建辅助会话，漏传会让 subagent 在几秒内失联。

### 兼容性修复

**`commandcode-model-spec.ts`**：修复用 `--model` 指定 commandcode 模型时认证失败的问题。

- 原因：`models.db` 的 `model_cache` 把这类模型缓存成 `openai-completions` / `anthropic-messages`，`--model` 解析时信任缓存，走宿主 transport，把字面量 `$COMMANDCODE_API_KEY` 当凭据发出去。不带 `--model` 时走插件的实时注册，所以没问题。
- 做法：在会话内把这类模型重新选回插件的 `commandcode-custom`，每次打印一行提示。不注册 provider，不改默认模型和缓存。
- 限制：判断依据是 `agent/commandcode-models.json`，这个文件不迁移，新机器上插件第一次写出它之前扩展不起作用。这是绕过，不是根治；根因在宿主持久化扩展 provider 时丢了自定义 `api`，`omp models commandcode refresh` 也不会改这些行。

**`unified-exec-bun-pty.ts`**：让 `pi-unified-exec` 的 `exec_command` 在 macOS Apple Silicon（`darwin-arm64`）上支持 `tty: true`。其他平台和 `tty: false` 不受影响。

它需要 `pi-unified-exec` 的可选依赖 `@homebridge/node-pty-prebuilt-multiarch` 的 `darwin-arm64` 预编译包。扩展首次启动会自动从 release 下载，失败才退回 `node-gyp` 源码构建。要手动预置：

```bash
pty_package_dir="$HOME/.omp/plugins/node_modules/@homebridge/node-pty-prebuilt-multiarch"
pty_version="$(node -p "require(process.argv[1]).version" "$pty_package_dir/package.json")"
node_abi=137  # 示例值：从 release 里选实际存在、当前 Bun 能加载的 darwin-arm64 资源
pty_archive="$HOME/Downloads/node-pty-prebuilt-multiarch-v${pty_version}-node-v${node_abi}-darwin-arm64.tar.gz"
pty_root="$HOME/.omp/unified-exec-bun-pty-binding/${pty_version}-darwin-arm64"

mkdir -p "$HOME/Downloads" "$pty_root"
curl -fL \
  "https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${pty_version}/node-pty-prebuilt-multiarch-v${pty_version}-node-v${node_abi}-darwin-arm64.tar.gz" \
  -o "$pty_archive"
tar -xzf "$pty_archive" -C "$pty_root"
```

- 版本号取已安装包的 `package.json`；`node_abi` 不能直接用 Bun 的 ABI，要从 [release 页面](https://github.com/homebridge/node-pty-prebuilt-multiarch/releases)选。
- 解压后必须有 `build/Release/pty.node` 和 `build/Release/spawn-helper`。
- 归档解到 `~/.omp/unified-exec-bun-pty-binding/`，不要解到 `extensions/`。

**`v2-compaction-timeout.ts`**：只把 compaction 用的 `AbortSignal.timeout(180000)` 改成 `600000`，其他超时不动。进程级幂等，会记录安装和每次延长。

**`xai-oauth-cost-ticks.ts`**：包装 `fetch`，从 `xai-oauth` 的 Responses SSE 里取 `usage.cost_in_usd_ticks`，在 `message_end` 持久化前补上 `usage.cost.total`。只处理 `xai-oauth` 的 assistant 消息，重复加载不会重复包装。

**`commandcode-usage.ts`**：为 `pi-commandcode-provider` 注册用量 provider，调用 Command Code billing endpoint 显示 5 小时和 7 天额度。复用插件的凭据解析，会话开始时注册、结束时移除，不注册模型 provider。

### 上下文恢复

**`ctx-tool.ts`**：注册只读 `ctx` 工具，把当前会话、subagent registry、transcript、compaction 摘要、sidecar summary 和 task log 拼成一棵上下文树。不修改会话或文件。

- `ctx list [<id>] [all=true]`：深度优先，每行一个 context，含状态、摘要、任务计数（`done/total`，有阻塞时附 blocked）。默认隐藏 mentor、discuss、trace 这类内部 context，末行给出隐藏数量，`all=true` 全部列出。非根节点后代超过 8 个时折叠成一行，用 `ctx list <id>` 展开。
- `ctx show <id>`：handoff 加 `## Tasks` 时间线。时间线由 task log 重放而来，分 `Completed` 和 `Open` 两段，按本地时间排序，每个任务只保留最终状态：`start` / `block` / `unblock` 算 open，`done` 算 completed，`drop` / `rm` 移除；`block` 的原因附在 open 项后面。
- 性能：transcript 的修改时间和大小没变时复用缓存的会话头；新增或变化的 transcript 只读到 `session_init` 为止。

**`ctx-tasklog.ts`**：每次 `todo` / `goal` 调用成功后，把操作、目标、计数和本地时间追加到 local root 下的 `task-log/<agent-id>.md`，供 `ctx` 使用。写失败只记 warning。

**`ctx-post-compact-hint.ts`**：主会话 compact 后注入一个 `<post-compact-ctx>` 块，含 `## List`（等同 `ctx list`）和 `## Current session`（等同对主会话的 `ctx show`），两者来自同一份快照。subagent 详情仍需自己 `ctx show`。同时监听 `session_compact` 和成功的 `auto_compaction_end`，5 秒内只注入一次。subagent 会话不注入；出错只记 warning。

### 派发约束

**`isolation-nudge.ts`**：一次 `task` 调用会让两个以上可写 agent 不带隔离共用当前目录时，在 `tool_call` 阶段拦下，提示写入者加 `isolated: true`、只调查的项写明 `isolated: false`。

- 可写 agent：`task:*`、省略 `agent` 的项、`m1` 这类标记模型 agent。"两个以上"包括同一批里的多个，和本会话之前派出、仍在运行的共享写入者（取本会话的 async job；eval 的 `agent()` / `workpool()` 不算）。
- 只提醒一次：按每项 `task` 文本的 sha256 记录，原样重派放行，换了新 prompt 会再拦一次。记录只在内存里，每个会话（含 subagent 会话）各自一份。
- 不拦的情况：显式写了 `isolated: false` 的项；`task` 的 schema 里没有 `isolated`（隔离没启用或处于 plan mode）；扩展自己出错（只记 warning）。它不会替模型设置 `isolated`。

**`task-split-check.ts`**：在 `tool_call` 阶段用模型检查 `task` / `fork_task` 的每个派发项（共享 `context` 加该项 `task`），有一项不合格就整次拦下。

|检查|范围|问的问题|原样重派|
|---|---|---|---|
|`split`|主会话的 `task` 调用中，派给 `task:low` / `task:free` / `task:mid` 的项|这一项是否把多个主题塞给了一个 agent|放行（记为 `repeat`）|
|`report-limit`|任何会话的 `task` 和 `fork_task` 中，`agent` 为 `task:*` 或省略的项|是否限制了 worker 回报的长度|不放行，必须删掉限制|

- `split` 看主题不看文件数：同一个修改落到很多文件、同一主题写几份文档都算一个主题；几块互不依赖的调查、不相干的功能或 bug 放进同一项才算多个。拦截时要求按主题拆开，确认是单一主题的可原样重派。
- `report-limit` 指字数、字符、行、token、条目上限或"简短汇报"；给要写进仓库或文件的交付物定长度不算。拦截时要求删掉限制，长报告让 worker 写到文件（如 `local://<name>.md`）并回报路径。
- 请求：同一项需要判断的检查合并成一次 `openai-codex/gpt-6-sol`（推理强度 medium）请求，模型只看 prompt，逐行回答 `<检查名>: true|false`。所有项并发，共用 25 秒上限（低于宿主 30 秒的 `tool_call` 超时），调用方等最慢的一项。
- 缓存：按"检查 + prompt 的 sha256"记在内存。`split` 记所有有结论的；`report-limit` 只记判为无限制的。判断失败不记。
- 失败处理：模型不可用、请求失败或超时，这次请求里的检查都放行；某个回答解析不了，只放行那一项检查。
- 每次调用写一条 `task-split-check verdicts` info 日志。

**`fork-task.ts`**：注册 `fork_task` 工具。参数和 `task` 的批量形式相同，派出的也是原生 `task` 子代理（用自己的 agent 定义、模型、工具，Hub、`agent://`、`history://`、隔离与 patch 合并都走原生路径）。唯一区别是子代理的初始 transcript 是调用方当前对话的副本，之后才是派工单。适合派工单依赖本对话已有需求、决定和已读内容的多步实现、调试或设计落地；需要独立视角或背景很短时用 `task`。

和 `task` 的差别：

- `isolated` 默认 `true`，写 `isolated: false` 才共享目录。隔离子代理结束后不能续聊。
- 每项可选 `shake: true`，对副本执行与 `/shake` 相同的 `session.shake("elide")`。
- `name` 会加 `_xxxx` 后缀，子代理 id 以结果为准。
- 需要 `async.enabled: true`，否则报错。

shake 按 OMP 18.3.1 手动 `/shake` 的配置（`AGGRESSIVE_SHAKE_CONFIG`）：最近约 4,000 token 原样保留；更早部分里，所有文本工具结果、消息中不少于 400 token 的围栏代码块和顶层小写 XML 元素被替换成 `[shaken ~N tokens — recover: artifact://<id> (region K)]`，子代理可以 `read` 取回原文。`skill` 结果、`skill://` 读取、当前 plan 文件读取、块外正文、thinking、工具调用参数不动，已被 compaction 概括的历史不处理。

实现：把调用方会话 fork 到 `$TMPDIR/omp-fork-task/<uuid>/`，清零继承的费用，给未返回的工具调用补上中止结果，清空 todo，追加一条 `<system-notice cause="fork_task">` 说明这段对话只是背景；删掉父会话的运行时条目（`session_init`、`model_change`、`thinking_level_change`、`service_tier_change`、shake 辅助会话的 `session_exit`），其子条目挂到上一级。共享子代理保留父会话 cwd，隔离子代理的 cwd 置空，由执行器绑定到 worktree。shake 的 artifact 写进父会话的 artifact 目录，子代理共用。`task` 异步派发时先分配 id 再触发 `before_subagent_spawn`，扩展在这里把副本移到 `<父会话文件去掉 .jsonl>/<子代理 id>.jsonl`，执行器打开的就是它。

这依赖 OMP 内部实现（`AgentRegistry`、子会话文件路径、钩子顺序、会话条目类型）。每次升级 OMP 后，都要在真实 TUI 里重新验证继承、隔离、shake 和续聊。

### 提示与审查

**`tool-policy-nag.ts`**：发现用 `bash` / `bash_bg` 跑 `cat`、`sed`、`head`、`tail` 等命令读文件时计数。前三次只记录，超过后发一次 aside 提示，然后停止检测，直到下次 compaction 或会话边界。状态存在 session custom entry 里，不拦截命令。

**`repo-rules.ts`**：补上 OMP 不读的 repo 级 rule 目录。

- OMP 原生只读 `.omp/rules`、`.agent(s)/rules`、`.cursor/rules`、`.windsurf/rules`、`.clinerules`、`.github/instructions`，且 rule 必须有 `alwaysApply: true` 或 `description`，没有 frontmatter 的文件会被忽略。
- 本扩展从 cwd 往 repo root 扫 `.claude/rules`、`.agents/rules`、`.pi/rules`：`alwaysApply` 和无 frontmatter 的注入正文，只有 `description` 的列出路径供 `read`。同名文件离 cwd 近的优先。
- 在 `before_agent_start` 追加 `<repo-level-rules>` 块。正文按空白归一后和现有 system prompt 比对，已有的跳过，因此不会和原生 `<generic-rules>` 或用户级 `~/.claude/rules` 重复。用户级 rule 交给宿主处理。

**`doc-polish.ts`**：注册 `polish_doc` 工具和 `/polish-doc <path…>` 命令，在不改原意的前提下重排、润色 `.md` / `.txt`，输出"改之前 / 改之后 / 点评"评审文件到 `/tmp/doc-polish/<时间戳>-<名>/`（同目录保存原文副本）。

- 三个子代理，模型用 `provider/model:effort` 全名，可给逗号分隔的回退链：
  - 拆分：只有 `read` 和 `write`，自己读原文，写出带起止行号的切分索引和关键词表。
  - 润色：无工具，按不超过 5000 码点分批（不截断，超长段单独一批），只带相关词表，返回润色文本和词表变更。
  - 校验：无工具，逐组判断语义是否保持；没指定模型时用拆分模型。
- 配置优先级：调用参数 > `doc-polish.json`（cwd 下的优先于扩展目录下的）> 当前会话模型。键为 `splitModel`、`polishModel`、`checkModel`、`concurrency`。
- 配置里的模型不在模型列表中时，直接中止本次调用，返回说明，让主 agent 向用户解释三个模型的作用并由用户决定。
- 模型存在但请求失败（未在套餐内、限流、网络错误）时，该子代理重试最多 3 次，仍失败就报错，包含角色、模型全名、失败次数和 provider 原始报错。
- 拆分之后都是程序逻辑：润色批次全部并发，汇齐后按 `sourceIndices` 用并查集识别段落合并、重新编组，再并发校验，最后按原顺序写回。并发上限默认 6。子代理禁止加载扩展，不会递归。
- 结果：模型调用时，评审路径和"仅供参考"说明作为工具结果返回；人调用 `/polish-doc` 时，同样的结果作为新输入交给主 agent 处理。
- 副作用：写 `/tmp/doc-polish/`，按批消耗所选模型的额度。

**`watchdog-agent.ts`**：按目标投放的 watchdog，由 `WATCHDOG-<标签>.md` 驱动。原生 advisor 发现的 `WATCHDOG.md` / `WATCHDOG.yml` 会推给所有被顾问的会话，没法只投给某个目标，ExtensionAPI 也没有钩子能介入，所以本扩展自带运行路径。它不接管原生 `WATCHDOG.md`。

文件放在 `~/.omp/agent/WATCHDOG-*.md`，或从 cwd 到 git root 每层的 `<dir>/WATCHDOG-*.md`、`<dir>/.omp/WATCHDOG-*.md`。每个文件是一个独立的 watchdog，可以同时有多个，各自计数、各自运行、各自去重封顶。frontmatter：

|字段|说明|
|---|---|
|`target`（必填）|`main`、agent 名（如 `task:low`）、`*`、`subagents`，或逗号分隔列表|
|`name`、`enabled`|`name` 缺省取文件名里的标签，`/watchdog` 按它找 watchdog；`enabled` 默认 `true`，是全局开关|
|`delivery`|`aside`（默认）、`steer`、`nextTurn`、`followUp`|
|`maxPerContext`|本 watchdog 在两次压缩之间最多提醒几次，默认不限；每次压缩后计数清零|
|`every`|被观察的 agent 累计多少条操作（每个工具调用算 1 条，每条非空文字回复算 1 条）后跑一次，默认 30|
|`scope`|`full`（默认，看整条分支的全量上下文）或 `window`（只看本 watchdog 上次运行之后的新消息）|
|`model`、`tools`|聊天 reviewer 后端用，见下|
|`judge`、`instructions`、`option.*`|Jev 后端用，见下|

两种后端二选一：

- **聊天 reviewer**（默认）：`model` 可带 `:effort`，缺省用 `@advisor` 角色，再退到会话模型。`tools` 默认 `read` / `grep` / `glob`，只接受 read、grep、glob、ast_grep、web_search、edit、write、bash、eval。正文是审阅重点。reviewer 可以检查工作区，返回 `PASS` 或带严重度的问题说明。
- **Jev 判定**：`judge: <provider>/<model>`，指向 `api` 为 `typesafe` 或 `openrouter-decisions` 的模型，例如内置的 `typesafe/jev-latest`、`openrouter/~typesafe/jev-latest`，或在 `models.yml` 里自定义的 provider（`baseUrl` 指向兼容 `POST /v1/systemone` 的根地址，`api: typesafe`）。必须同时写正文；不能与 `model`、`tools`、`note` 或 effort 后缀同用，否则跳过该文件并记 warning。Jev 只看按 `scope` 选出的 transcript 和正文准则，从作者声明的选项里选一个，不调工具、不写解释；注入的文字是该选项预写的 prompt。按 judgment API 认模型，不按目录 kind（自定义 provider 的 kind 默认为 chat），也不会把 chat API 的同名模型当成 Jev；模型不可用、鉴权失败、响应无效、选了未声明的选项或超时就不提醒，不当作通过，也不退回聊天 reviewer。

Jev 选项用扁平键声明（frontmatter 解析器把键转成小写，所以标签只能是小写字母、数字、`_`、`-`；每个值占一行）：

|键|说明|
|---|---|
|`instructions`|可选，交给 Jev 的判定说明；缺省为“只按正文准则判断 transcript 里最近的工作，不推断 transcript 以外的事实”|
|`option.<标签>`|声明一个选项，值是交给 Jev 的判定标准；留空表示标签本身已足够说明。至少两个|
|`option.<标签>.prompt`|Jev 选中该选项时注入的文字；不写就是静默选项（相当于通过）。至少一个选项要有|
|`option.<标签>.delivery`|可选，覆盖该选项的投放方式，取值同 `delivery`；只能用于有 prompt 的选项|

注入标签是 `<watchdog name=… severity=<选中的标签>>`。未知的 `option.*` 键、只写了 prompt/delivery 却没声明的选项、空 prompt 都会让整个文件被跳过并记 warning。

示例 `~/.omp/agent/WATCHDOG-Evidence.md`：

```md
---
target: main
judge: typesafe/jev-latest
delivery: aside
option.pass: 最近的工作没有宣称已验证，或宣称时附了实际运行输出；证据不足时也选这个。
option.concern: 最近的工作宣称已验证，但没有给出实际运行时证据。
option.concern.prompt: 你最近宣称已验证，但 transcript 里没有运行时证据。补跑真实入口并贴出命令和输出；做不到就明确写“已改，未完成 runtime 验证”。
option.blocker: 最近的工作在没有任何运行的情况下宣布任务完成并交付。
option.blocker.prompt: 停止交付。你在没有运行验证的情况下宣布完成，这不算完成。先跑真实路径并给出证据，再重新报告。
option.blocker.delivery: steer
---
仅当最近的工作宣称代码已验证、却没有给出实际运行时证据时标记违例。
```

运行方式：

- 每条 assistant 消息结束时累加该 watchdog 的计数。计数达到 `every` 就立即运行，不等本轮结束；运行期间 agent 照常工作，运行结束后不管 agent 处于什么状态都立即按 `delivery` 注入。
- 本轮结束（`agent_end` 且不是 `willContinue`）时计数还没到 `every` 但大于 0，就补跑一次；该 watchdog 正在运行时，等它跑完再补跑。
- transcript 按 `scope` 取：`full` 为整条分支，`window` 为上次运行之后的消息；内容不截断，也不含自己注入的 `<watchdog>` 消息。聊天 reviewer 不通过、或 Jev 选中带 prompt 的选项时，以 `<watchdog name=… severity=…>` 注入匹配的会话。
- 注入时机按 `delivery`：`aside` 在运行中插到下一个 step 边界、空闲时开启新一轮；`steer` 打断当前运行；`followUp` 排到当前运行之后；`nextTurn` 等用户下一次提问。
- 主会话按文件名 `<时间戳>_<uuid>.jsonl` 识别，subagent 从 `session_init.agent` 读名字。
- 每个 watchdog 按提醒文本去重；设置了 `maxPerContext` 时按它封顶，默认不封顶。去重记录和封顶计数只在当前 context 内有效，每次压缩（手动或自动）后清零，所以 Jev 同一选项的 prompt 每个 watchdog 在两次压缩之间最多发一次；压缩不影响累计的操作条数、`window` 游标和正在进行的判定。分支切换和树跳转会重置全部计数、游标和封顶，并丢弃还没返回的判定。
- 任何失败都不提醒，也不阻塞主轮次。
- subagent 上的注入是尽力而为，只有执行器收走结果前会话被重新打开才生效。
- 聊天 reviewer 用禁止加载扩展的内存会话，不会递归。Jev 的用量和估算费用只写扩展 info 日志，不计入会话用量。两种后端各自消耗额度。

斜杠命令（子命令、watchdog 名和范围都有补全）：

|命令|作用|
|---|---|
|`/watchdog` 或 `/watchdog list`|列出发现的全部 watchdog 文件：当前是否生效、全局开关、本会话覆盖、目标、`every`、`scope`、后端和路径|
|`/watchdog on\|off <name>` 或 `… <name> session`|只在本会话开启或关闭，不改文件。记录为会话自定义条目，恢复会话后仍然有效，并跟随会话分支；只能用于目标包含本会话的 watchdog|
|`/watchdog on\|off <name> global`|改写该文件 frontmatter 里的 `enabled` 行（没有就加一行），对之后所有会话生效，并清除本会话对它的覆盖|

本会话覆盖优先于文件里的 `enabled`。关闭时正在进行的判定结果会被丢弃；重新开启时计数、游标和封顶从零开始。多个文件同名时命令报错并列出路径，需要给它们设不同的 `name`。
