---
name: writing-pipeline
description: 通用写作流水线。四个阶段（选题→大纲→写作→润色），每个阶段有独立的核心 skill 定义关键动作。产出形态由可选的领域 skill 决定（博客、分析报告、商务文档等）。当用户要求写文章、写博客、把素材转成正式文本时触发。
---

# 写作流水线

分四个阶段将素材转化为正式文章。每个阶段有独立的核心 skill，定义该阶段的关键动作和质量门控。产出形态（博客、报告、商务文档等）由可选的风格 skill 决定，核心 skill 与内容类型无关。

## 阶段概览

| 阶段 | 核心 Skill | 产出 | 门控 |
|------|-----------|------|------|
| 1. 选题 | `wp-topic-select` | `topic-selection.md` | 对抗分析通过 |
| 2. 大纲 | `wp-outline-build` | `outline.md` | 对抗检验通过 |
| 3. 写作 | `wp-write` | `draft.md` | 体裁一致性自检通过 |
| 4. 润色 | `wp-polish` | `article.md` | 两轮制动检查通过 |

## 使用方式

1. 读取本 skill，了解四个阶段的关系和体裁维度框架
2. 按顺序读取并执行每个阶段的核心 skill
3. 每个阶段可选择加载风格 skill，但核心 skill 必须执行
4. 阶段间通过中间文件传递约束——下一阶段必须读取上一阶段的产出
5. 如果下游发现上游问题，回退修改上游产出后再继续

## 阶段间约束链

```
素材 → [选题] → topic-selection.md → [大纲] → outline.md → [写作] → draft.md → [润色] → article.md
```

- 大纲必须在选题确定的形态和角度范围内展开
- 写作必须跟着大纲的逻辑线、结构、节奏走，并在体裁维度上完成定位
- 润色不改结构，分两轮执行（surface → text-based），每轮有制动机制

## 体裁维度框架

写作阶段（wp-write）和风格 skill 共享以下维度。wp-write 定义每个维度的默认值，风格 skill 提供该体裁在每个维度上的具体取值和操作规则。

| 维度 | 来源 | 控制什么 |
|------|------|---------|
| 交际目的 | Swales genre theory | 文章要完成什么社会功能 |
| 语步结构 | Move analysis | 文章必须经过哪些功能阶段，哪些可选 |
| 语场 (Field) | Halliday SFL | 专业程度、术语密度 |
| 语旨 (Tenor) | Halliday SFL | 作者-读者权力关系、情感距离、社会距离 |
| 语式 (Mode) | Halliday SFL | 口语-书面连续体上的定位 |
| 评价姿态 | Martin Appraisal Theory | 用什么类型的评价资源、单声还是多声 |
| 信息密度 | Biber Multi-Dimensional Analysis | Involved（介入性）还是 Informational（信息性） |

风格 skill 不需要解释这些维度的学术含义——pipeline 已经定义了。风格 skill 只需要给出每个维度的具体取值和操作化规则。

## 风格 Skill

风格 skill 按体裁维度组织，为每个维度提供该体裁的具体取值。各阶段从风格 skill 中取需要的部分：选题阶段取交际目的和语步结构的偏好，大纲阶段取逻辑线和结构偏好，写作阶段取全部维度的定位值，润色阶段取额外检查项。

| 风格 | Skill 名 | 核心特征 |
|------|----------|---------|
| 博客 | `wp-style-blog` | 交际目的=分享思考、Tenor=近距离高情感、Mode=书面化口语、评价=情感+判断丰富 |
| 分析报告 | `wp-style-report` | 交际目的=证据支持决策、Tenor=远距离低情感、Mode=极度书面化、评价=鉴赏为主 |

也可以不加载任何风格 skill——wp-write 有中性默认值。

## 所有文件保存在同一输出目录

```
output_dir/
├── topic-selection.md
├── outline.md
├── draft.md
└── article.md
```
