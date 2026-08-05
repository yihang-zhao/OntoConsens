---
name: CSS transform translate+rotate pivot trap
description: Combining translate() and rotate() in one CSS transform with a custom transform-origin does not pivot around the translated point -- causes radial/petal layouts to fling away from their anchor.
---

When positioning an element radially around a center point (e.g. petals around a circle), it's tempting to use transform-origin plus a single `transform: rotate(angle) translate(dx, dy)` to both offset and rotate in one step.

This does NOT work as expected: transform-origin applies to the whole composed matrix, not sequentially per function. The browser translates the coordinate system so the origin point is at (0,0), applies the ENTIRE transform list as one matrix, then translates back. It does not "apply translate, then re-anchor, then rotate around the new position" -- rotation ends up pivoting around the origin's pre-transform location, not the post-translate location. The visual symptom: elements appear correctly sized/shaped but detached/flung away from where they should be anchored, worse at larger angles and larger offsets.

**Why:** Learned by direct derivation after a real bug -- a "petals around a circle" UI (OntoConsensus ontology graph) rendered with top:50%; left:50%; transform-origin:50% 100%; transform: rotate(angle) translate(-50%,-100%) looked plausible in isolated reasoning but produced widely scattered, disconnected rectangles in the actual browser once angle != 0.

**How to apply:** For any "place element at distance D and angle theta from a center point, then orient it to face outward" layout, do NOT combine translate+rotate with a custom transform-origin. Instead: (1) compute the element's target center via trig (x = originX + sin(theta)*D, y = originY - cos(theta)*D) in plain px for left/top, sized so the element's own center lands there, then (2) apply only transform: rotate(theta) (default center origin) to orient it. For nested content that must stay upright inside a rotated parent, use two separate elements -- one for pure centering (translateX only), one for pure counter-rotation (rotate only) -- never combine translate+rotate on the same element with a non-default origin.
