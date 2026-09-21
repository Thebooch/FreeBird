import { describe, expect, it } from "vitest";
import { RequestQueue, Wave } from "./queue.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Let every already-resolved microtask run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A queue whose slot timeout can be fired by hand. */
const manualTimers = () => {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    fire: (id: number) => pending.get(id)?.(),
    options: {
      timeout: (run: () => void) => {
        const id = next++;
        pending.set(id, run);
        return id;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
  };
};

describe("RequestQueue", () => {
  it("holds the board to its overall ceiling", async () => {
    const queue = new RequestQueue({ maxConcurrent: 2, maxPerConnection: 99 });
    let active = 0;
    let peak = 0;
    const gates = [0, 1, 2, 3].map(() => deferred<void>());

    const runs = gates.map((one, index) =>
      queue.run(`c${index}`, Wave.Widget, async () => {
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
  });

  it("holds each connection to its own, smaller ceiling", async () => {
    const queue = new RequestQueue({ maxConcurrent: 10, maxPerConnection: 2 });
    let active = 0;
    let peak = 0;
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());

    const runs = gates.map((one) =>
      queue.run("api", Wave.Widget, async () => {
        active++;
        peak = Math.max(peak, active);
        await one.promise;
        active--;
      }),
    );

    await settle();
    // A rate limit belongs to a credential, so the per-connection cap is the
    // one that actually protects anything.
    expect(peak).toBe(2);
    for (const one of gates) {
      one.resolve();
      await settle();
    }
    await Promise.all(runs);
  });

  it("draws visible widgets before fan-out, and fan-out before lookups", async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, maxPerConnection: 1 });
    const order: string[] = [];
    const blocker = deferred<void>();

    const runs = [queue.run("api", Wave.Widget, () => blocker.promise)];
    await settle();

    // Queued worst-first on purpose.
    runs.push(queue.run("api", Wave.Lookup, async () => void order.push("lookup")));
    runs.push(queue.run("api", Wave.FanOut, async () => void order.push("fan-out")));
    runs.push(queue.run("api", Wave.Widget, async () => void order.push("widget")));
    runs.push(queue.run("api", Wave.Forced, async () => void order.push("forced")));
    await settle();

    blocker.resolve();
    await Promise.all(runs);

    // A button somebody just pressed first, then what is blank on screen.
    expect(order).toEqual(["forced", "widget", "fan-out", "lookup"]);
  });

  /*
   * The deadlock this avoids: the front of the queue belongs to a connection
   * already at its cap, so releasing strictly in order would stall every other
   * API behind the busiest one.
   */
  it("skips past queued work whose connection is still full", async () => {
    const queue = new RequestQueue({ maxConcurrent: 2, maxPerConnection: 1 });
    const order: string[] = [];
    const busy = deferred<void>();
    const other = deferred<void>();

    const runs = [
      queue.run("api", Wave.Widget, async () => {
        order.push("api-1");
        await busy.promise;
      }),
      queue.run("other", Wave.Widget, async () => {
        order.push("other-1");
        await other.promise;
      }),
    ];
    await settle();

    // Queued ahead of "other-2", but "api" has no room for it.
    runs.push(queue.run("api", Wave.Widget, async () => void order.push("api-2")));
    runs.push(queue.run("other", Wave.Widget, async () => void order.push("other-2")));
    await settle();

    other.resolve();
    await settle();
    expect(order).toContain("other-2");
    expect(order).not.toContain("api-2");

    busy.resolve();
    await Promise.all(runs);
    expect(order).toContain("api-2");
  });

  it("keeps equal waves in the order they arrived", async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, maxPerConnection: 1 });
    const order: number[] = [];
    const blocker = deferred<void>();
    const runs = [queue.run("api", Wave.Widget, () => blocker.promise)];
    await settle();
    for (const n of [1, 2, 3]) {
      runs.push(queue.run("api", Wave.Widget, async () => void order.push(n)));
    }
    await settle();
    blocker.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the slot when a request fails", async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, maxPerConnection: 1 });
    await expect(
      queue.run("api", Wave.Widget, () => Promise.reject(new Error("429"))),
    ).rejects.toThrow("429");
    await expect(queue.run("api", Wave.Widget, async () => "after")).resolves.toBe("after");
  });

  /*
   * Nothing here can cancel a request, so a hung one would otherwise hold its
   * slot forever and the board would simply stop loading. Degrading to no
   * limiting beats a permanently stalled page.
   */
  it("gives up a slot held too long rather than stalling the board", async () => {
    const timers = manualTimers();
    const queue = new RequestQueue({
      maxConcurrent: 1,
      maxPerConnection: 1,
      ...timers.options,
    });

    const hung = deferred<void>();
    const runs = [queue.run("api", Wave.Widget, () => hung.promise)];
    await settle();

    let secondRan = false;
    runs.push(
      queue.run("api", Wave.Widget, async () => {
        secondRan = true;
      }),
    );
    await settle();
    expect(secondRan).toBe(false);

    timers.fire(1);
    await settle();
    expect(secondRan).toBe(true);

    hung.resolve();
    await Promise.all(runs);
  });

  it("reports what is waiting", async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, maxPerConnection: 1 });
    const blocker = deferred<void>();
    const runs = [queue.run("api", Wave.Widget, () => blocker.promise)];
    await settle();
    runs.push(queue.run("api", Wave.Widget, async () => undefined));
    expect(queue.pending).toBe(1);
    blocker.resolve();
    await Promise.all(runs);
    expect(queue.pending).toBe(0);
  });
});
