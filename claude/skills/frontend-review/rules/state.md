# State Correctness — CRITICAL

UI must accurately reflect backend state. What the user sees must match what the server knows.

## state-ui-backend-mismatch
UI shows something different from API response. After a mutation, snapshot the UI and curl the API. Compare.

## state-stale-after-action
UI doesn't update after a user action succeeds. Create/update/delete something, check if the UI reflects the change without manual refresh.

## state-phantom
UI shows something that no longer exists. Delete an entity via API, check if the UI still shows it. Click it — does it 404?

## state-contradictory
Two UI elements show conflicting info about the same state. Find every place a piece of state is displayed, verify they all agree.

## state-lost-on-navigation
Navigating away and back loses user context. Set filters, scroll position, tab selection. Navigate to a detail page and back. Is the state preserved?
