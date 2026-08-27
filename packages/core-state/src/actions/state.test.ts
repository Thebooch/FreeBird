import { describe, expect, it } from "vitest";
import {
  applyTransition,
  deriveMissingFields,
  initialActionState,
  lastPaused,
  pausedRecords,
  type ActionTransition,
} from "./state.js";
import type { ActionRecord, ActionState } from "@freebirdai/core";

const T0 = new Date("2026-04-22T10:00:00Z");
const T1 = new Date("2026-04-22T10:00:01Z");
const T2 = new Date("2026-04-22T10:00:02Z");

const start = (
  overrides: Partial<Extract<ActionTransition, { type: "start" }>> = {},
): ActionTransition => ({
  type: "start",
  recordId: "rec1",
  componentId: "settings",
  actionId: "set_theme",
  requiresConfirmation: "preview",
  args: { theme: "dark" },
  missing: [],
  at: T0,
  ...overrides,
});

describe("action state machine — start", () => {
  it("moves to awaiting_confirmation when no missing fields and policy=preview", () => {
    const next = applyTransition(initialActionState, start());
    expect(next.phase).toBe("awaiting_confirmation");
    expect(next.pending?.recordId).toBe("rec1");
    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]?.status).toBe("in_progress");
  });

  it("moves to executing when no missing fields and policy=none", () => {
    const next = applyTransition(
      initialActionState,
      start({ requiresConfirmation: "none" }),
    );
    expect(next.phase).toBe("executing");
  });

  it("moves to collecting when missing fields are present", () => {
    const next = applyTransition(
      initialActionState,
      start({ args: {}, missing: ["theme"] }),
    );
    expect(next.phase).toBe("collecting");
    expect(next.pending?.missing).toEqual(["theme"]);
  });

  it("rejects start while a pending action is in flight", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(
      s1,
      start({ recordId: "rec2", actionId: "set_density" }),
    );
    expect(s2).toBe(s1);
  });

  it("allows start after error phase", () => {
    const s1: ActionState = {
      phase: "error",
      pending: null,
      journal: [],
      workflowStack: [],
      lastError: "boom",
    };
    const s2 = applyTransition(s1, start({ recordId: "rec2" }));
    expect(s2.phase).toBe("awaiting_confirmation");
    expect(s2.pending?.recordId).toBe("rec2");
  });
});

describe("action state machine — merge_args", () => {
  it("merges into pending and clears phase to awaiting_confirmation when complete", () => {
    const s1 = applyTransition(
      initialActionState,
      start({ args: {}, missing: ["theme"] }),
    );
    const s2 = applyTransition(s1, {
      type: "merge_args",
      args: { theme: "light" },
      missing: [],
      at: T1,
    });
    expect(s2.phase).toBe("awaiting_confirmation");
    expect(s2.pending?.args).toEqual({ theme: "light" });
    expect(s2.journal[0]?.args).toEqual({ theme: "light" });
  });

  it("ignores merge_args when no pending", () => {
    const next = applyTransition(initialActionState, {
      type: "merge_args",
      args: { x: 1 },
      at: T1,
    });
    expect(next).toBe(initialActionState);
  });
});

describe("action state machine — execution lifecycle", () => {
  it("executed marks journal entry completed and stores before/changed", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "begin_executing", at: T1 });
    expect(s2.phase).toBe("executing");
    const s3 = applyTransition(s2, {
      type: "executed",
      result: { ok: true },
      before: { theme: "light" },
      changed: ["theme"],
      at: T2,
    });
    expect(s3.phase).toBe("idle");
    expect(s3.pending).toBeNull();
    expect(s3.journal[0]?.status).toBe("completed");
    expect(s3.journal[0]?.before).toEqual({ theme: "light" });
    expect(s3.journal[0]?.changed).toEqual(["theme"]);
    expect(s3.journal[0]?.result).toEqual({ ok: true });
  });

  it("failed marks journal entry failed and surfaces lastError", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "begin_executing", at: T1 });
    const s3 = applyTransition(s2, {
      type: "failed",
      message: "network",
      before: { theme: "light" },
      at: T2,
    });
    expect(s3.phase).toBe("error");
    expect(s3.lastError).toBe("network");
    expect(s3.journal[0]?.status).toBe("failed");
    expect(s3.journal[0]?.error).toEqual({ message: "network" });
  });
});

