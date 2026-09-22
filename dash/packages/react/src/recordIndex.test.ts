import type { ColumnMeta, ColumnReference, ResolvedParams } from "@freebirdai/dash-spec";
import { resolveRange } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  MAX_LOOKUPS,
  fetchLookupsInOrder,
  isDenied,
  nameOfRecord,
  referenceLookups,
  referenceNames,
  unnamedLinks,
  withLinkedValues,
} from "./recordIndex.js";

/**
 * Which records a view asks for, and what it does with the answers.
 *
 * This is the one wave that spends API requests in proportion to what is on
 * screen, so the cap, the deduplication and the refusals are the behaviour
 * worth pinning — not the happy path.
 */

const params: ResolvedParams = {
  range: resolveRange({ preset: "30d", now: Date.UTC(2026, 8, 12) }),
  filters: {},
};

const reference = (input: Partial<ColumnReference> = {}): ColumnReference => ({
  target: "vendor",
  targetName: "Vendor",
  targetTitle: ["CompanyName"],
  holds: "scalar",
  embedded: [],
  lookup: { op: "vendors_byid", param: "vendorId" },
  ...input,
});

const column = (name: string, ref?: ColumnReference): ColumnMeta => ({
  name,
  valueType: "categorical",
  ...(ref ? { reference: ref } : {}),
});

const lookupsFor = (rows: readonly Record<string, unknown>[], columns: readonly ColumnMeta[]) =>
  referenceLookups({ rows, columns, connection: "api", params });

describe("referenceLookups", () => {
  it("asks for each distinct id once", () => {
    const found = lookupsFor(
      [{ VendorId: 41 }, { VendorId: 41 }, { VendorId: 77 }],
      [column("VendorId", reference())],
    );
    expect(found.map((one) => one.id)).toEqual([41, 77]);
    expect(found[0]).toMatchObject({ op: "vendors_byid", param: "vendorId", target: "vendor" });
  });

  it("asks for nothing when the name is already on the row", () => {
    // 43 of the real map's links are this case. Spending a request to learn
    // something already rendered would be the worst trade here.
    expect(
      lookupsFor([{ VendorId: 41, Vendor_Name: "Acme" }], [
        column("VendorId", reference({ embedded: ["Vendor_Name"] })),
      ]),
    ).toEqual([]);
  });

  it("asks for nothing when no endpoint can return one", () => {
    expect(
      lookupsFor([{ VendorId: 41 }], [column("VendorId", reference({ lookup: undefined }))]),
    ).toEqual([]);
  });

  it("skips empty cells rather than looking up nothing", () => {
    expect(
      lookupsFor(
        [{ VendorId: null }, { VendorId: "" }, { VendorId: undefined }, { VendorId: 5 }],
        [column("VendorId", reference())],
      ).map((one) => one.id),
    ).toEqual([5]);
  });

  it("reads every id out of a list-valued reference", () => {
    expect(
      lookupsFor([{ Ids: [1, 2] }], [column("Ids", reference({ holds: "array" }))]).map(
        (one) => one.id,
      ),
    ).toEqual([1, 2]);
  });

  it("refuses to fetch a row that points at another kind of record", () => {
    /*
     * The lookup endpoint belongs to the link's default target, so following
     * it would fetch the wrong kind of record — and labelling an association
     * with a property's name is worse than leaving the id showing.
     */
    const poly = reference({
      typeColumn: "Kind",
      typeMap: { Rental: "vendor" },
    });
    const found = lookupsFor([{ VendorId: 1, Kind: "Rental" }, { VendorId: 2, Kind: "Association" }], [
      column("VendorId", poly),
    ]);
    expect(found.map((one) => one.id)).toEqual([1]);
  });

  it("stops at the cap, spending the budget on what is read first", () => {
    const rows = Array.from({ length: MAX_LOOKUPS + 10 }, (_, index) => ({ VendorId: index }));
    const found = lookupsFor(rows, [column("VendorId", reference())]);
    expect(found).toHaveLength(MAX_LOOKUPS);
    // The first rows, not an arbitrary slice: a cap that resolved row ninety
    // and not row one would be worse than no cap.
    expect(found[0]?.id).toBe(0);
  });

  it("keys each lookup the way the cache already keys that request", () => {
    // So a record already open costs nothing, and two widgets naming the same
    // vendor resolve it once between them.
    const [one] = lookupsFor([{ VendorId: 41 }], [column("VendorId", reference())]);
    expect(one?.key).toContain("api.vendors_byid");
    expect(one?.key).toContain("41");
  });

  it("does nothing for a view with no reference columns", () => {
    expect(lookupsFor([{ Title: "x" }], [column("Title")])).toEqual([]);
  });
});

