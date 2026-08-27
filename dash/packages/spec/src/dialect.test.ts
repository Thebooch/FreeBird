import { describe, expect, it } from "vitest";
import { connectionSchema, getOp, resolveOp } from "./connection.js";
import { ARCHETYPES, catalogEntrySchema } from "./dialect.js";

/** Stripe's real conventions, which is the whole point of the abstraction. */
const stripe = connectionSchema.parse({
  id: "stripe",
  title: "Stripe",
  kind: "rest",
  baseUrl: "https://api.stripe.com",
  dialect: {
    auth: { type: "bearer", keyRef: "stripe-key" },
    pagination: {
      kind: "cursor",
      cursorPath: "$.data[last].id",
      param: "starting_after",
      hasMorePath: "$.has_more",
    },
    rowsPath: "$.data",
    timeFilter: { param: "created[gte]", format: "unix" },
    query: { limit: 100 },
    headers: { "stripe-version": "2024-06-20" },
    maxPages: 10,
  },
  ops: [
    { id: "charges", title: "Charges", path: "/v1/charges" },
    { id: "invoices", title: "Invoices", path: "/v1/invoices" },
    { id: "balance", title: "Balance", path: "/v1/balance", archetype: "summary" },
  ],
});

describe("dialect inheritance", () => {
  it("makes a second endpoint cost one line", () => {
    const charges = getOp(stripe, "charges")!;
    const invoices = getOp(stripe, "invoices")!;

    for (const op of [charges, invoices]) {
      expect(op.pagination).toMatchObject({ kind: "cursor", param: "starting_after" });
      expect(op.rowsPath).toBe("$.data");
      expect(op.headers).toEqual({ "stripe-version": "2024-06-20" });
      expect(op.query.limit).toBe(100);
      expect(op.maxPages).toBe(10);
    }
    expect(charges.path).toBe("/v1/charges");
    expect(invoices.path).toBe("/v1/invoices");
  });

  it("injects the range token so nobody hand-writes the date format", () => {
    // The single most valuable thing the dialect does: state the convention
    // once, and every time-filtered endpoint gets it right.
    expect(getOp(stripe, "charges")!.query["created[gte]"]).toBe("{{range.start | unix}}");
  });

  it("adds an end bound only when the API takes one", () => {
    const withEnd = connectionSchema.parse({
      ...stripe,
      dialect: {
        ...stripe.dialect,
        timeFilter: { param: "from", endParam: "to", format: "iso" },
      },
    });
    const op = getOp(withEnd, "charges")!;
    expect(op.query.from).toBe("{{range.start | iso}}");
    expect(op.query.to).toBe("{{range.end | iso}}");
  });

  it("applies archetype behaviour — a summary neither paginates nor needs a rows path", () => {
    const balance = getOp(stripe, "balance")!;
    expect(balance.pagination).toEqual({ kind: "none" });
    expect(balance.rowsPath).toBe("$");
    expect(balance.maxPages).toBe(1);
    // Still time-filtered: a summary over a range is the normal case.
    expect(balance.query["created[gte]"]).toBe("{{range.start | unix}}");
  });

  it("lets a single endpoint override the dialect — real APIs are inconsistent", () => {
    const mixed = connectionSchema.parse({
      ...stripe,
      ops: [
        {
          id: "search",
          title: "Search",
          path: "/v1/search",
          pagination: { kind: "page", param: "page" },
          rowsPath: "$.results",
          maxPages: 2,
          query: { "created[gte]": "fixed" },
        },
      ],
    });
    const op = getOp(mixed, "search")!;
    expect(op.pagination).toMatchObject({ kind: "page" });
    expect(op.rowsPath).toBe("$.results");
    expect(op.maxPages).toBe(2);
    // An explicit value is never clobbered by the injected token.
    expect(op.query["created[gte]"]).toBe("fixed");
  });

  it("can switch the date filter off for one endpoint", () => {
    const mixed = connectionSchema.parse({
      ...stripe,
      ops: [{ id: "plans", title: "Plans", path: "/v1/plans", timeFiltered: false }],
    });
    expect(getOp(mixed, "plans")!.query["created[gte]"]).toBeUndefined();
  });

  it("still works for a connection with no dialect at all", () => {
    const plain = connectionSchema.parse({
      id: "plain",
      title: "Plain",
      kind: "rest",
      baseUrl: "https://api.example.com",
      ops: [{ id: "items", title: "Items", path: "/items" }],
    });
    const op = getOp(plain, "items")!;
    expect(op.pagination).toEqual({ kind: "none" });
    expect(op.query).toEqual({});
    expect(op.maxPages).toBe(5);
  });

  it("resolves deterministically", () => {
    expect(resolveOp(stripe, stripe.ops[0]!)).toEqual(resolveOp(stripe, stripe.ops[0]!));
  });
});

describe("archetypes", () => {
  it("declares the shapes endpoints actually come in", () => {
    expect(Object.keys(ARCHETYPES).sort()).toEqual(["list", "summary", "timeseries"]);
    for (const [id, def] of Object.entries(ARCHETYPES)) {
      expect(def.id, id).toBe(id);
      expect(def.description.length, id).toBeGreaterThan(10);
    }
  });
});

describe("catalog entries", () => {
  it("records how a dialect came to exist and whether it was proven", () => {
    const entry = catalogEntrySchema.parse({
      id: "stripe",
      title: "Stripe",
      baseUrl: "https://api.stripe.com",
      dialect: { rowsPath: "$.data" },
      ops: [{ id: "charges", title: "Charges", path: "/v1/charges" }],
    });
    // A guess must never be mistaken for a fact.
    expect(entry.origin).toBe("manual");
    expect(entry.verified).toBe(false);
    expect(entry.ops[0]?.archetype).toBe("list");
  });

  it("rejects an id that would not be a safe filename", () => {
    const bad = catalogEntrySchema.safeParse({
      id: "../etc/passwd",
      title: "X",
      baseUrl: "https://x.com",
      dialect: {},
    });
    expect(bad.success).toBe(false);
  });
});
