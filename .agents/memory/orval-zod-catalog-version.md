---
name: Orval zod codegen breaks with catalog: zod pin
description: lib/api-zod codegen emits invalid zod v4 syntax (z.int(), File/Blob types) against the workspace's pinned zod v3, breaking typecheck:libs right after orval runs.
---

Symptom: after `pnpm --filter @workspace/api-spec run codegen`, `pnpm run typecheck:libs` fails with
`Property 'int' does not exist on type ... zod` and/or `Cannot find name 'File'/'Blob'` in
`lib/api-zod/src/generated/*`.

**Why:** Orval's zod generator auto-detects the target zod major version by reading the literal
string in `lib/api-zod/package.json`'s `dependencies.zod`. This workspace pins zod via
`"zod": "catalog:"` (a pnpm catalog reference, not a real semver string). Orval's version parser
can't parse `"catalog:"`, silently falls back to assuming Zod v4, and emits v4-only syntax
(`z.int()`) even though the installed package is zod v3.25.x. Separately, a `type: string, format:
binary` field in the OpenAPI spec (e.g. multipart file upload) makes orval emit `File`/`Blob`
types, which aren't in scope without the DOM lib.

**How to apply:** In `lib/api-spec/orval.config.ts`, explicitly set `override.zod.version: 3` under
the `zod` output config (do not rely on `'auto'`). If any endpoint uses `format: binary` (file
upload), also add `"dom"` to `lib/api-zod/tsconfig.json`'s `compilerOptions.lib` (alongside
`es2022`) so `File`/`Blob` resolve. Re-run codegen and `pnpm run typecheck:libs` after fixing.
