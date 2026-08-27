import type { ResolvedParams, WidgetSpec } from "@freebirdai/dash-spec";
import { parseWidget, resolveRange } from "@freebirdai/dash-spec";

/** 2026-08-0N at 00:00 UTC. */
export const day = (n: number): number => Date.UTC(2026, 7, n);
const HOUR = 3_600_000;

/**
 * A payment-processor list response, in the shape these APIs really use:
 * a wrapper object, Unix seconds, and amounts in minor units. Cents values
 * are chosen to divide exactly by 100 so the golden numbers stay exact.
 */
export const chargesPayload = {
  object: "list",
  has_more: false,
  data: [
    {
      id: "ch_1",
      status: "succeeded",
      created: (day(1) + 3 * HOUR) / 1000,
      amount: 4200,
      fee: 150,
      currency: "usd",
      customer: { id: "cus_a", email: "a@example.com" },
    },
    {
      id: "ch_2",
      status: "succeeded",
      created: (day(1) + 20 * HOUR) / 1000,
      amount: 1800,
      fee: 50,
      currency: "usd",
      customer: { id: "cus_b", email: "b@example.com" },
    },
    {
      id: "ch_3",
      status: "failed",
      created: (day(2) + 5 * HOUR) / 1000,
      amount: 9900,
      fee: 300,
      currency: "usd",
      customer: { id: "cus_a", email: "a@example.com" },
    },
    {
      id: "ch_4",
      status: "succeeded",
      created: (day(4) + 1 * HOUR) / 1000,
      amount: 2500,
      fee: 100,
      currency: "usd",
      customer: { id: "cus_c", email: "c@example.com" },
    },
    {
      id: "ch_5",
      status: "succeeded",
      created: (day(4) + 9 * HOUR) / 1000,
      amount: 500,
      fee: 0,
      currency: "usd",
      customer: { id: "cus_a", email: "a@example.com" },
    },
  ],
};

export const revenueWidget: WidgetSpec = parseWidget({
  id: "revenue_trend",
  title: "Revenue",
  component: "timeseries",
  source: { connection: "payments", op: "charges" },
  pipeline: [
    { op: "extract", path: "$.data[*]" },
    {
      op: "coerce",
      fields: {
        created: "unix_s->datetime",
        amount: "money:cents->major",
        fee: "money:cents->major",
      },
    },
    { op: "filter", where: "status == 'succeeded'" },
    { op: "derive", fields: { net: "amount - fee" } },
    {
      op: "group",
      by: [{ field: "created", bucket: "{{range.grain}}" }],
      agg: { revenue: "sum(net)", orders: "count()" },
    },
    { op: "sort", by: [{ field: "created", dir: "asc" }] },
  ],
  roles: { time: "created", value: "revenue" },
  format: { revenue: { semantic: "currency", currency: "USD" } },
}).value!;

export const params = (grain: "1h" | "1d" | "1w" | "1mo" = "1d"): ResolvedParams => ({
  range: resolveRange({ preset: "30d", now: day(6), grain }),
  filters: {},
});

export const ctx = (grain: "1h" | "1d" | "1w" | "1mo" = "1d") => ({
  now: day(6),
  params: params(grain),
});
