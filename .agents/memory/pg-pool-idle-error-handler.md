---
name: node-postgres Pool needs an 'error' listener
description: Unhandled 'error' events on an idle pg Pool client crash the whole Node process, not just the affected query.
---

`node-postgres` (`pg`) emits an `error` event on the `Pool` instance when an
*idle* client's connection drops (server-side termination, network blip,
etc.) — this is not tied to any in-flight query/promise, so there is nothing
to `.catch()`. Without a `pool.on('error', ...)` listener, this surfaces as
an uncaught exception that takes the entire process down.

**Why:** this caused a real production-looking incident in this project —
the app looked like "everything disappeared, can't log in" from the user's
perspective, but the root cause was just a dropped idle DB connection with no
error handler, unrelated to any application code change.

**How to apply:** any shared DB client module that does `new Pool(...)`
should immediately register `pool.on('error', (err) => console.error(...))`
right after construction, before exporting the pool/drizzle instance. This
lets the pool recover by opening a fresh connection on the next query instead
of crashing the server. Check for this listener whenever setting up a new
Postgres-backed service or investigating a service crash that shows a raw
`pg` client object dump in logs (`severity: 'FATAL'`, code like `57P01`).
