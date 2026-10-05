import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isChangedNote, isIncompleteNote } from "@freebirdai/connect/adapters";
import { connectionSchema, dashboardSchema, getOp, type DashboardSpec } from "@freebirdai/dash-spec";
import { afterEach, describe, expect, it } from "vitest";
import { openDashDb } from "@freebirdai/connect/platform/db";
import { driftBetween, driftNote, likelyRenames, shapeOf } from "@freebirdai/connect/drift/detect";
import { DbShapeStore, MemoryShapeStore } from "@freebirdai/connect/drift/store";
import { DriftWatch, savedReads } from "./watch.js";

/* An endpoint whose answers change shape after it was accepted. */

const NOW = Date.UTC(2026, 8, 30);
const invoices = (count: number, extra: (index: number) => Record<string, unknown> = () => ({})) => ({
  data: Array.from({ length: count }, (_, index) => ({
    id: `in_${index}`,
    amount: 100 + index,
    status: index % 2 === 0 ? "paid" : "open",
    customer: { id: `cu_${index}`, name: `Customer ${index}` },
    ...(index % 3 === 0 ? { memo: "note" } : {}),
    ...extra(index),
  })),
});

describe("what counts as a change of shape", () => {
  const accepted = shapeOf(invoices(12), "$.data", NOW);

  it("keeps names and kinds only, and which fields every record held", () => {
    expect(accepted.rows).toBe(12);
    expect(accepted.fields.find((one) => one.name === "amount")).toEqual({ name: "amount", kinds: ["number"], always: true });
    expect(accepted.fields.find((one) => one.name === "memo")).toMatchObject({ always: false });
    expect(accepted.fields.find((one) => one.name === "customer.name")).toMatchObject({ kinds: ["string"], always: true });
    expect(JSON.stringify(accepted)).not.toContain("Customer 3");
  });

  it("is not an optional field missing from a page, a new field, or an empty account", () => {
    const withoutMemo = { data: invoices(9).data.map(({ memo: _memo, ...rest }) => rest) };
    expect(driftBetween(accepted, withoutMemo, "$.data", NOW)).toBeNull();
    expect(driftBetween(accepted, invoices(9, () => ({ region: "emea" })), "$.data", NOW)).toBeNull();
    expect(driftBetween(accepted, { data: [] }, "$.data", NOW)).toBeNull();
    /* One record says too little about fields every record held. */
    expect(driftBetween(accepted, { data: [{ id: "in_1" }] }, "$.data", NOW)).toBeNull();
  });

  it("is a field every record held that none holds now, with what it may have become", () => {
    const renamed = { data: invoices(9).data.map(({ amount, ...rest }) => ({ ...rest, amount_cents: amount * 100 })) };
    const drift = driftBetween(accepted, renamed, "$.data", NOW)!;
    expect(drift.gone).toEqual(["amount"]);
    expect(drift.appeared).toEqual([{ name: "amount_cents", kinds: ["number"] }]);
    expect(likelyRenames(accepted, drift)).toEqual([{ from: "amount", to: "amount_cents" }]);
    expect(driftNote("List invoices", accepted, drift)).toBe(
      "List invoices has changed since it was checked: its records no longer hold “amount” (“amount_cents” is new, and may be what “amount” became). What is shown may be wrong until it is rebuilt.",
    );
    /* A note about what a number means, not about missing records. */
    expect(isChangedNote(driftNote("List invoices", accepted, drift))).toBe(true);
    expect(isIncompleteNote(driftNote("List invoices", accepted, drift))).toBe(false);
    /* A record that went missing takes its own fields with it, said once. */
    const flattened = { data: invoices(9).data.map(({ customer: _customer, ...rest }) => rest) };
    expect(driftBetween(accepted, flattened, "$.data", NOW)!.gone).toEqual(["customer"]);
  });

  it("is a field that holds another kind of thing", () => {
    const drift = driftBetween(accepted, { data: invoices(9).data.map((one) => ({ ...one, amount: String(one.amount) })) }, "$.data", NOW)!;
    expect(drift.retyped).toEqual([{ name: "amount", was: ["number"], now: ["string"] }]);
    expect(driftNote("List invoices", accepted, drift)).toMatch(/“amount” now holds text where it held a number/);
  });

  it("is records that are no longer where the endpoint reads them", () => {
    const drift = driftBetween(accepted, { result: { invoices: invoices(9).data } }, "$.data", NOW)!;
    expect(drift.moved).toBe("$.result.invoices");
  });
});

const connection = connectionSchema.parse({
  id: "billing",
  title: "Billing",
  kind: "rest",
  baseUrl: "https://api.billing.example",
  ops: [{ id: "invoices", title: "List invoices", path: "/invoices", rowsPath: "$.data" }],
});
const op = getOp(connection, "invoices")!;

