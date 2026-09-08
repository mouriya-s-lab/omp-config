# omp-config

这不是完整的 `~/.omp` 备份。仓库只保存可审查的配置和安装入口。

## 直接迁移

以下内容直接复制到 `~/.omp/agent/`：

- `agent/config.yml`：OMP 配置和 UI 行为
- `agent/APPEND_SYSTEM.md`：追加系统提示词
- `agent/agents/`：agent 定义
- `agent/extensions/`：本地扩展代码

不要复制整个 `agent/` 目录。数据库、WAL、日志、缓存和锁文件是运行时状态，不属于迁移内容。

迁移前先备份并检查差异；迁移后重启 OMP：

```bash
mkdir -p "$HOME/.omp/agent"
cp agent/config.yml "$HOME/.omp/agent/config.yml"
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
- 仓库没有出现数据库、WAL、日志、缓存或插件运行时文件
