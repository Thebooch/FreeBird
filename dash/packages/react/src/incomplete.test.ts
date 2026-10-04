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

  it("says how far the rest has got while the host reads it", () => {
    const notes = incompleteNotes({
      metas: [],
      fanOut: {
        truncated: true,
        read: 25,
        of: 212,
        missing: 0,
        whole: { status: "reading", read: 40, asked: 212, beyond: 0, failed: 0, notes: [] },
      },
    });
    expect(notes).toEqual([
      "Only 25 of 212 records were read in full, so what is shown excludes the rest.",
      "The rest are being read: 40 of 212 so far.",
    ]);
  });

  it("says nothing is missing once the host has read every record", () => {
    const capped = meta({ truncated: true, warnings: [INCOMPLETE.pageCap(5)] });
    const notes = incompleteNotes({
      /* The first twenty-five's own notes are the host's to state now. */
      metas: [],
      fanOut: {
        truncated: true,
        read: 25,
        of: 212,
        missing: 0,
        whole: { status: "done", read: 212, asked: 212, beyond: 0, failed: 0, notes: [] },
      },
    });
    expect(notes).toEqual([]);
    /* A read the host's answer does not stand in for still says what it left out. */
    const whole = { status: "done" as const, read: 1, asked: 1, beyond: 0, failed: 0, notes: [] };
    expect(
      incompleteNotes({
        metas: [capped],
        fanOut: { truncated: false, read: 0, of: 0, missing: 0, whole },
      }),
    ).toEqual([INCOMPLETE.pageCap(5)]);
  });

  it("says what the host's read left out: past the ceiling, stopped, failed, or what each read left out", () => {
    const notes = incompleteNotes({
      metas: [],
      fanOut: {
        truncated: true,
        read: 25,
        of: 700,
        missing: 0,
        whole: {
          status: "done",
          read: 120,
          asked: 500,
          beyond: 200,
          failed: 3,
          notes: [INCOMPLETE.pageCap(5)],
          stopped: "The API asked to wait a minute.",
        },
      },
    });
    expect(notes).toEqual([
      "Only 120 of 700 records were read in full, so what is shown excludes the rest.",
      "The rest were not read: The API asked to wait a minute.",
      "3 of 500 related records could not be read, so what is shown excludes them.",
      INCOMPLETE.pageCap(5),
    ]);
  });

  it("says each thing once", () => {
    const capped = meta({ truncated: true, warnings: [INCOMPLETE.pageCap(5)] });
    expect(incompleteNotes({ metas: [capped, capped] })).toHaveLength(1);
  });
});
