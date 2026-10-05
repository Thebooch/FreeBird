import { describe, expect, it } from "vitest";
import { ConnectionGate, Priority } from "./gate.js";

/** A promise plus the handles to settle it from outside. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Let every already-resolved microtask run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("ConnectionGate", () => {
  it("does nothing at all when no limits are set", async () => {
    const gate = new ConnectionGate();
    let started = 0;
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const runs = gates.map((one) =>
      gate.run("api", Priority.Widget, () => {
        started++;
        return one.promise;
      }),
    );
    await settle();
    // The default must change nothing, or every existing test would be
    // asserting against a queue it never asked for.
    expect(started).toBe(3);
    for (const one of gates) one.resolve("done");
    expect(await Promise.all(runs)).toEqual(["done", "done", "done"]);
  });

  it("never runs more than the ceiling at once on one connection", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 2, now: () => 0 });
    let active = 0;
    let peak = 0;
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());

    const runs = gates.map((one) =>
      gate.run("api", Priority.Widget, async () => {
        active++;
        peak = Math.max(peak, active);
        await one.promise;
        active--;
      }),
    );

    await settle();
    expect(peak).toBe(2);
    for (const one of gates) {
      one.resolve();
      await settle();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("counts each connection separately, because a rate limit belongs to one", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 1, now: () => 0 });
    let started = 0;
    const a = deferred<void>();
    const b = deferred<void>();
    const runs = [
      gate.run("api", Priority.Widget, async () => {
        started++;
        await a.promise;
      }),
      gate.run("other", Priority.Widget, async () => {
        started++;
        await b.promise;
      }),
    ];
    await settle();
    // Backing off one API must not slow down an unrelated one.
    expect(started).toBe(2);
    a.resolve();
    b.resolve();
    await Promise.all(runs);
  });

  it("lets a widget overtake queued fan-out and lookup work", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 1, now: () => 0 });
    const order: string[] = [];
    const blocker = deferred<void>();

    const runs = [
      gate.run("api", Priority.Widget, async () => {
        order.push("first");
        await blocker.promise;
      }),
    ];
    await settle();

    // Queued while the first is in flight, deliberately worst-first.
    runs.push(gate.run("api", Priority.Lookup, async () => void order.push("lookup")));
    runs.push(gate.run("api", Priority.Background, async () => void order.push("background")));
    runs.push(gate.run("api", Priority.FanOut, async () => void order.push("fan-out")));
    runs.push(gate.run("api", Priority.Widget, async () => void order.push("widget")));
    await settle();

    blocker.resolve();
    await Promise.all(runs);

    // What somebody is looking at comes off the queue first.
    expect(order).toEqual(["first", "widget", "fan-out", "lookup", "background"]);
  });

  it("keeps equal priorities in the order they arrived", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 1, now: () => 0 });
    const order: number[] = [];
    const blocker = deferred<void>();
    const runs = [gate.run("api", Priority.Widget, () => blocker.promise)];
    await settle();
    for (const n of [1, 2, 3]) {
      runs.push(gate.run("api", Priority.Widget, async () => void order.push(n)));
    }
    await settle();
    blocker.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  /*
   * The failure that would quietly strangle a connection: on this path a
   * refusal is an exception, so a slot leaked on throw is the common case.
   */
  it("releases the slot when a task throws", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 1, now: () => 0 });
    await expect(
      gate.run("api", Priority.Widget, () => Promise.reject(new Error("429"))),
    ).rejects.toThrow("429");
    await expect(gate.run("api", Priority.Widget, async () => "after")).resolves.toBe("after");
  });

  it("spaces starts by the minimum gap", async () => {
    let clock = 0;
    const slept: number[] = [];
    const gate = new ConnectionGate({
      maxConcurrent: 1,
      minGapMs: 200,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await gate.run("api", Priority.Widget, async () => "a");
    // No time has passed on the fake clock, so the second start must wait.
    await gate.run("api", Priority.Widget, async () => "b");
    expect(slept).toEqual([200]);

    clock += 5_000;
    await gate.run("api", Priority.Widget, async () => "c");
    // Long enough since the last start; nothing to wait for.
    expect(slept).toEqual([200]);
  });

  it("reads a ceiling of zero as no limit rather than a deadlock", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 0 });
    await expect(gate.run("api", Priority.Widget, async () => "ran")).resolves.toBe("ran");
  });

  it("reports what is waiting", async () => {
    const gate = new ConnectionGate({ maxConcurrent: 1, now: () => 0 });
    const blocker = deferred<void>();
    const runs = [gate.run("api", Priority.Widget, () => blocker.promise)];
    await settle();
    runs.push(gate.run("api", Priority.Widget, async () => undefined));
    expect(gate.queued("api")).toBe(1);
    expect(gate.queued("other")).toBe(0);
    blocker.resolve();
    await Promise.all(runs);
    expect(gate.queued("api")).toBe(0);
  });
});
