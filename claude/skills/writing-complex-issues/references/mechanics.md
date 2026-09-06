# GitHub 发布与图维护

## 发布顺序

先创建 umbrella 取得编号，再创建无依赖 children，最后创建有依赖 children；Depends 引用真实编号后挂接并验证。编号取创建响应 URL，不预设连续；草稿占位符发布前替换成真实链接。

label 遵守目标 repo/preset 分类契约，不把别的 repo 的 `kind:code`、`kind:comment`、`kind:spike` 当成通用分类。

读取前按 `~/.claude/rules/gh-full-fetch-issues-prs.rule.md` 完整落盘。挂接、re-parent、GraphQL 示例与失败恢复统一见 `skill://writing-issue/references/sub-issue-api.md`，不另用窄 ID 查询或 count-only 验证。每次变更后核对本地完整 payload 中的具体关系。

## 发布前核对

- SKILL.md「成树判据」已过：同方向 ≥2 个相关 issue 时有 umbrella，且 umbrella 承载契约 / 关闭验证 / 编排，不是按严重度分组的范围索引。
- 依赖图与编排含物理共面盘点：同改一个文件的 children 已串行排链；「依赖关系：无」的 child 已对照过编排区块。
- 每个 child 的目标可追溯到方向 / 契约 / repo 既有承诺；追溯不到的进口目标已回传或显式假设，未直接立 child。
- 单个 issue 满足 `skill://writing-issue` 的来源、原子性、中文正文和逐条结果验收；没有内部脚手架，引用都在完整来源中核实。
- 方向四槽已落位：指称有依据或 unknown/audit owner；动机有来源或显式假设/回传；交付约束转绝对日期并入契约。
- umbrella 系统定位在契约之前；未决项有不可判定原因、解决方 child 和被 gate 的 children；关闭验证逐行可证伪，残留及例外有 owner。
- child 继承条款逐字快照，结果用性质描述；最省事路径不能钻过验收表；未知假设有实验与结果分支。
- 全文每处「归 PR / 待定 / 再说」经过 decision-closure：可判定的已裁决，不可判定的有解决路径。
- 完整 thread 的 comment 层与对抗审查已交付；仅草稿任务可按入口规则延后，但不宣称树完成。
