# User Feedback — HIGH

Every user action must produce visible feedback. The user should never wonder "did that work?"

## feedback-silent-success
Action succeeds but UI gives no indication. No toast, no status change, no visual update.

## feedback-silent-failure
Action fails but UI gives no indication. Button returns to normal state, no error message.

## feedback-no-loading
Slow operation (>200ms) has no loading indicator. No spinner, skeleton, or progress.

## feedback-ambiguous-state
UI shows a state that could mean multiple things. Label is imprecise or context-dependent.

## feedback-no-affordance
Something is interactive but looks static. No hover effect, no cursor change, no visual distinction from non-interactive elements.
