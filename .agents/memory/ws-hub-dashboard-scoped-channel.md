---
name: Adding a user-scoped (non-project) WebSocket channel to wsHub
description: How the realtime hub was extended beyond its original per-project-only design so events can reach a user who isn't inside any project page (e.g. the dashboard).
---

The original `wsHub` (`artifacts/api-server/src/lib/wsHub.ts`) assumed every
connection belongs to exactly one project (ticket always carried a
`projectId`, and presence/cursor logic is keyed on it). That design left no
way to notify a user sitting on a project-less screen (the dashboard) of
something happening to a project they're a member of — e.g. another member
deleting a shared project — without waiting for a poll interval.

**Why:** "Immediate" cross-user updates for events that can happen while the
affected user is *not* inside the relevant project's page require a
connection that isn't tied to a project.

**How to apply:** Made `projectId` optional on the ticket/client-info types.
A ticket with no `projectId` (issued via a separate `/ws-ticket` endpoint,
distinct from `/projects/:id/ws-ticket`) registers as a "dashboard" client:
skip presence/cursor broadcast and inbound cursor messages for it, and add a
`broadcastToUsers(userIds, event)` that targets only these project-less
clients by userId. Server routes that mutate something visible on the
dashboard (e.g. project deletion) look up the affected member userIds
*before* any cascading delete removes the membership rows, then call both
`broadcastToProject` (for anyone currently inside the project) and
`broadcastToUsers` (for anyone on the dashboard). Same pattern should be
reused for any future "notify the dashboard immediately" requirement instead
of adding ad hoc polling.
