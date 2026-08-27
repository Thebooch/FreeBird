"use client";
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
      <div className="mt-1 text-sm text-emerald-400">+8.0% MoM</div>
    </div>
  ),
});

clientRegistry.register({
  id: "activeUsers",
  title: "Active users",
  description: "Daily active users with a 7-day moving average.",
  tags: ["users", "engagement", "time-series"],
  grid: { minW: 3, minH: 3, maxW: 6, defaultAspect: "square" },
  render: () => (
    <div className="p-6">
      <div className="text-sm opacity-70">DAU</div>
      <div className="mt-2 text-3xl font-semibold">8,420</div>
      <div className="mt-1 text-xs opacity-70">7d avg 7,980</div>
    </div>
  ),
});

clientRegistry.register({
  id: "topProducts",
  title: "Top products",
  description: "Highest-grossing SKUs in the current period.",
  tags: ["revenue", "products"],
  grid: { minW: 4, minH: 4, maxW: 8, defaultAspect: "tall" },
  render: () => (
    <div className="p-6">
      <div className="text-sm opacity-70">Top products</div>
      <ul className="mt-3 space-y-2">
        <li className="flex justify-between">
          <span>A-100</span>
          <span className="tabular-nums">$42,100</span>
        </li>
        <li className="flex justify-between">
          <span>B-221</span>
          <span className="tabular-nums">$28,730</span>
        </li>
      </ul>
    </div>
  ),
});
