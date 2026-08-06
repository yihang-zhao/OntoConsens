---
name: React state driving only one CSS transform still forces full re-renders
description: Perf trap where high-frequency input (drag/wheel) updates React state that's read in exactly one place, but every raw event still re-renders the whole component tree.
---

Pan/zoom/drag-style interactions often store the live transform (x/y/zoom) in
`useState` and call the setter on every `pointermove`/`wheel` event. If that
state value is actually read in only one place in the render — e.g. a single
inline `style={{ transform: ... }}` on one wrapper `<div>` — then every other
part of the tree re-renders for no reason on every raw input event, which is
the actual source of perceived lag, not the CSS itself.

**Why:** re-render cost (recomputing layout for every child, trig-based
positions, etc.) scales with tree size and fires once per raw event, while
the screen can only repaint ~60-120 times/sec. Flooding renders faster than
paint wastes work and delays the visual update that matters.

**How to apply:**
1. Before assuming "React re-render is unavoidable for this interaction",
   grep every read of the hot state variable. If it's used in exactly one
   place, that's a strong signal the interaction can be decoupled from React.
2. Fix pattern: keep a `ref` to the DOM node that needs the live value, write
   `node.style.transform` (or similar) directly and synchronously in the
   event handler — this is the visual update, and it happens with zero
   render latency.
3. Still keep a `useState` for anything downstream that legitimately needs to
   react (e.g. an "is interacting" flag), but commit it at most once per
   `requestAnimationFrame` via a pending-flag + rAF callback, not once per
   raw event.
4. Apply the same rAF-coalescing pattern to any other high-frequency event
   emission tied to the same gesture (e.g. broadcasting cursor position over
   a websocket on `mousemove`) — unthrottled sends compound the same problem
   across every remote listener's re-render, not just the local one.
