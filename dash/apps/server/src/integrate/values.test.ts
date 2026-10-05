import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { taskpad } from "../bench/providers/taskpad.js";
import { benchTransport } from "../bench/transport.js";
import { connectionFromCatalog } from "@freebirdai/connect/catalog";
import { discover } from "@freebirdai/connect/discovery/index";
import { MemorySeenValueStore } from "@freebirdai/connect/values/store";
import { integrate } from "@freebirdai/connect/integrate/agent";
import { observedShape, withObservedFields } from "@freebirdai/connect/integrate/observed";
import { seenByRecordType, seenValues } from "@freebirdai/connect/integrate/values";
import { openDashDb } from "../platform/db.js";
import { DbSeenValueStore } from "@freebirdai/connect-postgres";

/*
 * What this account's records hold, where a field holds a small set — so a
 * request narrowed in its own words ("US dollars", "money out") can be written
 * in the records' ("USD", "debit"). Measurement 1: multicur and vaultbank read
 * every record and counted the wrong ones, because nothing said which words
 * the records use.
 */

const people = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov", "Donald Knuth"];
const rows = Array.from({ length: 24 }, (_, index) => ({
  id: `tx_${index}`,
  direction: index % 3 === 0 ? "credit" : "debit",
  currency: index % 4 === 0 ? "EUR" : "USD",
  payee: people[index % people.length]!,
  memo: `Invoice ${1000 + index} paid in full`,
  booked: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
  amount: String(10 + index),
  email: `person${index % 2}@example.test`,
  kind: "transaction",
  account_id: index % 2 === 0 ? "acc_1" : "acc_2",
}));
const fields = Object.keys(rows[0]!).map((name) => ({ name, kinds: ["string"] }));

describe("the values a field's records hold", () => {
  it("keeps a small set that repeats, most used first", () => {
    const seen = seenValues(rows, fields);
    expect(seen.direction).toEqual(["debit", "credit"]);
    expect(seen.currency).toEqual(["USD", "EUR"]);
  });

  it("never keeps what is not a set of kinds of thing", () => {
    const seen = seenValues(rows, fields);
    /* An identity, a sentence per record, a date, an amount, an address, one value everywhere, an account id. */
    for (const path of ["id", "memo", "booked", "amount", "email", "kind", "account_id"]) expect(seen[path], path).toBeUndefined();
  });

  it("keeps names only where they repeat as a set does", () => {
    /* Six people across twenty-four records, each four times: a set, like "assigned to". */
    expect(seenValues(rows, fields).payee).toHaveLength(6);
    /* A different person on every record is a list of people, and is not kept. */
    const unique = rows.map((row, index) => ({ ...row, payee: `Person ${String.fromCharCode(65 + index)}` }));
    expect(seenValues(unique, fields).payee).toBeUndefined();
  });

  it("takes a field only if every value passes, so a set is never a sample of something larger", () => {
    const mixed = rows.map((row, index) => (index === 5 ? { ...row, direction: "see https://bank.test/x" } : row));
    expect(seenValues(mixed, fields).direction).toBeUndefined();
    const numbered = rows.map((row, index) => (index === 5 ? { ...row, currency: 840 } : row));
    expect(seenValues(numbered, fields).currency).toBeUndefined();
  });

  it("says nothing from too few records to show anything repeating", () => {
    expect(seenValues(rows.slice(0, 3), fields)).toEqual({});
  });

  it("is given to a record type by its list endpoint", () => {
    const seen = seenByRecordType(
      { resources: [{ id: "payment", title: "Payments", listOp: "listPayments", relations: [], verified: false }] },
      [
        { id: "payment", resource: "payment" },
        { id: "refund", resource: "refund" },
      ],
      { listPayments: { fields: { currency: ["USD", "EUR"] }, everyRecord: false } },
    );
    expect(seen).toEqual({ payment: { fields: { currency: ["USD", "EUR"] }, everyRecord: false } });
  });
});

describe("where they are kept", () => {
  it("is never the catalog entry the observed fields go to", () => {
    const entry = catalogEntrySchema.parse({
      id: "bank",
      title: "Bank",
      baseUrl: "https://api.bank.test",
      dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
      ops: [{ id: "transactions", title: "Transactions", path: "/transactions" }],
    });
    const grown = withObservedFields(entry, { transactions: observedShape(rows, "$")! });
    expect(grown).not.toBeNull();
    for (const value of ["debit", "credit", "USD", "EUR", "Grace Hopper"]) expect(JSON.stringify(grown)).not.toContain(value);
  });

  it("is per connection, replaced per endpoint, and forgotten with the connection", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      for (const store of [new MemorySeenValueStore(), new DbSeenValueStore(db)]) {
        await store.put("bank", "transactions", { fields: { direction: ["debit", "credit"] }, everyRecord: false });
        await store.put("bank", "transactions", { fields: { direction: ["debit"] }, everyRecord: true });
        await store.put("bank", "accounts", { fields: { kind: ["checking", "savings"] }, everyRecord: false });
        await store.put("other", "transactions", { fields: { direction: ["in", "out"] }, everyRecord: true });
        expect(await store.get("bank")).toEqual({
          transactions: { fields: { direction: ["debit"] }, everyRecord: true },
          accounts: { fields: { kind: ["checking", "savings"] }, everyRecord: false },
        });
        await store.forget("bank");
        expect(await store.get("bank")).toEqual({});
        expect(await store.get("other")).toEqual({ transactions: { fields: { direction: ["in", "out"] }, everyRecord: true } });
      }
    } finally {
      await db.close();
    }
  });

  it("is reported by the check, beside the observed fields and apart from them", async () => {
    const transport = benchTransport([taskpad]);
    const found = await discover(taskpad.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
    const connection = connectionFromCatalog(found.entry!, { id: "taskpad" });
    const refs = "keyRef" in connection.auth ? { [connection.auth.keyRef]: taskpad.credentials[0]! } : {};
    const report = await integrate(
      connection,
      { targets: [connection.ops[0]!.id] },
      {
        http: transport.http,
        resolveSecret: async (ref) => (refs as Record<string, string>)[ref] ?? null,
        fetchDocument: transport.fetchDocument,
        now: () => Date.UTC(2026, 8, 1),
      },
    );
    const op = connection.ops[0]!.id;
    const seen = report.values[op]?.fields ?? {};
    expect(Object.keys(seen).length).toBeGreaterThan(0);
    for (const values of Object.values(seen)) expect(JSON.stringify(report.observed[op])).not.toContain(JSON.stringify(values[0]));
    /* Taskpad states no count, so nothing says this read saw every record. */
    expect(report.values[op]?.everyRecord).toBe(false);
  });
});
