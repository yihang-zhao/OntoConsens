---
name: Fixed radial slot count must match visible-item count exactly
description: Reserving a wedge for a control that isn't actually rendered leaves a visible gap in a fixed-angle radial/wheel layout
---

In a fixed-wedge radial layout (petals/nodes arranged in a circle at
`360 / slotCount` degree increments), the slot count must equal exactly the
number of elements that will actually render this frame — not a count that
assumes an extra always-present "add" affordance.

**Why:** A property wheel reserved `items.length + 1` wedges to leave room
for an always-visible "add" button, so existing items never rotated when a
new one was added. But once a cap hid the add button entirely (item count at
max), the `+1` was still applied, spreading N real items across N+1 wedges —
producing a visible empty gap exactly where the invisible reserved slot was,
even though nothing was there to fill it.

**How to apply:** When a radial layout reserves a slot for a conditionally-
rendered control, gate the reservation on the same condition that controls
the control's visibility (e.g. `count + (isVisible ? 1 : 0)`), not on a
constant. Verify visually (screenshot) whenever an item count can reach a
cap/limit boundary.
