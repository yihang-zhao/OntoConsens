---
name: OpenAI realtime transcription session setup
description: Non-obvious config/shutdown gotchas for OpenAI's Realtime transcription API (gpt-live-transcribe) not evident from the SDK/type surface.
---

- Session config (transcription mode, audio format, model, language/keyword hints, turn detection) is set via a `session.update` message sent right after the socket opens, not via URL query params on the initial connect.
- With server VAD enabled, OpenAI still stops detecting silence once you stop sending audio (there's nothing left to go quiet) — so on your own "stop" action you still need a manual `input_audio_buffer.commit` to force the last in-flight utterance to finalize. Don't skip it just because VAD is otherwise driving turn-taking.
- After that manual commit, wait for the real `...transcription.completed` event before treating the utterance as durably persisted — a fixed timer is not a substitute and creates a rare-but-real dropped-final-utterance race if the event arrives late. Use the timer only as a safety-net ceiling, not the primary signal.

**Why:** the "session config via URL vs. message" split and the "VAD needs an explicit override on your own stop" behavior were the two non-obvious mismatches from what the naive/generic Realtime-API mental model suggests; both fail silently rather than erroring loudly.

**How to apply:** when wiring up any Realtime API session (transcription or full conversational) that needs a clean "stop and flush" path.
