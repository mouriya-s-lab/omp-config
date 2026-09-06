# 验收契约的历史反例

本页保留原 skill 的历史案例，供需要解释规则来源时按需阅读，不作为相关系统当前状态的证明。使用案例作新的事实依据前，按完整抓取规则取得来源并核实。

- 2026-07-02 的一次 Agent 实验审计：原记录描述机制引用虽逐字精确，「真实 Agent session」「目标 Agent 任务」「代表性 CLI 样本」却没有定义，验收统计的总体悬空。原 skill 未给该仓库 owner，本页不构造来源 URL；这个记录只能帮助理解反例，不能直接作为新 issue 的事实引用。教训是写清 workload、样本总体与业务场景，而不是把选择责任留给执行者。
- 2026-06-11 W0 审计中的 [coder-loop #422](https://github.com/mouriya-s-lab/coder-loop/issues/422)：原记录指出「新增 preset 业务绑定只改 preset 文件」没有对应真实路径验收；单测手工注值绕过 spawn 路径，全表绿仍未证明业务结果。它分别说明结果覆盖缺口和实现者自写测试的自我认证风险。
- [coder-loop #176](https://github.com/mouriya-s-lab/coder-loop/issues/176) 是原 skill 引用的 forward-contract umbrella 案例：parent 承载共享契约而不直接接受 PR，children 分别由 closing PR 实现。模板与当前规则见 `skill://writing-complex-issues`，不要照抄案例中的领域内容。
