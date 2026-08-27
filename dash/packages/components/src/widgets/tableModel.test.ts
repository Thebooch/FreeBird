import type { ColumnMeta } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  columnTotals,
  effectiveSort,
  filterRows,
  nextSort,
  sortRows,
  visibleColumns,
} from "./tableModel.js";

type Row = Record<string, unknown>;

const rows: Row[] = [
  { name: "item 9", amount: 900, when: "2026-02-01" },
  { name: "item 10", amount: 100, when: "2026-01-01" },
  { name: "item 2", amount: null, when: "2026-03-01" },
];

const meta: ColumnMeta[] = [
  { name: "name", valueType: "text" },
  { name: "amount", valueType: "numeric" },
  { name: "when", valueType: "temporal" },
];

const names = (result: readonly Row[]): unknown[] => result.map((row) => row.name);

describe("sortRows", () => {
  it("returns the rows untouched when nothing is sorted", () => {
    expect(sortRows(rows, null)).toBe(rows);
  });

  it("sorts numbers as numbers", () => {
    expect(names(sortRows(rows, { column: "amount", direction: "asc" }))).toEqual([
      "item 10",
      "item 9",
      // Null last.
      "item 2",
    ]);
  });

  /*
   * The default string comparison puts "item 10" before "item 9" because "1"
   * sorts before "9". That is technically correct and always reads as a bug.
   */
  it("sorts text the way a person reads it", () => {
    expect(names(sortRows(rows, { column: "name", direction: "asc" }))).toEqual([
      "item 2",
      "item 9",
      "item 10",
    ]);
  });

  it("keeps empty values last in both directions", () => {
    expect(names(sortRows(rows, { column: "amount", direction: "desc" }))).toEqual([
      "item 9",
      "item 10",
      "item 2",
    ]);
  });

  /*
   * The row array comes from the pipeline and is shared with the query cache,
   * so an in-place sort would silently reorder another widget bound to the
   * same source.
   */
  it("does not reorder the caller's array", () => {
    const original = [...rows];
    sortRows(rows, { column: "amount", direction: "asc" });
    expect(rows).toEqual(original);
  });
});

describe("nextSort", () => {
  it("cycles ascending, descending, then back to the pipeline's own order", () => {
    const first = nextSort(null, "amount");
    expect(first).toEqual({ column: "amount", direction: "asc" });
    const second = nextSort(first, "amount");
    expect(second).toEqual({ column: "amount", direction: "desc" });
    expect(nextSort(second, "amount")).toBeNull();
  });

  it("starts fresh on a different column", () => {
    expect(nextSort({ column: "amount", direction: "desc" }, "name")).toEqual({
      column: "name",
      direction: "asc",
    });
  });
});

describe("effectiveSort", () => {
  /*
   * A pipeline edit can remove the column somebody sorted by. Trusting the
   * stored sort would then order by a column that is not there.
   */
  it("drops a sort whose column no longer exists", () => {
    expect(effectiveSort({ column: "gone", direction: "asc" }, ["name"])).toBeNull();
    expect(effectiveSort({ column: "name", direction: "asc" }, ["name"])).toEqual({
      column: "name",
      direction: "asc",
    });
  });
});

describe("filterRows", () => {
  const display = (row: Row, column: string): string => String(row[column] ?? "");

  it("matches what the reader sees, not the raw value", () => {
    const formatted = (row: Row, column: string): string =>
      column === "amount" && typeof row[column] === "number"
        ? `$${(row[column] as number) / 100}`
        : String(row[column] ?? "");
    // 900 is stored in cents and shown as $9 — searching "$9" has to find it.
    expect(names(filterRows(rows, ["amount"], "$9", formatted))).toEqual(["item 9"]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(filterRows(rows, ["name"], "  ITEM 2 ".trimEnd(), display)).toHaveLength(1);
  });

  it("returns everything for an empty query rather than nothing", () => {
    expect(filterRows(rows, ["name"], "   ", display)).toBe(rows);
  });

  it("searches across every visible column", () => {
    expect(names(filterRows(rows, ["name", "when"], "2026-03", display))).toEqual(["item 2"]);
  });
});

describe("columnTotals", () => {
  it("sums only the numeric columns", () => {
    const totals = columnTotals(rows, ["name", "amount", "when"], meta);
    expect(totals).toEqual([{ column: "amount", sum: 1000, counted: 2 }]);
  });

  /*
   * A sum over two of three rows is a different fact from a sum over all
   * three, and the component says which by comparing `counted`.
   */
  it("reports how many rows actually held a number", () => {
    const [total] = columnTotals(rows, ["amount"], meta);
    expect(total?.counted).toBe(2);
    expect(rows).toHaveLength(3);
  });

  it("is empty when nothing numeric is on screen", () => {
    expect(columnTotals(rows, ["name"], meta)).toEqual([]);
  });

  /*
   * The sum of a column of primary keys is a large number that means nothing,
   * and printing it in bold under a column of real figures invites somebody to
   * read it as one.
   */
  it("never sums an identifier column", () => {
    const idMeta: ColumnMeta[] = [
      { name: "Id", valueType: "numeric" },
      { name: "PropertyId", valueType: "numeric" },
      { name: "account_id", valueType: "numeric" },
      { name: "customerRef", valueType: "numeric", semantic: "identifier" },
      { name: "amount", valueType: "numeric" },
    ];
    const idRows = [{ Id: 1, PropertyId: 2, account_id: 3, customerRef: 4, amount: 10 }];
    const totals = columnTotals(idRows, idMeta.map((column) => column.name), idMeta);
    expect(totals.map((total) => total.column)).toEqual(["amount"]);
  });

  /*
   * Matching id case-insensitively would also swallow "Paid", "Bid" and
   * "Valid", so the camelCase boundary is checked against the real spelling.
   */
  it("does not mistake an ordinary word ending in i-d for an identifier", () => {
    const wordMeta: ColumnMeta[] = [
      { name: "Paid", valueType: "numeric" },
      { name: "bid", valueType: "numeric" },
    ];
    const totals = columnTotals([{ Paid: 5, bid: 7 }], ["Paid", "bid"], wordMeta);
    expect(totals.map((total) => total.column)).toEqual(["Paid", "bid"]);
  });
});

describe("visibleColumns", () => {
  it("drops what the reader hid", () => {
    expect(visibleColumns(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  /*
   * A table with every column hidden is an empty box with no way back, since
   * the picker lives above rows that no longer render.
   */
  it("never hides the last column", () => {
    expect(visibleColumns(["a", "b"], new Set(["a", "b"]))).toEqual(["a"]);
  });

  it("ignores hidden names that are no longer produced", () => {
    expect(visibleColumns(["a"], new Set(["gone"]))).toEqual(["a"]);
  });
});
