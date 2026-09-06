# Data Integrity — HIGH

What goes in must come back out unchanged. Defaults must be sensible.

## data-truncation
User input silently truncated or modified. Submit long text, special chars, unicode, markdown. Retrieve and compare.

## data-wrong-default
Default values don't match common use case. Open every form, check if pre-selected values make sense.

## data-invisible-required
Required field has no indication. Submit empty, see which fields error. Were they marked before submission?

## data-lost-on-switch
Switching modes/types clears fields user already filled. Shared fields (title, description) should survive type switches.

## data-filter-mismatch
Search results don't match query. Test exact text, partial text, case-insensitive, search across fields.
