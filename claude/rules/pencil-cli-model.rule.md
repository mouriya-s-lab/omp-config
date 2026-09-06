---
alwaysApply: true
---

# Pencil CLI 永远用 claude-opus-4-7

调用 `pencil` CLI（生成、编辑、迭代任何 `.pen` 文件）时，`--model` / `-m` 参数必须固定 `claude-opus-4-7`。禁用其他任何模型

新增或改动 `pencil ...` 命令时，命令行里若没有 `--model claude-opus-4-7` 就是违规。生成结果不满足预期时 **重跑或改 prompt**，不允许"这次换个 model 试试"。
