---
name: Live caption cleared out from under a resumed utterance
description: Why "clear this speaker's live caption when their message is persisted" needs an utteranceId, not just a userId, once finalize and storage are decoupled from capturing the next utterance.
---

Symptom: a speaker's live caption box briefly vanishes/stutters right as they resume talking
immediately after a silence-triggered finalize.

**Why:** Finalizing an utterance (silence timer fires) and persisting it (a network round trip)
were made deliberately non-blocking so the speech recognizer can keep capturing the next utterance
immediately, without waiting on storage. But the "a real transcript message landed, clear this
speaker's live caption" handler was keyed only by `userId` — if the speaker had already started a
new utterance by the time the OLD utterance's persistence confirmation arrived (any client viewing
the shared live caption, not just the speaker's own), that handler would blindly delete whatever
caption text was CURRENTLY showing, wiping out the new utterance's in-progress caption instead of
just tidying up the stale one.

**How to apply:** When finalize/persist and next-capture are intentionally decoupled (fire-and-forget
`onFinalize`), give each utterance a monotonically increasing id local to that capture session.
Thread it end to end: capture hook → live "caption" socket message → `LiveCaption` state → the
persisted message broadcast (echoed back, doesn't need to be persisted to the DB) → the "clear on
arrival" handler, which must compare the live caption's current utteranceId against the one just
persisted and no-op if they don't match. Never clear a shared/broadcast piece of live state purely
because "a related event landed" — key the clear on an id that identifies exactly which version of
the state that event corresponds to.
