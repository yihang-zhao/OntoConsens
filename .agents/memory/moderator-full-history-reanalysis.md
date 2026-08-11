---
name: Moderator re-analyzes full property history, not just new transcript
description: Design for AI-moderator "stalled discussion" interventions that must reflect everything ever said about a class/property, not just the most recent silence-triggered chunk.
---

When an AI moderator posts a stalled-discussion analysis (examples/counterexamples/who-said-what)
for a specific class/property, it must be built from the ENTIRE transcript ever tied to that
property -- not just the chunks accumulated since the last checkpoint. An example given several
rounds ago and never repeated should still show up every time the property comes up again.

**Why:** the moderator's silence-triggered checkpoint (`lastSummarizedAt`) exists to avoid
re-sending already-processed chunks to the topic-detection pass, but that's a different concern
from "what's the complete state of the discussion on this property" -- conflating the two
silently drops old evidence the moment enough silence-cycles pass.

**How to apply:** two-pass flow per intervention. Pass 1 (topic detection) runs ONLY on the new
window since the last checkpoint -- cheap, and "what's being discussed right now" is inherently
about recent speech. Pass 2 (full extraction) runs ONLY if pass 1 resolves to a real class+property:
first retroactively tag the new window's transcript chunks with that class/property id (only chunks
not already tagged -- never overwrite an existing tag), then re-query ALL chunks ever tagged with
that same class+property and re-run the extraction over that complete set. This requires the
transcript-chunks table to carry nullable `classId`/`propertyId` columns for the tagging step.
