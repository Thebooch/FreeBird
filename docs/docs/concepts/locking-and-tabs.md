---
title: Locking & custom tabs
---

# Locking & custom tabs

### Per-component locks

Every cell in a `LayoutPlan` carries a boolean `locked` flag.
`<LockToggle instanceId={cell.instanceId}/>` (headless) or the Tailwind
preset's `LockToggle` (pre-iconed) toggles it. Set
`<DynamicGrid showLocks={false}/>` to hide the lock chrome for a clean
static-tab look.

Locked cells are treated as immovable obstacles by the solver — they always
survive the next chat turn.

### Saving a custom tab

A **custom tab** is a `LayoutPlan` whose cells are all locked, saved under a
user-facing title. `useCustomTabs()` exposes `save`, `list`, `update`,
`remove`, and `load`.

```ts
const { tabs, save } = useCustomTabs();
await save({ title: "Q3 review" });
```

### Wiring tabs into your navbar

FreeBird gives you the data; you keep your navbar. Use the built-in
`<FreeBirdNavLinks/>` helper to map saved tabs to links inside any
existing component:

```tsx
<MyNavbar>
  <FreeBirdNavLinks>
    {({ tab, onClick }) => <a key={tab.id} href={`#${tab.slug}`} onClick={onClick}>{tab.title}</a>}
  </FreeBirdNavLinks>
</MyNavbar>
```
