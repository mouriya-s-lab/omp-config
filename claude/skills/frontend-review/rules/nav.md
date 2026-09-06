# Navigation Logic — HIGH

User must always know where they are, how they got there, and how to get somewhere else.

## nav-dead-link
Link/button navigates to 404 or error page. Click every navigation element, verify destination exists.

## nav-lost-context
Navigate to detail and back — scroll position, tab selection, filters reset. Back should restore the previous view state.

## nav-no-breadcrumb
On a deep page, user can't tell where they are in the hierarchy. No way to navigate up.

## nav-circular
Navigation path leads back to start without progress. Anchor links creating unnecessary history entries.

## nav-deep-link-broken
Pasting a URL directly doesn't load correct state. Filter/tab state not encoded in URL params.
