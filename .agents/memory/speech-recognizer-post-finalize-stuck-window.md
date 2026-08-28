---
name: Speech recognizer stuck-bug clusters right at utterance boundaries
description: Why "first few words of a newly-resumed utterance aren't recognized" persisted even after fixing restart delay and adding a general stuck-recognizer watchdog.
---

Context: builds on `browser-speech-recognition-transcript.md` and the general stuck-recognizer
watchdog it documents (Chrome can silently stop delivering any onresult/onend after a pause, while
looking like it's still running).

**Why the general watchdog wasn't enough:** its thresholds (audio-active-recently grace + no-result
timeout) are deliberately conservative so it doesn't false-trigger on normal recognizer latency
during ordinary mid-utterance pauses. But the exact pause our own "1s of silence finalizes this
utterance into a new message" logic detects is *the same kind of pause* that triggers Chrome's
silent-stuck bug — so the bug clusters almost every time a new utterance/message box starts, not
rarely. Waiting out the general thresholds before recovering meant losing the whole grace+timeout
window's worth of the user's opening words every single time, which read as "the first few words of
the new message are never recognized," not as an occasional glitch.

**How to apply:** when a reactive watchdog's timing constants are tuned conservatively for the
general case, and a specific known transition (here: utterance finalize -> next utterance's first
result) collides with exactly the condition the watchdog exists to catch, don't loosen the general
thresholds — add a separate, narrower time window with tighter thresholds that applies only between
"the transition just happened" and "the first sign of life after it," then fall back to the general
thresholds once that first sign of life arrives. This recovers faster exactly where it's needed
without adding false-positive restarts to unrelated quiet periods.
