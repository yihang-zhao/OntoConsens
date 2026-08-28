---
name: Moderator intervention as one combined OpenAI call
description: How generateIntervention identifies the topic AND extracts examples/counterexamples in a single model call, for every case (continuation, switch, first-ever).
---

`generateIntervention` issues exactly ONE OpenAI call per attempt, never two, regardless of whether
the topic is a continuation of the last posted intervention, a genuine switch to a different
catalog property, or the project's first-ever intervention.

**Why:** Earlier versions ran a topic-only call and, separately, an extraction call once the
property was known -- and only bothered combining them for the (most common) continuation case,
leaving switch/first-time cases doing two round trips. The fix that makes ONE call work for every
case is pre-fetching the most recent matched intervention for **every** catalog property (one extra
DB query, done in parallel with the other reads) and rendering all of them as an "EXISTING STATE"
block in the prompt, keyed by property. The model then both picks the topic and extracts against
whichever property's block it lands on, all in the same response.

**How to apply:** If you need to change what data extraction is based on (e.g. widen or narrow the
"messages since" window), remember the source is always `sinceLastInterventionTranscript` --
messages since the **project-wide** last posted intervention, not since that specific property's own
last intervention -- because a property's own last intervention is always ≤ the project's last one,
so this window is always a safe superset for whichever topic is currently active. If you add a new
per-property baseline concept, extend `pointsByProperty`/`priorStateText`, not a separate call.
