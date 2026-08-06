---
name: api-server dev script doesn't hot-reload
description: artifacts/api-server's "dev" script runs "build then start" once, not a watcher -- backend source edits need a workflow restart to take effect.
---

The api-server artifact's package.json "dev" script is `build && start` against a compiled dist bundle, not a file watcher (unlike the Vite frontend, which hot-reloads instantly). Any edit to artifacts/api-server/src/**/*.ts is invisible to the running server -- including to your own curl-based verification -- until the "artifacts/api-server: API Server" workflow is explicitly restarted.

**Why:** Spent a full debugging cycle chasing a "duplicate project name check doesn't work" report that reproduced via curl, when the check's code was actually correct -- it just hadn't been rebuilt since it was written earlier in the session.

**How to apply:** After any edit under artifacts/api-server/src, restart the API Server workflow before testing/curling against it, exactly like the existing "multi-service edit needs multi-workflow restart" lesson -- but note this one is stricter: even testing the *same* service you just edited requires a restart, not just a different one.
