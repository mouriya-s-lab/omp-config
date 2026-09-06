# Flow Completeness — CRITICAL

Every user-initiated flow must have a clear beginning, middle, and end.

## flow-dead-end
The flow stops and the user can't continue. No next action, no completion state, no way back.

Check: walk every flow to completion. At each step, verify there's a next action, a completion state, or a way to go back.

## flow-broken-sequence
Steps happen in wrong order or skip required steps. The UI allows an action that requires prerequisite state not yet established.

Check: try step N+1 before step N. Try the last step first.

## flow-abandoned-state
Canceling mid-flow leaves orphaned state behind. Partial resources exist but UI doesn't reflect them.

Check: start a multi-step flow, cancel at each step, verify no phantom resources exist.

## flow-no-escape
User is trapped in a modal/state with no way out. No close button, no Escape key, no cancel.

Check: open every dialog/modal. Verify close button, Escape key, click-outside, Cancel button all work.
