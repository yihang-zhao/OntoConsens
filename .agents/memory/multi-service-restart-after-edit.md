---
name: Multi-service edit needs multi-workflow restart
description: Editing code in more than one service/workflow but only restarting one makes the unrestarted change look broken or absent
---

When a fix spans multiple services (e.g. a monorepo with a separate frontend
workflow and backend/API workflow), a code edit to one service has zero
effect until *that service's* workflow is restarted. Restarting only the
service you happened to edit most recently — while forgetting an earlier
edit to a different service — silently leaves the old build running.

**Why:** In one debugging session, a backend quota-check change was made,
then a frontend change was made afterward, and only the frontend workflow
was restarted. The backend kept serving its pre-edit build. This produced a
confusing symptom (an optimistic UI update appearing then vanishing) that
looked like a client-side race/rendering bug, when the real cause was just
"the server never picked up the fix." A live curl-based repro against the
actual endpoint (not just re-reading the diff) is what surfaced it — the
server returned the exact old error message from the pre-edit code path.

**How to apply:** After any change that touches more than one workflow's
codebase, restart *every* workflow whose source changed, not just the one
most recently edited. When a "shouldn't happen anymore" bug still reproduces
after a fix, verify runtime behavior directly (curl/API call, not just
re-reading the code) before assuming the fix logic itself is wrong — check
whether the running process actually contains the new code first.
