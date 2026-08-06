---
name: Radix composeEventHandlers preventDefault trap
description: A trigger's own onClick calling e.preventDefault() silently blocks Radix from opening the associated Dialog/AlertDialog/Popover/etc.
---

Radix trigger primitives (Dialog/AlertDialog/Popover/DropdownMenu/...) wire their internal open-toggle handler via `composeEventHandlers(props.onClick, context.onOpenToggle)`. By default `composeEventHandlers` has `checkForDefaultPrevented: true`, so if the consumer's own `onClick` on the trigger element calls `e.preventDefault()`, Radix skips calling its own open handler — the element renders and receives the click, but the dialog/menu/popover never opens, with no error anywhere.

**Why:** This is easy to introduce defensively (e.g. "prevent this button from also triggering a wrapping `<Link>`'s navigation") even when the trigger isn't actually nested inside the link — the guard is copied out of habit and then silently neutralizes the trigger.

**How to apply:** Before adding `e.preventDefault()` to any Radix `*Trigger asChild` button's onClick, check whether the trigger is genuinely a descendant of the link/anchor it's guarding against. If not, remove it — it's not needed and it breaks the trigger. If it is genuinely nested, prefer `e.stopPropagation()` instead, which blocks bubbling without setting `defaultPrevented`.
