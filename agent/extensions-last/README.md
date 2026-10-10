# extensions-last

这里的扩展必须在其他按路径加载的扩展之后执行，所以不放进 `extensions/`，而是由 `config.yml` 的 `extensions` 按路径加载，并且写在列表的最后一项。

## 加载顺序

`before_agent_start` 的 handler 按加载顺序串行执行，每个拿到前一个返回的 system prompt；同一路径只在第一次出现时加载。并非所有事件都串行，例如 `session_shutdown` 的 handler 并发执行。

1. native 发现：`~/.omp/agent/extensions/`，以及 `settings.json` 的 `extensions` 列出的 TS/JS 模块（不管有没有 `config.yml`；其中的扩展包根目录只在没有 `config.yml` 时读）
2. hooks
3. 插件扩展
4. `-e` 参数
5. `config.yml` 的 `extensions`，按列表顺序
6. OMP 内置的 inline 扩展：SDK 传入的扩展、autoresearch、`.omp/tools/` 等自定义工具的包装

第 6 步仍在这里的扩展之后执行；其中 autoresearch 在 `/autoresearch` 模式下会改写 system prompt。

`extensions/` 目录内部不排序，顺序取决于 native glob 的遍历结果，不是文件名顺序。这里的文件如果放进 `extensions/`，会在第 1 步加载，`config.yml` 里指向同一路径的条目会被当成重复而丢弃。

轻量模式下，`config-light.yml` 把 `extensions` 覆盖成空列表，排除这里的扩展；`omp-light` 再用 `-e` 把本机 `config.yml` 里不在 `extensions-last/` 下的条目（如 `~/.claude`）传回去。

本文件不会被加载；仓库 → 本机的更新器（启动时自动更新和 `/update-omp`）与 `/sync-omp-config` 只同步这里的 `*.ts`。
