---
name: Per-viewer WS broadcast + orval query-param collision
description: How to give different connected clients of the same room/project different rendered content (e.g. per-viewer translation), and an orval codegen collision to expect the first time an endpoint gets a real query param in a project using zod+react-query split codegen.
---

## Per-viewer broadcast (not per-room)

When different members connected to the *same* project/room need to see the *same* underlying
event rendered differently (e.g. each viewer's own selected display language), don't add a
project-wide setting. Instead:

- Store the per-viewer attribute (e.g. `lang`) on the WS `ClientInfo` for that socket, defaulted
  sensibly, and updated via a lightweight client→server message that takes effect immediately
  (no reconnect needed).
- Add a "which distinct values are in use right now" helper (e.g. `getProjectLanguages(projectId)`)
  and a "broadcast only to sockets matching one value" helper (e.g. `broadcastToProjectLang`).
- At the single place an event is posted, loop over the distinct values currently connected and
  send a version of the payload appropriate to each group, instead of one `broadcastToProject` call.
- Cache any expensive per-value transform (e.g. an LLM translation) keyed by (contentId, value) in
  the database, not just in memory, so re-fetch-on-reconnect and a second viewer picking the same
  value never re-pay the cost.
- The REST fetch-on-load/reconnect endpoint needs the same per-viewer parameter (e.g. `?lang=`)
  threaded through separately from the socket -- the socket only affects *future* live broadcasts,
  not the history a client fetches once on mount.

**Why:** a shared "project language" setting is wrong the moment two members legitimately want
different languages; the WS layer already tracks one `ClientInfo` per connection, which is the
natural place to hang a per-viewer attribute.

## Orval query-param name collision (zod + react-query split codegen)

The first OpenAPI operation in a project that gets a real *query* parameter (not just a path
param) can break the `api-zod` package's barrel `index.ts` (`export * from "./generated/api"` +
`export * from "./generated/types"`) with:

```
error TS2308: Module "./generated/types" has already exported a member named 'XyzParams'.
```

Orval emits a zod schema *const* named e.g. `ListXyzParams` in `generated/api.ts` AND a same-named
plain TS `type` in `generated/types/listXyzParams.ts`; a blanket wildcard re-export of both is
ambiguous. Fix in the hand-maintained `index.ts` (not the generated files, which say "do not edit
manually" and get wiped by `clean: true`): replace the wildcard `export * from "./generated/types"`
with an explicit named re-export list of every type in that folder's own generated `index.ts`
EXCEPT the one colliding `*Params` type -- the zod const already covers both the runtime schema
and (via `z.infer`) the static type for that one. Re-run `pnpm -w run typecheck:libs` after.

**How to apply:** whenever you add the first query parameter to an existing path-param-only
endpoint (or the first query param to a brand-new endpoint) in `openapi.yaml`, expect this and fix
`lib/api-zod/src/index.ts` immediately rather than assuming codegen is broken.
