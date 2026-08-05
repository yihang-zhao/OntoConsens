---
name: n3 package has no TypeScript types
description: The `n3` (Turtle/RDF) npm package ships no bundled .d.ts and has no @types/n3 on npm.
---

`n3` (used for Turtle/RDF parsing) has no bundled TypeScript declarations, and there is no
`@types/n3` package published either (checked via `npm view @types/n3 version` — no result).

**Why:** without types, `new Parser().parse(content, (error, quad) => {...})` callback params
are implicitly `any` (TS7006), and imports fail with "Could not find a declaration file".

**How to apply:** add a small local ambient module declaration (e.g. `src/types/n3.d.ts` with
`declare module "n3" { ... }`) covering just the `Parser`, `Quad`, and `Term` shapes actually
used, rather than searching for upstream types that don't exist.
