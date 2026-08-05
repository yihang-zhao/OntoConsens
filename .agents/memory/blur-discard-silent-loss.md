---
name: onBlur silently discarding inline-edit input
description: Inline "type then press Enter" form patterns that cancel on blur can silently drop real user input with zero error/feedback — looks like a sync/consensus bug but is a UI pattern bug.
---

An inline create/edit text input inside a `<form>`, submitted only via Enter keypress
(no visible submit button), must not treat `onBlur` as "discard the draft." Any natural
UI interaction that moves focus away (clicking elsewhere, tabbing, a testing tool that
fills the field then clicks something else) fires blur before Enter, and an
`onBlur={() => cancel()}` handler wipes the input with no network call and no console
error — indistinguishable from a real backend/sync bug when investigating "my data
never appeared."

**Why:** In OntoConsensus, a merge-by-name consensus feature appeared completely broken
(property never showed up for either user post-ready) purely because the property-name
input's `onBlur` cancelled the add/edit form instead of committing it — the POST request
was never sent. Confirmed via direct DB inspection (zero rows for the affected project)
after backend logic itself checked out fine via curl.

**How to apply:** When building any inline "type name, press Enter" affordance without an
explicit submit button, make `onBlur` call `e.currentTarget.form?.requestSubmit()` (which
routes through the existing submit handler, so empty-input guards still apply) instead of
directly resetting state to "not editing." Only truly cancel on blur if empty input is the
desired no-op path.
