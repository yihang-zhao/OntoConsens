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

**Restart gap drops the first word(s) of the next utterance:** the browser
stops capturing audio the instant `onend` fires and only resumes once a new
`SpeechRecognition` instance's `start()` actually takes effect; any extra
artificial delay (e.g. a `setTimeout` before calling `start()` again) is pure
additional lost-listening time stacked on top of that unavoidable gap, and
shows up as "the first few words of every utterance aren't recognized" since
`onend` fires at most speech pauses (i.e. utterance boundaries), not rarely.
Call `start()` again immediately/synchronously inside `onend`; only fall back
to a delayed retry from `start()`'s own catch block if the immediate call
throws (session not fully released yet). Also add a stuck-recognizer
watchdog (compare last recognized-word time against actual mic audio energy
from a separate volume meter) to force-abort+restart if the recognizer goes
quiet with no `onresult`/`onerror`/`onend` at all despite audible sound —
otherwise transcription can silently stop forever with zero events firing.
