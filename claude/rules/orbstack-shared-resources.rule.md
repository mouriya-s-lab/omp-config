---
alwaysApply: true
---

# OrbStack 必须共用资源，且所有使用都要在台账里登记

本机 `orb`/`orbctl`/`docker` 使用 OrbStack v2.1.3；所有本地测试依赖、服务、临时容器和调试 VM 都必须共享资源并登记到唯一台账 `~/Ext/work/orbstack/`，避免重复资源耗尽 RAM/磁盘或成为无人敢删的孤儿。

- 动手前先读台账并查 `docker ps -a`/`orb list`；存在可复用实例就复用，没有才新建，禁止未经检查直接 `docker run`/`compose up`。
- Postgres、MySQL、Redis、MongoDB、Kafka 等有状态依赖禁止按服务、测试套件或测试轮次各起一份；必须共享长期实例，以 database/schema/namespace/key-prefix 逻辑隔离，测试后只清理自己的数据。
- 无状态一次性构建、lint 或脚本容器可以用后销毁，但仍须登记；测试/调试后不得遗留未登记资源或下次再叠一份。
- 新建的共享/长期容器、卷、网络、compose stack 或 VM，及所有 OrbStack 使用，都要登记资源名、用途、共用者、端口/DSN/database 划分和起停命令；共享依赖的 compose/启动定义也放台账目录作为单一事实源。
- 改动后按 `runtime-verification-required` 实际连接验证，例如新建 Postgres 后 `docker exec` 查询，并记录连接方式。

凭据仍按 `credentials-belong-in-iac`，本规则只约束实例数量与登记。
