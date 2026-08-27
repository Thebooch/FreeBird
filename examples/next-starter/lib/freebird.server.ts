import { createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";
import { z } from "zod";

export const registry = createComponentRegistry();

registry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with month-over-month delta.",
  knowledge: [
    { text: "Defaults to a 30 day window, adjustable via props.range." },
    { text: "Click a bar to drill into that day." },
  ],
  tags: ["revenue", "finance", "time-series"],
  // Three explicit sizes: solo → full-width banner; alongside 1–2 others → half-width;
  // crowded dashboard → compact sparkline. Never go below "compact".
  grid: {
    sizes: [
      { name: "compact",  w: 4,  h: 2, aspect: "wide" },
      { name: "half",     w: 6,  h: 3, aspect: "wide" },
      { name: "full",     w: 12, h: 4, aspect: "wide" },
    ],
    preferredSize: "half",
    minSize: "compact",
  },
  propsSchema: z.object({ range: z.enum(["7d", "30d", "90d"]).optional() }),
  dataSource: async () => ({ total: 124_500, delta: 0.08 }),
});

registry.register({
  id: "activeUsers",
  title: "Active users",
  description: "Daily active users with a 7-day moving average.",
  knowledge: [{ text: "Counts unique users with at least one API call today." }],
  tags: ["users", "engagement", "time-series"],
  // Square stat card: expands to a wider chart when it's the only widget shown.
  grid: {
    sizes: [
      { name: "stat",  w: 3, h: 3, aspect: "square" },
      { name: "chart", w: 6, h: 4, aspect: "wide"   },
    ],
    preferredSize: "stat",
    minSize: "stat",
  },
  dataSource: async () => ({ dau: 8_420, waMa: 7_980 }),
});

registry.register({
  id: "topProducts",
  title: "Top products",
  description: "Highest-grossing SKUs in the current period.",
  knowledge: [{ text: "Sorted by gross revenue, descending." }],
  tags: ["revenue", "products"],
  // Tall list: can compress to a condensed 3-row summary if the layout is packed.
  grid: {
    sizes: [
      { name: "condensed", w: 4, h: 3, aspect: "tall" },
      { name: "normal",    w: 6, h: 5, aspect: "tall" },
      { name: "wide",      w: 8, h: 5, aspect: "wide" },
    ],
    preferredSize: "normal",
    minSize: "condensed",
  },
  dataSource: async () => [
    { sku: "A-100", revenue: 42_100 },
    { sku: "B-221", revenue: 28_730 },
  ],
});

export const db = createMemoryDb();

export const llm = createOpenAiAdapter({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  defaultModel: "gpt-4o-mini",
});
