---
name: Stale prebuilt .d.ts shadows live TS source in project-reference monorepo
description: A composite lib package (e.g. lib/db) with emitDeclarationOnly can silently feed tsc stale types from its dist/*.d.ts instead of the edited src/*.ts, even though runtime (tsx/vite) always uses the real source.
---

In this pnpm workspace, packages like `lib/db` use TypeScript project references with
`composite: true, emitDeclarationOnly: true, outDir: "dist"`. Even though the package's
`exports` field points at `./src/index.ts` (so *runtime* always sees live source), a
consuming package's plain `tsc --noEmit` can still resolve types from a previously built
`dist/*.d.ts` snapshot in that referenced project, ignoring recent source edits entirely.

**Symptom:** you add/rename fields on a drizzle table (or any exported type) in a referenced
package, the edit is definitely saved, but a dependent package's typecheck still reports the
*old* shape (e.g. "Object literal may only specify known properties, and 'newField' does not
exist in type {...old fields...}"), and just deleting `.tsbuildinfo` files does not fix it.

**Why:** the referenced project's own compiled declaration output in `dist/` is stale from a
prior build and nothing automatically re-triggers `tsc --build` on that referenced project
when only its `.ts` source (not run through its own build) changes.

**How to apply:** if a cross-package typecheck error looks impossibly stale (the reported type
shape doesn't match the current source at all), rebuild the referenced package's declarations
directly before debugging further: `cd lib/<pkg> && npx tsc --build --force`. Then re-run the
dependent package's typecheck.
