---
title: Component registry
---

# Component registry

Every FreeBird-driven surface starts with a `ComponentRegistry`. You register
each renderable unit with a stable `id`, a title/description that the LLM
sees, optional `knowledge[]` items the info-button uses, tags that power
cross-chat references, grid constraints, a Zod `propsSchema`, and (server
side) a `dataSource()` used by digests and (client side) a `render()`.

```ts
registry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with MoM delta.",
  knowledge: ["Defaults to 30 days."],
  tags: ["revenue", "finance", "time-series"],
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" },
  propsSchema: z.object({ range: z.enum(["7d", "30d", "90d"]).optional() }),
  dataSource: async (ctx) => fetchRevenue(ctx),
  render: (props) => <RevenueChart {...props} />,
});
```

The same registry shape is used on both sides of the wire. In Next.js you
can keep one server-side file for `dataSource`s and a client file that
re-registers the same ids with `render`s (the metadata is identical, the
code paths differ).

### Why split the sides?

The server registry needs zero React — it feeds the LLM and powers digest
data-fetching. Your client registry is the one with JSX. The solver and
chat tool schemas only read metadata fields, so either registry can drive
them.
