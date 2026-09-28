import { INCOMPLETE, emptyMeta, type FetchMeta } from "@freebirdai/dash-adapters";
import { describe, expect, it } from "vitest";
import { incompleteNotes } from "./incomplete.js";

const meta = (extra: Partial<FetchMeta>): FetchMeta => ({ ...emptyMeta("https://api.test/x", 0), ...extra });

describe("incompleteNotes", () => {
  it("reads every source, not only the first", () => {
    // The second source is the one that stopped: it used to go unmentioned.
    const notes = incompleteNotes({
      metas: [
        meta({}),
        meta({ truncated: true, warnings: [INCOMPLETE.pageCap(5)] }),
      ],
    });
    expect(notes).toEqual([INCOMPLETE.pageCap(5)]);
  });

  it("keeps only notes about missing rows, not other caveats", () => {
    const notes = incompleteNotes({
      metas: [meta({ warnings: ['"x" returned text that had to be parsed as JSON'] })],
    });
    expect(notes).toEqual([]);
  });

  it("says a read was cut short even when it gave no reason", () => {
    expect(incompleteNotes({ metas: [meta({ truncated: true })] })[0]).toMatch(
      /may exclude additional records/,
    );
  });

  it("names a fan-out that read only some records, without guessing at the rest", () => {
    const notes = incompleteNotes({
      metas: [],
      fanOut: { truncated: true, read: 25, of: 40, missing: 2 },
    });
    expect(notes).toEqual([
      "Only 25 of 40 records were read in full, so what is shown excludes the rest.",
      "2 of 25 related records could not be read, so what is shown excludes them.",
    ]);
    // Nothing claims the missing part is small, or positive.
    expect(notes.join(" ")).not.toMatch(/low|high|at least|more than/);
  });

  it("says each thing once", () => {
    const capped = meta({ truncated: true, warnings: [INCOMPLETE.pageCap(5)] });
    expect(incompleteNotes({ metas: [capped, capped] })).toHaveLength(1);
  });
});
