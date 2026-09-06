# User-level capability-tier delegation

The operator's ordinary subagents are capability tiers, not job roles. Their model and reasoning effort are configured separately by the operator; agent Markdown does not pin either. Use the declared contracts below, not guesses about the selected model's intelligence or tool familiarity.

| Agent | Assignment contract |
|---|---|
| `unrestricted` | No additional capability restrictions. Open-ended or complex work, difficult external interaction, and escalations. |
| `bounded` | Normal programming and clearly scoped, moderately exploratory work. Can investigate ordinary unknowns, report unexplored areas, and ask about suspicious findings. Escalates complex or unfamiliar workflows and intertwined unresolved decisions. |
| `specified` | Normal programming from explicit specifications, with POSIX/GNU tools and established GitHub CLI operations. No open-ended exploration, independent verification, or unfamiliar software such as moat, even with documentation. |

## Selection
- You SHOULD actively identify and delegate suitable work to `bounded`; do not reserve it for mechanical edits or demand that every implementation step already be decided. Supply the goal, relevant facts, constraints, acceptance criteria, and known risks so it can use its limited exploratory capability.
- You SHOULD use `specified` for well-specified work within its declared interaction boundary. Give unambiguous inputs, rules, relevant code or patterns, required steps, and concrete checks. Large or technically demanding implementations are not excluded merely by size.
- Use `unrestricted` for work outside those contracts. Delegation does not imply reducing capability, and there is no required usage ratio.
- Assess the task's uncertainty and required interactions against these definitions. Do not ask yourself whether an unnamed model probably knows a tool. Interactions outside a tier's declared supported scope belong to a higher tier until the operator updates the contract.
- When a task mixes complex external interaction with explicit implementation, perform or delegate the complex part at the appropriate tier, then hand its real results to the lower tier. Do not send an unsuitable whole task just because its instructions are detailed.
- Direct deterministic tools remain preferable when they already solve the work; do not add model calls solely to consume a lower tier.

## Dispatch and acceptance
- All five bundled agents (`task`, `scout`, `sonic`, `reviewer`, `security-reviewer`) are disabled. You MUST explicitly name `unrestricted`, `bounded`, or `specified` in ordinary task/eval agent spawns. Never omit the agent field: the root spawn default remains the disabled `task`. The tool named `task` itself remains available.
- Treat the selected agent's capability boundary as part of the assignment. Honest reporting of an unsupported branch is a handoff, not failure to persist; do not pressure the worker to guess or fabricate completion.
- Expect `bounded` to distinguish evidence, suspicions, and unexplored areas. Resolve its concrete questions and take over work beyond its scope.
- Do not use `specified` as an independent explorer or verifier. It can execute supplied checks, but you MUST inspect the actual artifacts and execution evidence and complete independent acceptance at a stronger tier. A worker's success claim alone is not evidence.
- Keep the main session on the operator-selected model. Do not change model assignments, effort, or global tiny/smol roles as part of delegation.
