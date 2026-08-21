---
name: Missing effect dependency permanently stalls a multi-step reveal/animation chain
description: A gating boolean flipped by one effect but omitted from another effect's dependency array can deadlock a "reveal one item at a time" state machine.
---

## The bug shape

Two `useEffect`s cooperate: effect A sets a gating flag (e.g. `historyReady`) once data arrives; effect B reads that flag as an early-return guard but its dependency array only lists other values (e.g. `[messages, revealedIds]`), not the flag itself.

If, on the render where the flag-setting data first arrives, the values in B's dependency array *also* change in the same commit, B fires — but using that render's *stale* closure of the flag (React applies `setState` calls from effects in a later render, not synchronously within the same commit). B sees the flag still false and bails out. On the next render the flag is finally true, but since B's actual dependencies (`messages`, `revealedIds`) didn't change again, B never re-runs. The chain is permanently stuck until something unrelated changes one of B's real dependencies (e.g. a new live message arrives over a websocket).

A "fix" that writes a one-time "seen it already" flag to localStorage regardless of whether the reveal actually succeeded will make the bug look like it only affects the *first* attempt — a reload afterwards takes the instant-bulk-reveal path instead of ever re-attempting the animated one, masking the real defect.

**Why:** effects fire using the closure/state of the render that triggered them, not the state resulting from other effects that ran earlier in the same commit. A boolean gate read inside an effect must also be in that effect's dependency array, or the effect can miss the one render where the gate and the data become ready together.

**How to apply:** when a multi-effect state machine has one effect gate on a flag set by another effect, always include that flag in the gated effect's dependency array — don't rely on the flag changing to happen to coincide with another real dependency changing. When debugging "works after reload but not live" symptoms, add temporary logging of every effect's inputs (including read-only guard variables) rather than re-reading the code by eye; a live console capture across the exact failure window is what actually surfaces this class of bug.
