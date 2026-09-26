# OntoConsens

A collaborative ontology engineering tool where teams upload an ontology, extract its class hierarchy with AI, and reach consensus on class properties together. Each user drafts property proposals privately, then enters a shared real-time space where up to three collaborators (each with a distinct color) see each other's proposals stacked on class nodes, agree or retract properties, watch each other's live cursors, and export the properties every member has agreed to keep. An AI moderator listens (with consent), transcribes the conversation, and steps in when discussion stalls on a property.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the API server (port 8080, proxied under `/api` and `/ws`)
- `pnpm --filter @workspace/onto-consensus run dev` — run the web frontend (Vite dev server, port 19982, proxied at `/`)
- `pnpm --filter @workspace/mockup-sandbox run dev` — run the component-preview sandbox used for canvas mockups (port 8081, proxied at `/__mockup`)
- `pnpm run typecheck` — full typecheck across all packages (`tsc --build` over libs, then `typecheck` in each artifact)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate `lib/api-client-react` (React Query hooks) and `lib/api-zod` (Zod request schemas) from `lib/api-spec/openapi.yaml`, then typecheck the libs
- `pnpm --filter @workspace/db run push` — push Drizzle schema changes to Postgres (dev only, no migration files)
- Required env: `DATABASE_URL` — Postgres connection string
- Each project creator supplies their own OpenAI API key (stored encrypted, see `lib/moderatorCrypto.ts`) — there is no shared server-side key

## Stack

Runtime & tooling:
- Node.js 24 (`v24.13.0` in this environment)
- TypeScript `~5.9.3`, pnpm workspaces (catalog-based dependency pinning in `pnpm-workspace.yaml`)
- Package manager: pnpm (enforced — a `preinstall` script blocks npm/yarn lockfiles)

