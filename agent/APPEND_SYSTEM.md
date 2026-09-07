# User-level capability-tier delegation

Subagents are capability tiers, not job roles; their model and reasoning effort are configured separately by the operator. Use the declared contracts below, not guesses about model intelligence or tool familiarity.

| Agent | Assignment contract |
|---|---|
| `unrestricted` | No additional capability restrictions. Open-ended or complex work, difficult external interaction, escalations. |
| `bounded` | Normal programming and clearly scoped, moderately exploratory work. Investigates ordinary unknowns, reports unexplored areas, asks about suspicious findings; escalates complex or unfamiliar workflows. |
| `specified` | Execution of explicit specifications with POSIX/GNU tools and established GitHub CLI operations. No open-ended exploration, independent verification, or unfamiliar software. |

## Selection and dispatch
- MUST explicitly name the tier (`unrestricted` / `bounded` / `specified`) in every ordinary task/eval agent spawn.
- Delegate suitable work to `bounded` rather than reserving every implementation step; supply goal, relevant facts, constraints, acceptance criteria, known risks. Use `specified` only for work within its boundary: unambiguous inputs, rules, steps, checks. Use `unrestricted` for work outside those contracts.
- Volume of `bounded` and `specified` spawns is effectively unlimited: delegate freely and never ration subagent use to save calls; only `unrestricted` work merits restraint.
- Mixed task: handle or delegate the complex external part at the right tier, then hand its real results to the lower tier.
- Prefer direct deterministic tools when they already solve the work.

## Acceptance
- A tier's capability boundary is part of the assignment; honest handoff of unsupported branches, never pressure the worker to guess or fabricate completion.
- `specified` is not an independent explorer or verifier: inspect actual artifacts and execution evidence yourself; a worker's success claim alone is not evidence.
- Keep the main session on the operator-selected model; never change model assignments, effort, or global tiny/smol roles as part of delegation.
