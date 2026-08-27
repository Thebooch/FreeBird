---
title: "@freebirdai/react"
---

# @freebirdai/react

Headless, unstyled React primitives. Every element gets stable
`data-freebird-*` attributes for styling and is ARIA-correct.

### Primitives

- `<FreeBirdProvider registry transport?>` — context provider.
- `<ChatPanel.Root>` → `.Messages`, `.Form`, `.Input`, `.Submit`, `.Message`.
- `<DynamicGrid>` — 12-column grid driven by the active `LayoutPlan`.
- `<LockToggle instanceId>` — per-cell lock button.
- `<InfoTrigger componentId>` — the "i" button.
- `<CustomTabBar.Root>` → `.List`, `.Item`, `.Save`.
- `<FreeBirdNavLinks>` — render-prop for mapping saved tabs into your nav.

### Hooks

- `useChat()`, `useLayout()`, `useCustomTabs()`, `useSession()`.

All primitives support Radix-style `asChild` composition: pass your own
element and the primitive forwards its behavior onto it.
