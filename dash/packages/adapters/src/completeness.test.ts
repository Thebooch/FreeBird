import { describe, expect, it } from "vitest";
import { queryCompleteness } from "./completeness.js";

describe("query completeness", () => {
  const base = { rowsPath: "$.items", lastBody: { items: [] }, truncated: false, warnings: [] };
  it("distinguishes a successful response from exhausted results", () => {
    expect(queryCompleteness({ ...base, pagination: { kind: "none" } }).status).toBe("unknown");
    expect(queryCompleteness({ ...base, pagination: { kind: "offset", param: "offset", limitParam: "limit", pageSize: 10 } }).status).toBe("complete");
  });
  it("cannot claim completeness when continuation evidence is absent or contradictory", () => {
    const pagination = { kind: "cursor" as const, param: "after", cursorPath: "$.next", hasMorePath: "$.more" };
    expect(queryCompleteness({ ...base, pagination }).status).toBe("unknown");
    expect(queryCompleteness({ ...base, pagination, lastBody: { items: [], more: true } }).status).toBe("partial");
    expect(queryCompleteness({ ...base, pagination, lastBody: { items: [], more: false } }).status).toBe("complete");
  });
  it("preserves explicit limits", () => {
    expect(queryCompleteness({ ...base, pagination: { kind: "none" }, truncated: true, warnings: ["Page limit."] })).toMatchObject({ status: "partial", reason: "Page limit." });
  });
});
