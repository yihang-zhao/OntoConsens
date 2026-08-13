---
name: Live-caption-to-permanent-message swap flicker
description: Why a "live typing" bubble that gets replaced by a persisted/final version of the same content can flash, resize, or disappear-then-reappear, and how to avoid it.
---

When a UI shows an in-progress/live version of content (e.g. a live speech-to-text caption bubble) that later gets replaced by a persisted, final version of the *same* content (e.g. a saved chat message), there are several independent ways this transition can visibly flash even though the text itself never changes. All of them showed up as some form of "shining"/"jumping" in one debugging session and had to be fixed one at a time:

1. **A placeholder/loading state rendered for one frame.** If the reveal logic ever routes the new permanent item through even a `setTimeout(fn, 0)` before marking it visible, React will paint the in-between frame where the live version is gone and the permanent one isn't shown yet (or a generic "typing"/loading placeholder is shown instead). Fix: reveal already-live content synchronously in the same render/state update, no timer at all. Reserve timers for content that's genuinely new (never seen live before).

2. **Two racing round trips clearing/creating state independently.** If "clear the live version" and "create the permanent version" are two separate network calls (e.g. one over a WebSocket, one over HTTP), whichever arrives first creates a visible gap or duplicate — there's no way to guarantee they land atomically. Fix: don't proactively clear the live version at all. Let a single downstream effect (watching for the permanent version to actually appear) be the *only* place that clears the live one, so the swap is atomic by construction.

3. **Structural/layout mismatch between the live and final markup.** If the live bubble uses different container classes than the final one (e.g. `w-fit` + flex-row for a cursor vs. a plain full-width block), the swap causes a visible resize/reflow even when the text is identical. Fix: make the live version's container markup byte-for-byte identical to the final version's, with the "live-only" visual cue (e.g. a blinking cursor) added as a non-layout-affecting inline element, not a flex sibling.

4. **A TTL-based prune racing the same round trip.** If the live version is also pruned by a "no update in N ms" timeout (to clean up genuinely abandoned sessions), that TTL must be well above the time between "live updates stop" and "permanent version arrives" — not just above the silence/inactivity threshold that *triggers* finalization. If the TTL is only slightly larger than the trigger threshold, a normal-latency round trip can still lose the race, pruning the live version before the permanent one shows up.

**Why:** each of these is invisible in isolation during code review — the bug only appears at runtime, under real timing, and only intermittently. A fix for one cause looks like it "didn't work" when a different cause is still active, so all four need to be checked when this class of flicker is reported.

**How to apply:** whenever a live/in-progress representation of content is meant to be seamlessly replaced by a persisted/final one, audit for all four causes together, not just the first plausible one found.
