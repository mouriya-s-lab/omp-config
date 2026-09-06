---
name: frontend-review
description: Review changed UI flows for completion, backend/state agreement, recovery and data integrity; interaction correctness, not visual styling.
allowed-tools: Bash(moat:*), Bash(*/moat:*), Bash(curl:*), Read, Grep, Glob, Agent
---

# Frontend interaction review

Review the changed surfaces, not the whole app unless requested. Prioritize completion, state correctness and recovery before feedback, navigation, data integrity, consistency and disclosure. This is not a spacing/color/typography review; layout matters when it prevents use or hides content.

## Execute the flow

1. Identify the affected user journey, prerequisites, expected final state and relevant rules below.
2. Read `skill://agent-browser` before browser use; follow its configured remote/fallback routing. Follow `~/.claude/rules/runtime-verification-required.rule.md` for the complete real-user path: authenticate, enter the feature, operate, submit, observe the result and persisted/downstream effects. A homepage check or isolated API call is not a frontend review.
3. At each meaningful transition, capture the page state, enabled/disabled controls and user feedback. After mutation, compare the UI with the actual API response and persisted DB/downstream state using the environment's authorized read path. For a confirmed local API endpoint, an auxiliary observation can be:

   ```bash
   curl -s http://localhost:<port>/api/<endpoint> | jq .
   ```

   Resolve the real endpoint and authentication first; do not guess them or expose credentials. A success status without the returned entity/state does not prove agreement.
4. Exercise applicable boundaries: empty and max-length input, long text/special characters/Unicode/Markdown, rapid repeat actions, failed submission, conflicting edits in two tabs, back/forward, direct links, refresh mid-flow and cancel at each step. Observe whether data survives and partial resources are cleaned up. Use authorized test data; do not cause destructive production effects for a review.
5. Report observed failures and passes with reproduction, expected versus actual UI/backend result, and evidence. Unexercised paths remain unverified. UI-change screenshots belong in the PR body under `skill://writing-pr`; use `skill://image-share` for durable images.

## Focused rules

Read only categories relevant to the affected journey. One observation can cover several categories: execute it once, report the primary failure once, and cross-reference related rule IDs rather than duplicating findings. In particular, `state-lost-on-navigation` and `nav-lost-context` use the same back-navigation observation; use the navigation finding for lost view context and reserve state findings for disagreement with backend/entity state.

| Priority | Category | Severity | Reference |
|---|---|---|---|
| 1 | Flow completion: prerequisites, dead ends, cancel cleanup, escape | CRITICAL | [flow.md](rules/flow.md) |
| 2 | State: UI/API mismatch, stale or phantom entities, contradictory displays | CRITICAL | [state.md](rules/state.md) |
| 3 | Recovery: destructive confirmation/undo, failed input, concurrent/rapid actions, empty/long content | CRITICAL | [edge.md](rules/edge.md) |
| 4 | Feedback: success, failure, loading, state clarity, affordance | HIGH | [feedback.md](rules/feedback.md) |
| 5 | Navigation: destinations, return context, hierarchy, history, deep links | HIGH | [nav.md](rules/nav.md) |
| 6 | Data: round-trip fidelity, defaults, required fields, mode switches, search correctness | HIGH | [data.md](rules/data.md) |
| 7 | Consistency: click/CRUD/mode/keyboard behavior | MEDIUM | [interaction.md](rules/interaction.md) |
| 8 | Disclosure: basic path complexity, essential controls, state-dependent visibility | MEDIUM | [disclosure.md](rules/disclosure.md) |

## Report

```markdown
## Frontend Review: <scope and environment>

### <page/component>

- [CRITICAL] `state-ui-backend-mismatch`: <reproduction; expected and observed UI/API/persisted state>
  Evidence: <screenshot, response or log reference>
  Fix: <concrete correction>
- [PASS] `flow-abandoned-state`: <cancel step exercised and observed cleanup>

### Not verified / blocked

<Specific paths, missing capability and what would establish the result; omit if none.>
```

Group by page/component or file. Every failure needs a concrete fix; every pass needs an actual observation. PR review comments and verdicts follow `skill://review-pr`, which remains responsible for acceptance rather than this UI-only report.
