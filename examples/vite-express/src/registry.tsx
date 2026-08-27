import { createComponentRegistry } from "@freebirdai/core";
import type { ReactNode } from "react";

export const clientRegistry = createComponentRegistry<ReactNode>();

clientRegistry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with month-over-month delta.",
  tags: ["revenue", "finance", "time-series"],
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" },
  render: () => (
    <div className="p-6">
      <div className="text-sm opacity-70">Revenue (demo)</div>
      <div className="mt-2 text-4xl font-semibold">$124,500</div>
    </div>
  ),
});

clientRegistry.register({
  id: "activeUsers",
  title: "Active users",
  description: "Daily active users with a 7-day moving average.",
  tags: ["users", "engagement"],
  grid: { minW: 3, minH: 3, maxW: 6, defaultAspect: "square" },
  render: () => (
    <div className="p-6">
      <div className="text-sm opacity-70">DAU</div>
      <div className="mt-2 text-3xl font-semibold">8,420</div>
    </div>
  ),
});
