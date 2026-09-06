#!/usr/bin/env bash
# PostCompact hook: tell Claude *how* to rediscover rules + memory after
# compaction, not which specific files exist. The model uses Glob/Read to
# enumerate them itself, so adding new rule or memory files needs no hook
# change.
#
# Output protocol: JSON on stdout with hookSpecificOutput.additionalContext,
# which Claude Code injects into the next model turn as system context.

set -u

read -r -d '' prompt <<'EOF'
Compact 刚结束。压缩摘要会丢细节，rule / memory 文件大概率已经掉出窗口。在处理用户的下一条消息之前，按下面这套方法论自己 Glob + Read，把完整上下文重新装回来。不要凭压缩摘要的印象作答，不要假设之前看过的文件清单还成立——文件随时会被增删。

加载顺序与来源（与 Claude Code SessionStart loader 一致）：

1. 用户级规则目录
   - Glob `~/.claude/rules/**/*.md`，把命中的每个文件 Read 一遍。
   - 这是"对所有项目都生效的个人 rule"层。

2. 用户全局 CLAUDE.md
   - 若 `~/.claude/CLAUDE.md` 存在，Read 它。
   - 不存在就跳过，不要编。

3. 项目 CLAUDE.md（向上查找）
   - 从当前 cwd 起，向上逐级父目录查找第一个出现的 `CLAUDE.md`，找到就 Read，找不到就跳过。
   - 只读最近的那一个，不要读所有祖先。

4. 项目本地 .claude/CLAUDE.md
   - 若 `<cwd>/.claude/CLAUDE.md` 存在，Read。

5. 项目本地规则目录（如有）
   - 若 `<cwd>/.claude/rules/` 存在，Glob 其中的 `**/*.md` 并全部 Read。

6. Auto-memory
   - 当前 cwd 的 memory 索引位于：`~/.claude/projects/<cwd-with-/-replaced-by->/memory/MEMORY.md`
     例：cwd 是 `/Users/foo/bar` → `~/.claude/projects/-Users-foo-bar/memory/MEMORY.md`
   - 先 Read 这个 MEMORY.md（索引）。
   - 然后按其中列出的每个条目，Read 它指向的同目录下的具体 memory 文件。
   - 文件不存在就跳过，不要编。

完成全部读取后再回应用户。任何一步读失败要明示，不要静默继续。
EOF

jq -n --arg ctx "$prompt" '{
  hookSpecificOutput: {
    hookEventName: "PostCompact",
    additionalContext: $ctx
  }
}'