Backend (`artifacts/api-server`, `@workspace/api-server`):
- Express `^5.2.1` — HTTP API, mounted under `/api`
- `ws` `^8.21.2` — WebSocket server for realtime collaboration, mounted at `/ws`
- PostgreSQL + Drizzle ORM `catalog:` (currently `^0.45.2`), schema/queries in `lib/db`
- `drizzle-kit` `^0.31.10` — schema push (no migration files; `push`/`push-force` scripts)
- `drizzle-zod` `^0.8.3` — derives Zod insert schemas from Drizzle tables
- `pg` `^8.22.0` — Postgres driver
- `bcryptjs` `^3.0.3` — password hashing
- Custom cookie-based session tokens (`cookie` `^2.0.1`, `cookie-parser` `^1.4.7`) — not a third-party auth library
- AES-based encryption for stored OpenAI API keys (`lib/moderatorCrypto.ts`, Node's built-in `node:crypto`)
- `multer` `^2.2.0` — multipart ontology file uploads (5MB limit)
- `cors` `^2.8.6`
- `pino` `^9.14.0` / `pino-http` `^10.5.0` / `pino-pretty` `^13.1.3` — structured logging
- Build: `esbuild` `0.27.3` (custom `build.mjs`), bundled to a single ESM `dist/index.mjs`, with `esbuild-plugin-pino` for worker-thread transports
- OpenAI APIs consumed directly via `fetch` (no SDK):
  - Chat Completions (`/v1/chat/completions`) and Responses (`/v1/responses`) APIs, model `gpt-5.6-terra`, for ontology-file extraction (`lib/aiOntologyExtractor.ts`) and moderator topic-detection/summarization (`lib/moderatorEngine.ts`)
  - Realtime API over WebSocket (`wss://api.openai.com/v1/realtime?intent=transcription`), model `gpt-live-transcribe`, for live speech-to-text (`lib/realtimeTranscription.ts`)

Frontend (`artifacts/onto-consensus`, `@workspace/onto-consensus`):
- React `19.1.0` + React DOM `19.1.0` (pinned exact — required by Expo elsewhere in the workspace catalog)
- Vite `catalog:` (currently `^7.3.2`) + `@vitejs/plugin-react` `^5.0.4`
- `wouter` `^3.3.5` — client-side routing
- `@tanstack/react-query` `catalog:` (currently `^5.90.21`) — server state, paired with generated hooks from `@workspace/api-client-react`
- Tailwind CSS `catalog:` (currently `^4.1.14`) via `@tailwindcss/vite`, plus `tailwindcss-animate`/`tw-animate-css`
- Radix UI primitives (accordion, dialog, dropdown, popover, select, tabs, toast, tooltip, etc.) wrapped as local `shadcn`-style components in `src/components/ui`
- `class-variance-authority` `catalog:`, `clsx` `catalog:`, `tailwind-merge` `catalog:` — component variant/class utilities
- `framer-motion` `catalog:` (currently `^12.23.24`) — animation (live cursors, chat panel transitions)
- `react-hook-form` `^7.55.0` + `@hookform/resolvers` `^3.10.0` + Zod — form validation
- `lucide-react` `catalog:` — icon set
- `sonner` `^2.0.7` — toast notifications
- `recharts` `^2.15.2` — charting primitives (available via the shared UI kit)
- `@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`, `@replit/vite-plugin-runtime-error-modal` — Replit dev-environment integrations
- Browser `MediaRecorder`/`Web Audio API` for microphone capture, resampled client-side to PCM16/24kHz before streaming to the backend

Shared libraries (`lib/*`):
- `@workspace/db` — Drizzle schema (source of truth for all tables), exported as `@workspace/db` and `@workspace/db/schema`
- `@workspace/api-spec` — hand-maintained OpenAPI 3 spec (`openapi.yaml`), source of truth for the HTTP contract; `orval` `^8.23.0` drives codegen
- `@workspace/api-client-react` — generated React Query hooks (from `orval`), depends on `@tanstack/react-query`
- `@workspace/api-zod` — generated Zod request-body schemas (from `orval`), depends on `zod`
- Zod `catalog:` (currently `^3.25.76`) used throughout for runtime validation (`zod/v4` import path in schema files)

Artifacts registered in this workspace:
- **API Server** (`artifacts/api-server`, kind `api`) — Express + WebSocket backend, path `/api` and `/ws`
- **OntoConsens** (`artifacts/onto-consensus`, kind `web`) — the product frontend, path `/`
- **Canvas** (`artifacts/mockup-sandbox`, kind `design`) — isolated Vite preview server used only for design/mockup iteration on the canvas, path `/__mockup`; ships its own copy of the same Radix/shadcn UI kit for standalone component previews

## Where things live

- `lib/db/src/schema/` — Drizzle table definitions, one file per domain: `users.ts`, `projects.ts`, `ontology.ts`, `properties.ts`, `moderator.ts`. This is the single source of truth for the data model.
- `lib/api-spec/openapi.yaml` — the HTTP API contract. Edit this first, then run codegen; never hand-edit the generated output in `lib/api-client-react` or `lib/api-zod`.
- `artifacts/api-server/src/routes/` — Express route handlers: `auth.ts`, `projects.ts`, `properties.ts`, `moderator.ts`, `health.ts`.
- `artifacts/api-server/src/lib/` — backend business logic:
  - `auth.ts` — session token issuance/verification, `requireAuth` middleware
  - `moderatorCrypto.ts` — AES encryption/decryption for stored OpenAI API keys
  - `aiOntologyExtractor.ts` — parses an uploaded ontology file (via OpenAI) into a class hierarchy
  - `moderatorEngine.ts` — the AI moderator: participant activation, transcript recording, chat message log, silence/topic-detection intervention logic, consensus/export notice
  - `realtimeTranscription.ts` — manages one OpenAI Realtime API session per active mic, streams PCM audio in and transcript deltas out
  - `wsHub.ts` — the project WebSocket hub: connection tickets, presence, cursor broadcast, and every `ServerEvent`/`ClientEvent` shape
- `artifacts/onto-consensus/src/pages/` — route-level screens: `login.tsx`, `register.tsx`, `dashboard.tsx`, `project.tsx`, `not-found.tsx`
- `artifacts/onto-consensus/src/components/` — `GraphCanvas.tsx` (the class-hierarchy graph and property stacks), `ModeratorChatPanel.tsx` (AI moderator chat/transcript UI), `WorkspaceGuidePanel.tsx`, plus the shared `ui/` primitives
- `artifacts/onto-consensus/src/hooks/` — `useProjectSocket.ts` and `useDashboardSocket.ts` (WebSocket client state), `useModeratorAudio.ts` (mic capture/resampling), `use-auth.tsx`

## Architecture decisions

- **Per-member private property budgets, not a shared cap.** Before the shared space opens, each project member gets a fixed quota of proposals per class based on member count and join order (colorSlot); quotas always sum to a fixed total (7) so the class-wide cap stays constant whether it's split across members (private phase) or shared (consensus phase). No cross-member duplicate check — two members can independently propose the same name.
- **Every member opts the AI moderator in/out individually**, not project-wide. "On" means both "listen to my mic" and "include my speech in summaries" — there's no separate mic-consent step beyond the browser's own permission prompt.
- **Export is the permanent consensus marker.** `projectsTable.exportedAt` is stamped once, idempotently, on first successful `GET /projects/:id/export`. From that point the AI moderator's intervention-generating OpenAI call is permanently gated off for that project (checked inside `generateIntervention`) — mic access, transcript recording, and moderator enable/disable otherwise remain fully functional after export.
- **Chat log is the durable, canonical AI-moderator record.** Every intro/system/transcript/intervention/export-notice message is a persisted row (`moderatorChatMessagesTable`), not just a live WebSocket event, so a reload or rejoin replays identical history via `GET /projects/:id/moderator/messages`.
- **Intervention wording is reconciled, not regenerated.** `moderatorInterventionPointsTable` holds the canonical text for each example/counterexample point ever raised; new interventions reconcile against these existing rows so a point's exact wording stays stable across multiple interventions rather than being reworded each time the model re-derives it.
- **Live transcription runs server-side via OpenAI's Realtime API**, not the browser's Web Speech API — avoids browser-specific recognizer bugs and lets audio streaming, VAD, and moderator logic all live in one place (`realtimeTranscription.ts`).
- **The API server has no dev-mode hot reload.** `pnpm run dev` runs a full `build` (esbuild) then `start` — any backend change requires a workflow restart to take effect, unlike the Vite-powered frontend which hot-reloads.

## Product

- **Auth**: username/password registration (requires an OpenAI API key up front) and login, with a server-issued session token.
- **Project creation**: upload an ontology file, choose member count (1–3) and whether the AI moderator is enabled; the file is parsed into a class hierarchy via OpenAI.
- **Private drafting phase**: each member proposes properties on classes within their own budget; marking yourself "ready" locks your private space until every member is ready.
- **Shared consensus phase**: once all members are ready, a real-time shared space opens — proposals from every member appear stacked on class nodes (color-coded per member), with live cursors, agree/retract actions, and (if enabled) an AI moderator that transcribes speech and intervenes when discussion on a property stalls.
- **Export**: any member can export the project's ontology plus the properties everyone agreed to keep, and a conversation transcript. Export also permanently freezes AI intervention for that project and posts a one-time "consensus reached" notice into the record.

## User preferences

- Suppress the benign OpenAI Realtime "buffer too small" commit error (a manual commit landing on <100ms of trailing audio) from both server logs and the client-facing `moderator_error` broadcast — it's an expected race, not a real failure.

## Gotchas

- After any backend edit, restart the **API Server** workflow — it does not hot-reload.
- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen` before using the new types/hooks in either artifact.
- `db push` needs a real TTY to answer ambiguous rename prompts in a non-interactive shell.
- Editing both the backend and frontend in one change requires restarting the API Server workflow; the frontend's Vite dev server picks up its own changes via HMR automatically.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript project references, and package details.
