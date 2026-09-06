# Error Recovery — CRITICAL

Users make mistakes. Systems fail. The UI must let users recover without losing work.

## edge-no-undo
Destructive action with no confirmation or undo. Delete, remove, close — check each one.

## edge-lost-input
Form data lost when submission fails. Fill a long form, cause a failure (network, validation). Is input preserved?

## edge-concurrent-mutation
Two operations on the same entity conflict silently. Open same entity in two tabs, edit both, save both. What happens?

## edge-empty-state
Zero-data case shows blank area instead of explicit empty state with call-to-action.

## edge-long-content
Extremely long text breaks layout. 500+ char inputs, markdown in descriptions, special characters in tags.

## edge-rapid-action
Double-click creates duplicates. Rapid status toggles cause race conditions. Submit button doesn't disable on first click.
