---
name: Export permanently freezes the AI moderator
description: How a one-time "consensus reached" export gate must be enforced across every entry point that could otherwise run the AI moderator again.
---

When a product has an "export" or "finalize" action meant to be the permanent end of an AI-driven process (moderation, generation, live collaboration), a single client-side disabled-button check is not enough. The server must persist a one-time timestamp (e.g. `exportedAt`) on first successful export, and every independent trigger path for that AI process must check it:

- The route that opens a new AI/streaming session (e.g. a websocket "start" message)
- The route/action that lets a user (re-)enable their participation
- The function that actually persists AI-consumed input (e.g. transcript chunks) — check again inside the same transaction that does the write, not just before it, to close races with in-flight requests
- The function that actually calls the AI provider — check again right at the top, since a call can already be queued (e.g. behind a debounce/silence timer) before the export lands

**Why:** each of these can independently re-arm the AI process if only one is gated; a race where an in-flight request lands microseconds after export must still be rejected inside its own transaction, not just blocked at the entry point.

**How to apply:** broadcast the freeze over any realtime channel already in place so every connected client reacts immediately (stop polling, stop mic/streaming, show a frozen/read-only state) rather than waiting for the next poll interval. Watch for circular imports when the realtime broadcast helper and the AI-engine module import each other — duplicate a small direct DB check rather than importing across that boundary.
