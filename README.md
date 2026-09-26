# OntoConsens

A collaborative ontology engineering tool where up to three people upload an ontology, extract its class hierarchy with AI, privately draft property proposals, then move into a shared real-time space to reach consensus on which properties to keep — with an optional AI moderator listening in and stepping in when discussion on a property stalls.

This document walks through the whole product as one continuous workflow, from a user's first login to the final export, and specifies exactly which technology makes each step work.

## Stack summary (versions)

- Node.js 24 (`v24.13.0`), TypeScript `~5.9.3`, pnpm workspaces with catalog-pinned versions
- Backend: Express `^5.2.1`, `ws` `^8.21.2`, PostgreSQL + Drizzle ORM `^0.45.2`, `drizzle-kit` `^0.31.10`, `drizzle-zod` `^0.8.3`, `pg` `^8.22.0`, `bcryptjs` `^3.0.3`, `multer` `^2.2.0`, `pino` `^9.14.0`, esbuild `0.27.3`
- Frontend: React `19.1.0`, Vite `^7.3.2`, `wouter` `^3.3.5`, `@tanstack/react-query` `^5.90.21`, Tailwind CSS `^4.1.14`, Radix UI primitives, `framer-motion` `^12.23.24`, `react-hook-form` `^7.55.0`
- API contract: hand-written OpenAPI 3 spec in `lib/api-spec`, codegen'd by `orval` `^8.23.0` into `lib/api-client-react` (React Query hooks) and `lib/api-zod` (Zod schemas)
- AI: OpenAI Chat Completions/Responses API, model `gpt-5.6-terra`, for ontology extraction and moderator reasoning; OpenAI Realtime API over WebSocket, model `gpt-live-transcribe`, for live speech-to-text

## Workflow: login to export

### 1. Registration and login