describe("action state machine — cancel & pause", () => {
  it("cancelled while pending marks record terminated and returns to idle", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, {
      type: "cancelled",
      reason: "user",
      at: T1,
    });
    expect(s2.phase).toBe("idle");
    expect(s2.pending).toBeNull();
    expect(s2.journal[0]?.status).toBe("terminated");
  });

  it("cancelled in error phase clears the error to idle even with no pending", () => {
    const s1: ActionState = {
      phase: "error",
      pending: null,
      journal: [],
      workflowStack: [],
      lastError: "boom",
    };
    const s2 = applyTransition(s1, { type: "cancelled", at: T1 });
    expect(s2.phase).toBe("idle");
  });

  it("pause moves pending to journal as paused and clears pending", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, {
      type: "pause",
      label: "configure theme",
      at: T1,
    });
    expect(s2.phase).toBe("idle");
    expect(s2.pending).toBeNull();
    expect(s2.journal[0]?.status).toBe("paused");
    expect(s2.journal[0]?.label).toBe("configure theme");
  });
});

describe("action state machine — resume & discard", () => {
  it("resume promotes a paused record back into pending/collecting", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "pause", at: T1 });
    const s3 = applyTransition(s2, {
      type: "resume",
      recordId: "rec1",
      at: T2,
    });
    expect(s3.phase).toBe("collecting");
    expect(s3.pending?.recordId).toBe("rec1");
    expect(s3.journal[0]?.status).toBe("in_progress");
  });

  it("resume refuses if a pending action already exists", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "pause", at: T1 });
    const s3 = applyTransition(
      s2,
      start({ recordId: "rec2", actionId: "set_density" }),
    );
    const s4 = applyTransition(s3, {
      type: "resume",
      recordId: "rec1",
      at: T2,
    });
    expect(s4).toBe(s3);
  });

  it("resume refuses if record is not paused", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "begin_executing", at: T1 });
    const s3 = applyTransition(s2, { type: "executed", at: T2 });
    // s3.journal[0] is "completed"
    const s4 = applyTransition(s3, {
      type: "resume",
      recordId: "rec1",
      at: T2,
    });
    expect(s4).toBe(s3);
  });

  it("discard_record removes a non-active journal entry", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, { type: "pause", at: T1 });
    const s3 = applyTransition(s2, {
      type: "discard_record",
      recordId: "rec1",
    });
    expect(s3.journal).toHaveLength(0);
  });

  it("discard_record refuses to remove the active pending record", () => {
    const s1 = applyTransition(initialActionState, start());
    const s2 = applyTransition(s1, {
      type: "discard_record",
      recordId: "rec1",
    });
    expect(s2).toBe(s1);
  });
});

describe("action state machine — journal", () => {
  it("hydrate_journal seeds the journal", () => {
    const records: ActionRecord[] = [
      {
        id: "x",
        componentId: "settings",
        actionId: "set_theme",
        args: { theme: "dark" },
        status: "paused",
        startedAt: T0,
        updatedAt: T0,
      },
    ];
    const s = applyTransition(initialActionState, {
      type: "hydrate_journal",
      records,
    });
    expect(s.journal).toEqual(records);
  });

  it("capJournal trims oldest non-paused first", () => {
    let s = initialActionState;
    s = applyTransition(s, start({ recordId: "a" }), { journalCap: 2 });
    s = applyTransition(s, { type: "pause", at: T1 }, { journalCap: 2 });
    s = applyTransition(s, start({ recordId: "b" }), { journalCap: 2 });
    s = applyTransition(s, { type: "begin_executing", at: T1 }, { journalCap: 2 });
    s = applyTransition(s, { type: "executed", at: T2 }, { journalCap: 2 });
    // now journal: [b(completed), a(paused)]
    s = applyTransition(s, start({ recordId: "c" }), { journalCap: 2 });
    // new journal head: c(in_progress) — completed b should be evicted, a paused kept
    expect(s.journal.find((r) => r.id === "a")?.status).toBe("paused");
    expect(s.journal.find((r) => r.id === "b")).toBeUndefined();
    expect(s.journal.find((r) => r.id === "c")?.status).toBe("in_progress");
  });
});

describe("action state machine — selectors", () => {
  it("lastPaused / pausedRecords reflect journal", () => {
    let s = applyTransition(initialActionState, start({ recordId: "a" }));
    s = applyTransition(s, { type: "pause", at: T1 });
    s = applyTransition(s, start({ recordId: "b" }));
    s = applyTransition(s, { type: "pause", at: T2 });
    expect(lastPaused(s)?.id).toBe("b");
    expect(pausedRecords(s).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("deriveMissingFields filters present required keys", () => {
    expect(deriveMissingFields({ a: 1, b: undefined }, ["a", "b", "c"])).toEqual([
      "b",
      "c",
    ]);
    expect(deriveMissingFields({ a: 1 }, [])).toEqual([]);
  });
});
