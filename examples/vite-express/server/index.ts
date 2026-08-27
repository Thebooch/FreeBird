import express from "express";
import { createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";
import { createFreeBirdRouter } from "@freebirdai/server/express";
import { z } from "zod";

const registry = createComponentRegistry();

registry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with month-over-month delta.",
  knowledge: [{ text: "Defaults to a 30 day window." }],
  tags: ["revenue", "finance", "time-series"],
  grid: {
    sizes: [
      { name: "compact", w: 4,  h: 2, aspect: "wide" },
      { name: "half",    w: 6,  h: 3, aspect: "wide" },
      { name: "full",    w: 12, h: 4, aspect: "wide" },
    ],
    preferredSize: "half",
    minSize: "compact",
  },
  propsSchema: z.object({ range: z.enum(["7d", "30d", "90d"]).optional() }),
  dataSource: async () => ({ total: 124_500 }),
});

registry.register({
  id: "activeUsers",
  title: "Active users",
  description: "Daily active users with a 7-day moving average.",
  tags: ["users", "engagement"],
  grid: {
    sizes: [
      { name: "stat",  w: 3, h: 3, aspect: "square" },
      { name: "chart", w: 6, h: 4, aspect: "wide"   },
    ],
    preferredSize: "stat",
    minSize: "stat",
  },
  dataSource: async () => ({ dau: 8_420 }),
});

const app = express();
app.use(express.json());

app.use(
  "/freebird",
  createFreeBirdRouter({
    db: createMemoryDb(),
    llm: createOpenAiAdapter({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      defaultModel: "gpt-4o-mini",
    }),
    registry,
    getAuthContext: () => ({ userId: "demo-user" }),
  }) as unknown as express.RequestHandler,
);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`FreeBird demo API on http://localhost:${port}`);
});