- `POST /auth/register` (`artifacts/api-server/src/routes/auth.ts`) creates a user row in `usersTable` (`lib/db/src/schema/users.ts`). An OpenAI API key is **required at registration** — every project this user later creates uses this one key for its AI moderator and ontology extraction, regardless of which member turns the moderator on.
- Passwords are hashed with `bcryptjs` `^3.0.3` (`bcrypt.hash(password, 10)`), never stored in plain text.
- The API key is encrypted at rest with **AES-256-GCM** (Node's built-in `node:crypto`), not hashed — it must be decryptable to make OpenAI calls later. The encryption key itself is derived from the `SESSION_SECRET` environment secret via `HMAC-SHA256` with a fixed context string (`lib/moderatorCrypto.ts`), so no separate secret needs provisioning. Each encrypted value stores three parts in `usersTable`: ciphertext, IV, and auth tag, all base64-encoded.
- `POST /auth/login` verifies the password with `bcrypt.compare` and issues a **session token**: a `crypto.randomBytes(32)` hex string held in an in-memory `Map` (`artifacts/api-server/src/lib/auth.ts`), not a JWT and not a cookie. Tokens expire after 30 days and are single-active-per-account — a fresh login immediately invalidates whatever token that account had before, anywhere.
- The client stores the token in `sessionStorage` (tab-scoped) and sends it as `Authorization: Bearer <token>` on every request, specifically so two different accounts can be logged in side by side in separate browser tabs without a shared cookie clobbering each other — a deliberate choice for testing multi-member collaboration.
- `requireAuth` middleware resolves the bearer token to a `userId` on `req.userId` for every protected route.

### 2. Creating a project (ontology upload + AI extraction)

- `POST /projects` (multipart, via `multer` `^2.2.0`, 5MB file limit) takes a project name, an ontology file, a member count (1–3, enforced against `MAX_PROJECT_MEMBERS`), and whether the AI moderator is enabled.
- The creator's decrypted OpenAI API key is fetched (`getUserApiKey`), then the uploaded file is parsed by `extractOntologyWithAI` (`artifacts/api-server/src/lib/aiOntologyExtractor.ts`) using OpenAI model **`gpt-5.6-terra`**:
  - Text-like files (`.ttl`, `.owl`, `.rdf`, `.jsonld`, `.n3`, etc., or anything that samples as printable text) are decoded and sent as plain text to the **Chat Completions API** (`POST https://api.openai.com/v1/chat/completions`).
  - Binary/office formats (`.pdf`, `.docx`, `.pptx`, images) go through OpenAI's **Files API** (`POST /v1/files`) to upload the raw bytes, then the **Responses API** (`POST /v1/responses`) to extract structured content — the model reads the file natively rather than the server trying to parse PDF/DOCX itself.
  - The model's JSON response is parsed into `{ classes: {uri, label}[], relations: {childUri, parentUri}[] }`.
- If no connected class hierarchy comes back, project creation fails with a 400. Otherwise: a row is inserted into `projectsTable` (with a random `crypto.randomBytes(4)` hex `inviteCode`), the creator is added to `projectMembersTable` with `colorSlot: 0`, and every extracted class/relation is inserted into `ontologyClassesTable` / `ontologyRelationsTable` (`lib/db/src/schema/ontology.ts`).
- Project names are globally unique (case-insensitive).
- Other members join later via `POST /projects/join` using the invite code, and are assigned the next `colorSlot` (0 = Blue, 1 = Purple, 2 = Yellow — see `COLOR_SLOT_NAMES` in `moderatorEngine.ts`, matched to `--member-N` CSS hues in the frontend).

### 3. Private drafting phase

- Each member proposes properties on classes via `POST /projects/:id/properties`, but only within their own **fixed private budget** — computed from member count and `colorSlot` in `PROPERTY_QUOTAS_BY_MEMBER_COUNT` (`artifacts/api-server/src/routes/properties.ts`): a 1-member project gets 7 slots on one class; 2 members split 4/3; 3 members split 3/2/2. Budgets always sum to the fixed class-wide total of 7. There is no cross-member duplicate check — two members may independently propose the same name for the same class.
- `PATCH /projects/:id/ready` marks a member ready — a **one-way commitment**: once set, that member can no longer add/rename/delete their own proposals while waiting for the others, checked via `isOwnSpaceLocked`.
- The shared consensus space only unlocks once **every** member up to `maxMembers` (the project's fixed target, not just however many have joined) is ready.

### 4. Entering the shared real-time space

- The frontend opens a WebSocket to `/ws` (`artifacts/api-server/src/lib/wsHub.ts`, built on `ws` `^8.21.2`). Connection is gated by a short-lived **ticket**, not the bearer token directly: `POST /projects/:id/ws-ticket` mints a `crypto.randomBytes(24)` hex ticket valid for 30 seconds, exchanged for the actual socket handshake. A separate `POST /ws-ticket` (no project id) issues a **user-scoped** ticket for the dashboard, so it can learn about project deletions in real time without polling.
- Once connected, the hub tracks presence per project and broadcasts a `presence` event listing online `userIds` whenever someone joins/leaves.
- Live cursor positions are relayed as `{ type: "cursor", userId, x, y }` events, echoed to everyone except the sender.
- Property changes (`property_created`, `property_updated`, `property_deleted`, `agreement_changed`, `member_joined`, `member_ready`, `member_count_changed`) are broadcast as lightweight "something changed, refetch" signals — the frontend re-queries via React Query rather than trusting event payloads as the source of truth for that data.
- **Property agreement** in the shared phase: `POST /projects/:id/properties/:propertyId/agree` records a row in `propertyAgreementsTable` (unique per property+user). A property counts as fully agreed once every member of the project has a row there.

### 5. Turning on the AI moderator (per member, opt-in)

- The moderator has **no project-wide on/off** — each member independently toggles their own participation via `PUT /projects/:id/moderator`. "On" means both "listen to my mic" and "include my speech in the shared summary" simultaneously; there is no separate consent step beyond the browser's native microphone permission prompt.
- Turning it on requires the project creator to have a saved OpenAI key (checked via `projectOwnerHasApiKey`), lazily creates a shared `projectModeratorTable` row (holding the chosen model, default `gpt-5.6-terra`, and a running summarization checkpoint), and mints a fresh `activationId` (`crypto.randomUUID()`) stored on `moderatorParticipantsTable`. This id is stamped onto every transcript chunk recorded during this "on" period, so a race where a member quickly toggles off-then-on can never let a stale in-flight write land under the wrong session.
- A one-time **intro** chat message is posted the first time the shared space opens for a project (`ensureModeratorIntroMessage`), and a **system** message announces each member's own mic start/stop (`postRecordingStartedMessage` / `postRecordingStoppedMessage`).

### 6. Live transcription (audio capture → OpenAI Realtime API)

- The browser captures microphone audio via the Web Audio API (`useModeratorAudio.ts`), resamples it client-side to **PCM16 mono at 24kHz**, and streams it as raw binary WebSocket frames to `/ws` (not JSON).
- The hub enforces a **token-bucket rate limit** per socket (`artifacts/api-server/src/lib/wsHub.ts`): max 64KB per frame, sustained rate capped at 48,000 bytes/sec (matching the real PCM stream rate) with a 2-second burst allowance; a socket that racks up more than 20 violations is closed outright. This exists specifically so a compromised or misbehaving client can't run up the project owner's OpenAI bill or exhaust server resources.
- On `mic_start`, the server opens a dedicated WebSocket to OpenAI's **Realtime API** (`artifacts/api-server/src/lib/realtimeTranscription.ts`): `wss://api.openai.com/v1/realtime?intent=transcription`, one connection per active (project, member) pair. The `intent=transcription` query param is required — omitting it defaults to a conversational session and rejects the transcription-only `session.update` with an `invalid_model` error.
- The session is configured via `session.update` with `audio.input.transcription.model: "gpt-live-transcribe"`, plus up to 40 keyword hints drawn from the project's own ontology class labels and property names (filtered to reject anything containing `<`, `>`, newlines, or over 64 characters — a single malformed keyword can otherwise reject the *entire* session.update and silently kill transcription).
- Raw audio is forwarded via `input_audio_buffer.append`. Audio that arrives before the OpenAI socket has finished opening is queued client-side in a bounded buffer (~5 seconds / 240,000 bytes) so a member's first words are never dropped during setup.
- **`gpt-live-transcribe` has no turn-detection (VAD) of its own** — confirmed to reject `turn_detection` outright. The server implements its own: every incoming audio chunk's RMS (root-mean-square of its Int16 samples) is checked against a fixed threshold (400) to decide "is this speech or silence"; once 2 continuous seconds pass with no speech-like chunk (checked every 250ms), the server sends a manual `input_audio_buffer.commit` to force OpenAI to finalize whatever utterance is buffered. This manual-commit loop is the entire turn-taking mechanism for this integration.
- Each finalized utterance (OpenAI's `...completed` event) is recorded as a row in `moderatorTranscriptChunksTable` (tagged with `activationId`) and immediately mirrored into `moderatorChatMessagesTable` as a `"transcript"` message, then broadcast live over `/ws` as a `moderator_chat_message` event — visible to every project member regardless of their own mic state.
- A benign, expected error from this pipeline — `input_audio_buffer_commit_empty` / "buffer too small... Expected at least 100ms" (a manual commit landing on a trailing sliver of audio under 100ms) — is deliberately swallowed rather than logged or surfaced to the client, since it's a normal race at utterance boundaries, not a real failure.

### 7. AI intervention when discussion stalls

- `generateIntervention` in `moderatorEngine.ts` fires once **three conditions** are all true:
  1. **Silence** — no member's live caption has updated for `SILENCE_TIMEOUT_MS` = **2,000 ms** (tracked via `noteSpeechActivity`, which fires on every raw live-caption update, not just finalized messages).
  2. A **new, finalized** transcript message has landed since the last check.
  3. That new content hasn't already been folded into the last intervention (checked against `lastSummarizedAt`, a durable per-project checkpoint column — never re-summarizes the same chunks twice, even across a server restart).
- Concurrent intervention attempts for the same project are **serialized** through a per-project promise queue (`interventionQueues`), so two silences occurring close together can't race and corrupt the checkpoint.
- The actual reasoning is a **two-pass design**, both calls to OpenAI's Chat Completions API using the project's configured model (default `gpt-5.6-terra`):
  - **Pass 1 (topic detection)** looks only at what's new since the last checkpoint, and must resolve to an exact class + property already present in the project's own ontology/property catalog (verified against real DB rows, never trusting free-form model text as an id).
  - **Pass 2 (full-history extraction)**, run only if pass 1 resolves to a real property, re-reads **every** transcript chunk ever tagged to that class+property (chunks are retroactively tagged the first time they're attributed, and that tag is never overwritten) — not just what's new — so a point raised several rounds ago and never repeated is never silently dropped.
- The result is reconciled against `moderatorInterventionPointsTable`, the durable canonical record of every distinct example/counterexample ever raised for a property: existing points keep their exact original wording forever (never reworded by a routine re-extraction), and a new member independently making the same point is just added to that point's list of supporters (`by`) rather than creating a duplicate.
- A `moderator_intervention_typing` WebSocket event tells clients to show a brief "AI moderator is typing" indicator; the real message (type `"intervention"`, with `matched`, `classId`/`propertyId`, and structured `examples`/`counterexamples`) is already durably committed by the time that indicator appears.

### 8. Export (permanent consensus marker)

- `GET /projects/:id/export` — any member can trigger this once. The **first successful call** for a project stamps `projectsTable.exportedAt` (idempotent; later calls just re-download the same frozen state) and posts a one-time `"export_notice"` chat message via `postConsensusReachedMessage`.
- From that instant, `generateIntervention` permanently refuses to call OpenAI again for this project (checked at the top of the function) — this is the **only** gate tied to export. Mic access, live transcription, transcript-chunk recording, and toggling one's own moderator participation on/off all continue to work normally after export; only the AI reasoning call itself is frozen.
- The `"export_notice"` message is always persisted (so it appears in every project's exported transcript), but only rendered in the **live chat UI** when the project has `moderatorEnabled: true` — for AI-disabled projects it's filtered out client-side (`ModeratorChatPanel.tsx`) and only shows up in the export file.
- The export response includes the ontology's classes/relations plus every property that reached full agreement (every one of the project's `maxMembers` members has a row in `propertyAgreementsTable`).
- `GET /projects/:id/export-conversation` returns the complete, ordered moderator chat log as structured JSON: one entry per message with `sequence`, `type`, `timestamp`, `speakerUsername`, `content`, and — for `"intervention"` messages — the full `classId`/`propertyId`/`examples`/`counterexamples` breakdown.

## Where things live

- `lib/db/src/schema/` — Drizzle table definitions (`users.ts`, `projects.ts`, `ontology.ts`, `properties.ts`, `moderator.ts`) — the single source of truth for the data model.
- `lib/api-spec/openapi.yaml` — the HTTP API contract; edit this first, then run `pnpm --filter @workspace/api-spec run codegen` to regenerate `lib/api-client-react` and `lib/api-zod`.
- `artifacts/api-server/src/routes/` — `auth.ts`, `projects.ts`, `properties.ts`, `moderator.ts`, `health.ts`.
- `artifacts/api-server/src/lib/` — `auth.ts` (sessions), `moderatorCrypto.ts` (API key encryption), `aiOntologyExtractor.ts` (file → class hierarchy), `moderatorEngine.ts` (the AI moderator's whole lifecycle), `realtimeTranscription.ts` (OpenAI Realtime API sessions), `wsHub.ts` (the project WebSocket hub).
- `artifacts/onto-consensus/src/pages/` — `login.tsx`, `register.tsx`, `dashboard.tsx`, `project.tsx`, `not-found.tsx`.
- `artifacts/onto-consensus/src/components/` — `GraphCanvas.tsx` (class hierarchy + property stacks), `ModeratorChatPanel.tsx` (AI moderator chat/transcript UI), `WorkspaceGuidePanel.tsx`, shared `ui/` primitives.
- `artifacts/onto-consensus/src/hooks/` — `useProjectSocket.ts`, `useDashboardSocket.ts`, `useModeratorAudio.ts`, `use-auth.tsx`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the API server (port 8080, proxied under `/api` and `/ws`)
- `pnpm --filter @workspace/onto-consensus run dev` — run the web frontend (port 19982, proxied at `/`)
- `pnpm --filter @workspace/mockup-sandbox run dev` — component-preview sandbox for canvas mockups (port 8081, proxied at `/__mockup`)
- `pnpm run typecheck` / `pnpm run build` — typecheck / typecheck+build across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate generated API client/schema packages from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push Drizzle schema changes to Postgres (dev only, no migration files)
- Required env: `DATABASE_URL` (Postgres connection string), `SESSION_SECRET` (used to derive the AES key for encrypted OpenAI API keys)

## Gotchas

- The API server has **no dev-mode hot reload** — `pnpm run dev` does a full esbuild rebuild then restarts; any backend edit needs a workflow restart. The frontend's Vite dev server hot-reloads on its own.
- After editing `lib/api-spec/openapi.yaml`, always run codegen before using new types/hooks.
- `db push` needs a real TTY to answer ambiguous rename prompts in a non-interactive shell.
