# sub-issue API

## 前置：完整上下文与真实 ID

先按 `~/.claude/rules/gh-full-fetch-issues-prs.rule.md` 完整抓取 parent、child 及已有 parent 的对象和附件到本地；核对 repo、issue 身份与当前边。从该完整 payload 取得真实 GraphQL node ID，分别设置 `PARENT_ID`、`CHILD_ID`；re-parent 另设 `OLD_PARENT_ID`。不要只查询 `issue { id }`，也不要假设本地 payload 的固定 JSON schema。完整抓取工具或 ID 不可用时先报告缺口，不凭编号合成 ID。

仅对已授权的目标图操作。parent 与 child 都必须是 Issue；跨 repo（同 org）可连接，closed parent 与 closed child 也可连接，不需要改 body。

## 连接

```bash
gh api graphql -f query='
  mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){
    subIssue{number title}issue{number title}}}' \
  -f p="$PARENT_ID" -f c="$CHILD_ID"
```

`-f` 用于字符串 ID；需要整数 GraphQL 变量时用 `-F`，否则会出现 `Variable $num of type Int! was provided invalid value`。

mutation 响应不代替完整验证。图已变化时重新完整抓取受影响对象，确认具体 parent/child 身份及所有边，不能仅靠 `subIssues.totalCount` 判断。

## re-parent

先确认正确归属，记录迁移理由，再从旧 parent 移除并连接新 parent：

```bash
gh api graphql -f query='
  mutation($p:ID!,$c:ID!){removeSubIssue(input:{issueId:$p,subIssueId:$c}){
    subIssue{number}}}' -f p="$OLD_PARENT_ID" -f c="$CHILD_ID"
```

随后用新 `PARENT_ID` 执行上面的 `addSubIssue`，完整读回复核。若第二步失败，child 可能已无 parent；先核对状态，再完成目标连接或恢复旧边。不要复制 child，迁移不等于删除任务，也不改写已落地 body。

## 失败恢复

| 响应 | 处置 |
|---|---|
| `Could not resolve to Issue node with the global id of 'PR_...'` | 误把 PR 当 issue，修正树：用 issue 作中间层或把 children 提为 siblings。 |
| `Sub issue may only have one parent` | 明确归属后 re-parent；若接受现有 parent，另一条线仅散文引用。 |
| `Issue may not contain duplicate sub-issues` | 已有该边；确认身份后视为幂等 no-op。 |
| HTTP 504 | 结果可能未知，完整读回确认边；未生效再重试同一调用，避免盲目重复迁移。 |