const board = (field: string): DashboardSpec =>
  dashboardSchema.parse({
    id: "main",
    title: "Main",
    widgets: [
      {
        id: "total",
        title: "Total",
        component: "stat",
        source: { connection: "billing", op: "invoices" },
        pipeline: [
          { op: "extract", path: "$.data[*]" },
          { op: "derive", fields: { _all: "1" } },
          { op: "group", by: [{ field: "_all" }], agg: { value: `sum(${field})` } },
        ],
        roles: { value: "value" },
      },
    ],
  });

describe("holding fresh answers against the accepted shape", () => {
  const watchOf = (dashboards: readonly DashboardSpec[]) => {
    const rechecked: string[] = [];
    const watch = new DriftWatch({
      shapes: new MemoryShapeStore(),
      now: () => NOW,
      dashboards: () => dashboards,
      recheck: (one, ops) => rechecked.push(`${one.id}/${ops.join(",")}`),
    });
    return { watch, rechecked };
  };
  const renamed = { data: invoices(9).data.map(({ amount, ...rest }) => ({ ...rest, amount_cents: amount * 100 })) };

  it("says what changed on the tiles that read it, checks that endpoint again once, and stops when the shape is back", async () => {
    const { watch, rechecked } = watchOf([board("amount")]);
    await watch.accept(connection, op, invoices(12));
    expect(await watch.noteFor(connection, "invoices")).toBeNull();
    await watch.observe(connection, op, renamed);
    await watch.observe(connection, op, renamed);
    expect(await watch.noteFor(connection, "invoices")).toMatch(/no longer hold “amount”/);
    expect(rechecked).toEqual(["billing/invoices"]);
    expect(await watch.open(connection)).toEqual([expect.objectContaining({ op: "invoices", title: "List invoices", since: new Date(NOW).toISOString() })]);
    await watch.observe(connection, op, invoices(8));
    expect(await watch.noteFor(connection, "invoices")).toBeNull();
    expect(await watch.open(connection)).toEqual([]);
  });

  it("takes a change nothing saved reads as the new shape, with no warning", async () => {
    const { watch, rechecked } = watchOf([board("status")]);
    await watch.accept(connection, op, invoices(12));
    await watch.observe(connection, op, renamed);
    expect(await watch.noteFor(connection, "invoices")).toBeNull();
    expect(rechecked).toEqual([]);
    /* And holds later answers against that. */
    await watch.observe(connection, op, renamed);
    expect(await watch.noteFor(connection, "invoices")).toBeNull();
  });

  it("keeps the first fresh answer as the shape where no check kept one", async () => {
    const { watch } = watchOf([board("amount")]);
    await watch.observe(connection, op, invoices(12));
    await watch.observe(connection, op, renamed);
    expect(await watch.noteFor(connection, "invoices")).toMatch(/amount/);
  });

  it("reads a saved widget's paths and expressions, never its keys", () => {
    expect(savedReads([board("amount")], "billing", "invoices", ["amount"])).toBe(true);
    /* `amount_cents` is not `amount`; `value` is a key and a role, not a field of these records. */
    expect(savedReads([board("amount_cents")], "billing", "invoices", ["amount"])).toBe(false);
    expect(savedReads([board("amount")], "billing", "invoices", ["op", "id"])).toBe(false);
    expect(savedReads([board("amount")], "billing", "refunds", ["amount"])).toBe(false);
  });
});

describe("the shape store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a shape and an open change in Dash's database, and forgets them with the connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-shapes-"));
    dirs.push(dir);
    const db = await openDashDb({ dataDir: dir });
    try {
      const store = new DbShapeStore(db);
      const accepted = shapeOf(invoices(12), "$.data", NOW);
      await store.accept("billing", "invoices", accepted);
      expect(await store.accepted("billing", "invoices")).toEqual(accepted);
      const drift = { gone: ["amount"], retyped: [], appeared: [] };
      await store.report("billing", "invoices", drift, new Date(NOW).toISOString());
      await store.report("billing", "invoices", drift, new Date(NOW + 60_000).toISOString());
      expect(await store.open("billing")).toEqual([{ op: "invoices", since: new Date(NOW).toISOString(), drift, accepted }]);
      await store.close("billing", "invoices");
      expect(await store.open("billing")).toEqual([]);
      /* Another workspace sees none of it. */
      expect(await new DbShapeStore(db, "other").accepted("billing", "invoices")).toBeNull();
      await store.forget("billing");
      expect(await store.accepted("billing", "invoices")).toBeNull();
    } finally {
      await db.close();
    }
  });
});
