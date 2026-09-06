---
alwaysApply: true
---

# 画图一律用 Mermaid，禁止字符画

任何流程图、架构图、时序图、状态机、类图、ER 图、调用关系图、树、甘特图、思维导图或网络拓扑，在对话、Markdown、README、PR/issue、注释、skill 或设计稿中都必须输出 ` ```mermaid ` 代码块。流程/框图用 `flowchart`，时序图用 `sequenceDiagram`，状态机用 `stateDiagram-v2`，类图用 `classDiagram`，实体关系用 `erDiagram`，甘特图用 `gantt`，思维导图用 `mindmap`；节点使用清晰领域名称，连线标明条件、动作或数据流向。

禁止用 ASCII/Unicode 符号手拼图、用 `A --> B --> C` 等箭头文字冒充图、用多行缩进模拟节点连线，或以阅读端不能渲染为由退回字符画。Mermaid 是可 diff、review、复用和渲染的结构化文本，避免字符图的对齐、扩展和字体问题。

例外：

- 用户明确要求 ASCII art、字符画或纯文本图时按其要求。
- 不相关改动可保留已有字符图；新图仍必须使用 Mermaid。
- `tree`、`git log --graph`、Docker 拓扑等工具自身的字符输出可原样引用。
- 字段对照、配置列表、对比矩阵等表格仍用 Markdown 表格。
