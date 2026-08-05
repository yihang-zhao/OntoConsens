---
name: Gated realtime visibility + merge-by-name
description: How to design "private until X" visibility filters combined with merge-on-duplicate-name semantics, so a user's own actions never appear to silently vanish.
---

When a feature gates visibility of shared items behind a condition (e.g. "you only see your own items until everyone on the team is ready"), and separately merges duplicate items by identity (e.g. two people proposing the same named item become one merged item with combined agreement), the visibility filter must include "items you have a stake in" — not just "items you authored".

**Why:** if user B's proposal merges into user A's existing item (because they share the same name), the underlying row's authorship stays with user A. A visibility filter of `authoredByMe OR conditionMet` then makes B's own action invisible to B until the gating condition is met — it looks exactly like the input was silently dropped, which is worse than not having the merge feature at all. This was caught by an end-to-end multi-tab test, not by typechecking or unit-level review.

**How to apply:** when combining a private/shared visibility gate with merge-by-identity logic, the filter should be `authoredByMe OR haveAgreementOnThisItem OR conditionMet`, i.e. check both authorship and any secondary stake (agreement/participation) records, not just the primary foreign key.
