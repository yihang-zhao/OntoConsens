---
name: Splitting a canvas/shell UI between main agent and design subagent
description: How to keep per-entity color coding consistent when a design subagent owns the shell and the main agent owns a custom canvas component built in parallel.
---

When the design brief explicitly avoids prescribing colors (per the design skill), a design
subagent will invent its own palette independently — including for things like "each user/member
gets a distinct color" that must stay visually consistent across components the main agent builds
separately (e.g. a custom canvas rendered outside the subagent's files).

**Why:** in one session the main agent pre-built a `colorForSlot()` helper with hardcoded hex
values before the design subagent finished; the subagent picked entirely different hues and wired
them through its own CSS custom properties (`--member-0/1/2`) used across the shell (avatars, chips).
The two conflicted until reconciled after the fact.

**How to apply:** after the design subagent finishes, grep its output for how it encoded any
shared per-entity/per-user color system (CSS variables are the common pattern) and make the
main-agent-owned component consume the *same* source (e.g. `hsl(var(--member-N))`) rather than
its own hardcoded palette. If building the shared component first, prefer defining the color
tokens as CSS variables in `index.css` up front and referencing them from both sides, or mention
the exact variable names in the design brief so the subagent reuses them instead of inventing new ones.
