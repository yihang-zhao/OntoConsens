---
name: Speech recognizer deterministically drops opening words after finalize
description: Two distinct causes chase the same symptom ("first few words of a new utterance/message box aren't recognized") -- a rare flaky stuck-recognizer bug, and a near-certain results-array offset bug. Check both, but the offset bug is the dominant one when the symptom is consistent/every-time.
---

Context: builds on `browser-speech-recognition-transcript.md` (the general Web Speech API
continuous-session approach) and the stuck-recognizer watchdog it documents.

**Symptom variance is the key diagnostic signal.** If the missed-first-words complaint is
occasional/flaky, suspect the general stuck-recognizer watchdog being too slow (see the
"post-finalize watchdog window" fix: narrower, tighter thresholds just after finalize, before
falling back to general thresholds once the new utterance's first result arrives). If the complaint
is **consistent -- every single time a pause creates a new utterance/message box, but never when
speech is folded into the same box** -- that points to a different, deterministic bug: the
results-array offset advance itself, not recognizer flakiness.

**The deterministic bug:** when an offset-into-`results[]` scheme is used to mark "everything before
this index belongs to the utterance already finalized" (so the recognizer never has to stop/restart
across an utterance boundary), advancing that offset to `results.length` as of the moment a JS
wall-clock silence timer fires is wrong. The browser's OWN endpointing (which decides `isFinal` for
each results entry) runs on its own independent schedule that is usually a bit slower than a
same-ballpark JS timer (e.g. our 1000ms silence threshold) -- so the last results entry is very
often STILL interim right when the JS timer fires, and the browser goes on to keep growing that
SAME entry (not start a new one) with whatever the user says next. Skipping past a still-interim
entry makes all of that growth invisible from then on -- guaranteed, not occasional.

**Fix:** only ever advance the offset past entries the browser has already marked `results[i].isFinal
=== true`. If the boundary entry is still interim, stay at that index and snapshot its current text;
strip that snapshot back off future reads of the same index (only the growth beyond the snapshot
belongs to the new utterance) until the browser either finalizes that entry or starts a genuinely new
one. Never assume "the array's current length" is a safe skip boundary for an API whose finalization
timing you don't control.

**How to apply:** any time code correlates its own timer-driven state machine with an external API's
own asynchronous, independently-timed segmentation/finalization (results arrays, buffered chunks,
etc.), don't snapshot a boundary using "whatever the array looks like right now" -- check the
element's own completion/finality flag first, or the same bug (invisible growth on the wrong side of
a wrongly-drawn line) recurs deterministically.