describe("fetchLookupsInOrder", () => {
  const three = lookupsFor(
    [{ VendorId: 1 }, { VendorId: 2 }, { VendorId: 3 }],
    [column("VendorId", reference())],
  );

  it("asks one at a time, in the order the reader sees", async () => {
    const asked: unknown[] = [];
    let open = 0;
    let mostAtOnce = 0;
    await fetchLookupsInOrder({
      lookups: three,
      fetch: async (lookup) => {
        open += 1;
        mostAtOnce = Math.max(mostAtOnce, open);
        asked.push(lookup.id);
        await Promise.resolve();
        open -= 1;
      },
      statusOf: () => undefined,
    });
    expect(asked).toEqual([1, 2, 3]);
    expect(mostAtOnce).toBe(1);
  });

  it("stops at the first refusal instead of spending the rest of the budget", async () => {
    // The real failure: a collection endpoint answered and a by-id call
    // seconds later came back 429. Twenty-five parallel lookups would have
    // spent the whole budget learning that once per id.
    const asked: unknown[] = [];
    const result = await fetchLookupsInOrder({
      lookups: three,
      fetch: async (lookup) => void asked.push(lookup.id),
      statusOf: (lookup) => (lookup.id === 2 ? 429 : undefined),
    });
    expect(asked).toEqual([1, 2]);
    expect(result).toEqual({ fetched: 2, refusedWith: 429 });
  });

  it("carries on past an ordinary failure, which says nothing about the next id", async () => {
    const asked: unknown[] = [];
    await fetchLookupsInOrder({
      lookups: three,
      fetch: async (lookup) => void asked.push(lookup.id),
      statusOf: (lookup) => (lookup.id === 1 ? 404 : undefined),
    });
    expect(asked).toEqual([1, 2, 3]);
  });

  it("gives up when the view that asked has gone away", async () => {
    const asked: unknown[] = [];
    let gone = false;
    await fetchLookupsInOrder({
      lookups: three,
      fetch: async (lookup) => {
        asked.push(lookup.id);
        gone = true;
      },
      statusOf: () => undefined,
      stopped: () => gone,
    });
    expect(asked).toEqual([1]);
  });
});

