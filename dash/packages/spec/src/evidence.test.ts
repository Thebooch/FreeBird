import { describe, expect, it } from "vitest";
import { readCoverage } from "./evidence.js";

/*
 * The ladder on the tile: how far a read got, in the words a person reads
 * beside a row count — and never more than the read itself shows.
 */
describe("readCoverage", () => {
  it("says every record only when the API's own count matches what was read", () => {
    expect(readCoverage({ pages: 3, truncated: false, reportedTotal: 295 }, 295)).toMatchObject({
      level: "count-reconciled",
      said: "all 295 read",
    });
    /* A count that disagrees is not a claim of every record. */
    expect(readCoverage({ pages: 3, truncated: false, reportedTotal: 300 }, 295)?.level).toBe("traversed");
  });

  it("says every page where the pages ran out, and that nothing checks the count", () => {
    const coverage = readCoverage({ pages: 42, truncated: false }, 826);
    expect(coverage).toMatchObject({ level: "traversed", said: "every page read" });
    expect(coverage?.detail).toMatch(/nothing checks the count/);
  });

  it("claims only the request for a read of one page", () => {
    expect(readCoverage({ pages: 1, truncated: false }, 200)).toMatchObject({ level: "accepted", said: "read in one request" });
  });

  it("says nothing of a read cut short, which says what it left out elsewhere", () => {
    expect(readCoverage({ pages: 5, truncated: true, reportedTotal: 11848 }, 500)).toBeNull();
  });
});
