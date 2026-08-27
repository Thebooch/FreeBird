---
title: Layout solver
---

# Layout solver

The solver is a pure function that turns LLM intent into concrete grid
placements.

**Two passes, by design.**

1. **Intent (LLM).** The `plan_layout` tool asks the model to tag each
   chosen component with an `importance: 1..5` and
   `orientationHint: "wide" | "tall" | "square"`. The model doesn't pick
   grid coordinates — humans and models are both bad at that.
2. **Packer (deterministic).** A greedy bin-packer on a 12-column grid
   takes those hints, each component's declared `grid` bounds, and the
   current set of locked cells, and emits the final `LayoutPlan`.

```ts
import { solveLayout } from "@freebirdai/core";

const plan = solveLayout({
  registry,
  intent: [{ componentId: "revenueChart", importance: 5, orientationHint: "wide" }],
  lockedCells: currentPlan.cells.filter((c) => c.locked),
});
```

This keeps the model focused on the part it's good at (what and how
important), and the framework focused on the part it's good at (pixel-level
determinism and respecting locks).