describe("nameOfRecord", () => {
  it("joins the title fields in order", () => {
    expect(nameOfRecord({ FirstName: "Ada", LastName: "Byron" }, ["FirstName", "LastName"])).toBe(
      "Ada Byron",
    );
  });

  it("reads a nested path, flattened or not", () => {
    // A detail response arrives in the API's own shape; a pipeline may have
    // flattened it. Both spellings resolve to the same name.
    expect(nameOfRecord({ Contact: { Name: "Acme" } }, ["Contact.Name"])).toBe("Acme");
    expect(nameOfRecord({ Contact_Name: "Acme" }, ["Contact.Name"])).toBe("Acme");
  });

  it("chooses between alternatives when told they are not parts", () => {
    // The real case: joining a supplier's company and personal names produced
    // "McKinney Strategic Greg McKinney", which is nobody.
    const title = ["CompanyName", "FirstName", "LastName"];
    const row = { CompanyName: "McKinney Strategic", FirstName: "Greg", LastName: "McKinney" };
    expect(nameOfRecord(row, title, "first")).toBe("McKinney Strategic");
    expect(nameOfRecord({ FirstName: "Greg", LastName: "McKinney" }, title, "first")).toBe("Greg");
    // Default stays "join", so nothing written before this changes meaning.
    expect(nameOfRecord(row, title)).toBe("McKinney Strategic Greg McKinney");
  });

  it("takes the first record when the endpoint answered with a list", () => {
    expect(nameOfRecord([{ CompanyName: "Acme" }], ["CompanyName"])).toBe("Acme");
  });

  it("says null rather than an empty name", () => {
    // So a caller can tell "not resolved" from "resolved to nothing".
    for (const body of [null, undefined, {}, { CompanyName: "" }, "text"]) {
      expect(nameOfRecord(body, ["CompanyName"]), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("withLinkedValues", () => {
  /**
   * A column read through a reference — a task's vendor's phone.
   *
   * The value is on another record entirely, so the pipeline made the column
   * empty and this fills it in. What matters is that a row whose record has
   * not landed comes back untouched: blank reads as "not yet", where a wrong
   * value reads as fact.
   */
  const columns = [column("VendorId", reference())];
  const rows = [{ VendorId: 41 }, { VendorId: 77 }];
  const linked = [{ through: "VendorId", field: "Phone", as: "VendorId_Phone" }];

  it("fills the column from the record the reference points at", () => {
    const lookups = lookupsFor(rows, columns);
    const bodies: Record<string, unknown> = {
      [lookups[0]!.key]: { Id: 41, Phone: "0117 496 0123" },
    };
    expect(withLinkedValues({ rows, linked, lookups, recordOf: (lookup) => bodies[lookup.key] })).toEqual([
      { VendorId: 41, VendorId_Phone: "0117 496 0123" },
      // Not landed, so no value is invented for it.
      { VendorId: 77 },
    ]);
  });

  it("reads a nested field off the far record", () => {
    const lookups = lookupsFor([{ VendorId: 41 }], columns);
    const bodies: Record<string, unknown> = {
      [lookups[0]!.key]: { Contact: { Phone: "0117 496 0123" } },
    };
    const nested = [{ through: "VendorId", field: "Contact.Phone", as: "VendorId_Contact_Phone" }];
    expect(
      withLinkedValues({ rows: [{ VendorId: 41 }], linked: nested, lookups, recordOf: (lookup) => bodies[lookup.key] })[0],
    ).toEqual({ VendorId: 41, VendorId_Contact_Phone: "0117 496 0123" });
  });

  it("leaves rows exactly as they were when nothing is linked", () => {
    expect(withLinkedValues({ rows, linked: [], lookups: [], recordOf: () => undefined })).toBe(rows);
  });

  it("skips a row whose reference is empty", () => {
    const lookups = lookupsFor([{ VendorId: null }], columns);
    expect(
      withLinkedValues({ rows: [{ VendorId: null }], linked, lookups, recordOf: () => ({ Phone: "x" }) }),
    ).toEqual([{ VendorId: null }]);
  });
});

describe("referenceNames", () => {
  const columns = [column("VendorId", reference())];

  it("indexes the names that came back, by column and id", () => {
    const lookups = lookupsFor([{ VendorId: 41 }, { VendorId: 77 }], columns);
    const bodies: Record<string, unknown> = {
      [lookups[0]!.key]: { CompanyName: "Acme Plumbing" },
      [lookups[1]!.key]: { CompanyName: "Borden Electrical" },
    };
    expect(referenceNames(lookups, (lookup) => bodies[lookup.key], columns)).toEqual({
      VendorId: { "41": "Acme Plumbing", "77": "Borden Electrical" },
    });
  });

  it("leaves out an id whose record has not landed", () => {
    // The cell falls back to naming the kind of record, which is why that
    // fallback has to read well on its own.
    const lookups = lookupsFor([{ VendorId: 41 }], columns);
    expect(referenceNames(lookups, () => undefined, columns)).toEqual({});
  });
});

describe("records already held cost nothing and are not capped", () => {
  const columns = [column("VendorId", reference())];
  const rows = Array.from({ length: 40 }, (_, i) => ({ VendorId: i + 1 }));

  it("spends the budget only on records it does not already hold", () => {
    // The first thirty are known from something else that already fetched them.
    const known = ({ id }: { id: string | number }) => Number(id) <= 30;
    const lookups = referenceLookups({
      rows,
      columns,
      connection: "api",
      params,
      known,
    });

    const held = lookups.filter((lookup) => lookup.held);
    const payable = lookups.filter((lookup) => !lookup.held);

    // Every known record still resolves — that is how its name reaches a cell.
    expect(held).toHaveLength(30);
    // And the cap applies only to the ones that would cost a request.
    expect(payable).toHaveLength(10);
    expect(payable.every((lookup) => Number(lookup.id) > 30)).toBe(true);
  });

  it("caps payable lookups exactly as before when nothing is held", () => {
    const lookups = referenceLookups({ rows, columns, connection: "api", params });
    expect(lookups).toHaveLength(25);
    expect(lookups.every((lookup) => !lookup.held)).toBe(true);
  });

  it("marks nothing as held when no index is offered", () => {
    const lookups = referenceLookups({ rows: rows.slice(0, 3), columns, connection: "api", params });
    expect(lookups.every((lookup) => lookup.held === undefined)).toBe(true);
  });
});

describe("unnamedLinks", () => {
  const lookup = (id: number) => ({
    connection: "acme",
    op: "vendor_by_id",
    param: "vendorId",
    id,
    target: "vendor",
    column: "VendorId",
    key: `k${id}`,
  });

  const lookups = [lookup(1), lookup(2), lookup(3)];

  it("says nothing when every name resolved", () => {
    expect(
      unnamedLinks({
        lookups,
        names: { VendorId: { "1": "Acme", "2": "Bolt", "3": "Cole" } },
        failureOf: () => undefined,
      }),
    ).toBeNull();
  });

  /* A record that was read and has nothing to call itself is a different
   * problem with a different answer. Blaming a rate limit that was never there
   * sends somebody looking in the wrong place. */
  it("says nothing when no fetch failed, however many names are missing", () => {
    expect(
      unnamedLinks({ lookups, names: {}, failureOf: () => undefined }),
    ).toBeNull();
  });

  it("counts the cells left showing an id, and quotes the refusal", () => {
    const result = unnamedLinks({
      lookups,
      names: { VendorId: { "1": "Acme" } },
      failureOf: (key) => (key === "k2" ? "Buildium is rate limiting us." : undefined),
    });
    expect(result).toEqual({ count: 2, reason: "Buildium is rate limiting us." });
  });

  /* The list was standing in for every per-record call, so its refusal is the
   * one that cost the names. */
  it("prefers the whole-list refusal over a per-record one", () => {
    const result = unnamedLinks({
      lookups,
      names: {},
      batchKeys: ["vendors-list"],
      failureOf: (key) =>
        key === "vendors-list" ? "the vendor list was refused" : "one vendor was refused",
    });
    expect(result?.reason).toBe("the vendor list was refused");
    expect(result?.count).toBe(3);
  });

  it("says nothing when there was nothing to look up", () => {
    expect(unnamedLinks({ lookups: [], names: {}, failureOf: () => "refused" })).toBeNull();
  });
});

describe("a record type the account cannot read", () => {
  /* 403 is a fact about the credential and 429 is a fact about the moment.
   * Buildium answers 403 for an account without the accounting module, on
   * every call, forever. */
  it("knows which statuses will not change by asking again", () => {
    expect(isDenied(403)).toBe(true);
    expect(isDenied(401)).toBe(true);
    expect(isDenied(429)).toBe(false);
    /* A missing record says nothing about the next one. */
    expect(isDenied(404)).toBe(false);
    expect(isDenied(undefined)).toBe(false);
  });

  it("skips the rest of that record type and carries on with the others", async () => {
    const mixed = [
      ...lookupsFor([{ BillId: 1 }, { BillId: 2 }, { BillId: 3 }], [
        column("BillId", reference({ target: "bill", targetName: "Bill" })),
      ]),
      ...lookupsFor([{ VendorId: 9 }], [column("VendorId", reference())]),
    ];
    const asked: unknown[] = [];
    const result = await fetchLookupsInOrder({
      lookups: mixed,
      fetch: async (lookup) => {
        asked.push(`${lookup.target}:${lookup.id}`);
      },
      statusOf: (lookup) => (lookup.target === "bill" ? 403 : undefined),
    });

    /* One bill call proves the type is denied; the other two are not made. The
     * vendor is a different record type and is still asked for. */
    expect(asked).toEqual(["bill:1", "vendor:9"]);
    expect(result.denied).toEqual(["bill"]);
  });

  it("spends no budget on a record type already denied", () => {
    const rows = Array.from({ length: MAX_LOOKUPS + 10 }, (_, index) => ({
      BillId: index,
      VendorId: 1000 + index,
    }));
    const found = referenceLookups({
      rows,
      columns: [
        column("BillId", reference({ target: "bill", targetName: "Bill" })),
        column("VendorId", reference()),
      ],
      connection: "api",
      params,
      denied: (target) => target === "bill",
    });

    const bills = found.filter((one) => one.target === "bill");
    const vendors = found.filter((one) => one.target === "vendor");
    /* Every bill is still listed, so its cell can say why it shows an id... */
    expect(bills).toHaveLength(MAX_LOOKUPS + 10);
    expect(bills.every((one) => one.denied)).toBe(true);
    /* ...and none of them took a slot from the vendors, which was the bug:
     * one denied record type used to eat the whole budget. */
    expect(vendors).toHaveLength(MAX_LOOKUPS);
  });
});

describe("columns the component does not draw", () => {
  /* A widget's rows carry every column its endpoint returned; the component
   * draws the handful its roles name. Measured on a real board: a six-column
   * work order table carried nineteen, one of them a list of bill ids the
   * account is not licensed to read — and every refresh spent the whole
   * budget naming a column nobody could see. */
  it("asks for nothing on a reference column that is not drawn", () => {
    const found = referenceLookups({
      rows: [{ VendorId: 41, BillTransactionIds: [9, 10] }],
      columns: [
        column("VendorId", reference()),
        column("BillTransactionIds", reference({ target: "bill", targetName: "Bill", holds: "array" })),
      ],
      connection: "api",
      params,
      shown: new Set(["VendorId"]),
    });
    expect(found.map((one) => one.target)).toEqual(["vendor"]);
  });

  it("asks for every reference column when the caller does not say", () => {
    const found = referenceLookups({
      rows: [{ VendorId: 41, BillTransactionIds: [9] }],
      columns: [
        column("VendorId", reference()),
        column("BillTransactionIds", reference({ target: "bill", targetName: "Bill", holds: "array" })),
      ],
      connection: "api",
      params,
    });
    expect(new Set(found.map((one) => one.target))).toEqual(new Set(["vendor", "bill"]));
  });
});
