import type { DashboardSpec, LayoutCell } from "@freebirdai/dash-spec";
import { dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { createLayoutSaver, withLayoutCells } from "./layoutSave.js";

const board = (widgetIds: readonly string[]): DashboardSpec =>
  dashboardSchema.parse({
    id: "board",
    title: "Board",
    widgets: widgetIds.map((id) => ({
      id,
      title: id,
      component: "table",
      source: { connection: "c", op: "o" },
    })),
  });

const cell = (widgetId: string, x: number, y: number): LayoutCell => ({
  widgetId,
  x,
  y,
  w: 6,
  h: 6,
  locked: true,
});

/** A scheduler a test drives by hand, so nothing waits a real second. */
const fakeTimer = (): {
  schedule: (run: () => void, ms: number) => number;
  cancel: (handle: number) => void;
  run: () => void;
  pendingCount: () => number;
} => {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (run) => {
      const handle = next++;
      timers.set(handle, run);
      return handle;
    },
    cancel: (handle) => {
      timers.delete(handle);
    },
    run: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    pendingCount: () => timers.size,
  };
};

describe("withLayoutCells", () => {
  it("drops cells for widgets that are no longer on the board", () => {
    const next = withLayoutCells(board(["a", "b"]), [cell("a", 0, 0), cell("gone", 6, 0)]);
    expect(next.layout.cells.map((entry) => entry.widgetId)).toEqual(["a"]);
  });

  it("leaves the rest of the spec alone", () => {
    const original = board(["a"]);
    const next = withLayoutCells(original, [cell("a", 3, 2)]);
    expect(next.layout.gridCols).toBe(12);
    expect(next.widgets).toBe(original.widgets);
    expect(next.title).toBe("Board");
  });
});

describe("createLayoutSaver", () => {
  it("coalesces a burst of edits into one write, keeping the last", () => {
    const timer = fakeTimer();
    const writes: DashboardSpec[] = [];
    const saver = createLayoutSaver({
      put: async (spec) => {
        writes.push(spec);
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    saver.save(board(["a"]), [cell("a", 0, 0)]);
    saver.save(board(["a"]), [cell("a", 4, 0)]);
    saver.save(board(["a"]), [cell("a", 8, 0)]);
    expect(writes).toHaveLength(0);

    timer.run();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.layout.cells[0]?.x).toBe(8);
  });

  it("flush writes what is outstanding and cancels the timer", () => {
    const timer = fakeTimer();
    const writes: DashboardSpec[] = [];
    const saver = createLayoutSaver({
      put: async (spec) => {
        writes.push(spec);
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    saver.save(board(["a"]), [cell("a", 2, 2)]);
    expect(saver.flush()?.layout.cells[0]?.x).toBe(2);
    expect(writes).toHaveLength(1);

    // The scheduled write must not also fire, or the same body goes twice.
    expect(timer.pendingCount()).toBe(0);
    timer.run();
    expect(writes).toHaveLength(1);
  });

  it("flush with nothing pending writes nothing", () => {
    const timer = fakeTimer();
    let calls = 0;
    const saver = createLayoutSaver({
      put: async () => {
        calls++;
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    expect(saver.flush()).toBeNull();
    expect(calls).toBe(0);
  });

  it("cancel drops the pending write entirely", () => {
    const timer = fakeTimer();
    let calls = 0;
    const saver = createLayoutSaver({
      put: async () => {
        calls++;
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    saver.save(board(["a"]), [cell("a", 1, 1)]);
    saver.cancel();
    timer.run();
    expect(calls).toBe(0);
    expect(saver.flush()).toBeNull();
  });

  /*
   * The widgets stay where they were dragged on screen whether or not the save
   * landed, so silence here means the next reload quietly undoes the work and
   * nothing ever said why.
   */
  it("reports a failed save in words the server chose", async () => {
    const timer = fakeTimer();
    const errors: string[] = [];
    const saver = createLayoutSaver({
      put: async () => {
        throw new Error("cell for \"a\" runs past the grid");
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
      onError: (message) => errors.push(message),
    });

    saver.save(board(["a"]), [cell("a", 0, 0)]);
    timer.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['cell for "a" runs past the grid']);
  });
});
