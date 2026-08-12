---
name: Browser Web Speech API as the live transcript source
description: Replaced server-side Whisper audio transcription with the client's own SpeechRecognition/webkitSpeechRecognition, grouped by wall-clock silence.
---

The moderator transcript is produced entirely client-side via the browser's
Web Speech API (Chrome/Edge only — no Firefox/Safari implementation exists),
not by uploading audio chunks to Whisper. The client posts a JSON `{text}`
to the server only once an utterance is finalized; there is no audio upload
and no server-side transcription call at all.

**Why:** the user explicitly asked for real-time recognized text to fill the
message box directly, with continuous speech staying in one message box and
only splitting into a new one after 5 seconds of silence — Whisper's
record-then-upload-then-transcribe round trip can't drive that live, and was
removed rather than kept as a parallel/fallback path.

**How to apply:** utterance grouping must be driven by wall-clock time since
the last *recognized word* (`lastSpeechAt`), not by the SpeechRecognition
instance's own start/stop lifecycle — browsers periodically end a
"continuous" session on their own even mid-sentence, and auto-restarting it
must never itself count as the silence that closes out a message. Accumulate
finalized + interim text across those instance restarts in refs outside the
recognizer, and only emit the "finalize into a permanent message" callback
after a real silence timeout (or the mic being turned off), never on
`onend`.
