---
name: Retain/remove gauge needle orientation
description: How to reconcile "rightmost=100% retain" scale with "agree segments left of needle" requirement in a gauge visualization
---

When a spec says a gauge's scale runs 0% (left) to 100% (right) for some
outcome, AND separately says "agreeing segments go left of the needle,
disagreeing go right" -- these are not contradictory. Read the needle's
position itself as the 0-100% value: it sits at `(agreeCount / total) * 180deg`
along the arc, so the width of the agree region *is* the percentage. All
agree segments packed to the left of the needle, all disagree/unknown
packed to the right, needle boundary = the percentage marker.

**Why:** First reading suggested "agree=right side (100%)" which conflicts
with "agree segments are left of needle" -- the resolution is that the
needle moves, not the segment ordering.

**How to apply:** For any gauge/dial UI with a binary categorical split
(agree/disagree, retain/remove, pass/fail) rendered as proportional
segments plus a needle: segment order is fixed by category (all of group A,
then all of group B), and the needle position — not segment placement — is
what encodes the percentage.
