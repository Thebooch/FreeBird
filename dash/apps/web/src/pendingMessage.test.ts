import { describe, expect, it } from "vitest";
import { createPendingMessage } from "./pendingMessage.js";

/**
 * One click, one message.
 *
 * The failure this guards cost real money before it was noticed: the column
 * sent "I want to add a new widget." from an effect and relied on a later
 * render to stop it sending again, and the chat store re-rendered the column
 * first — so one click became dozens of chat turns running side by side.
 */
describe("a message the shell says on the user's behalf", () => {
  it("is handed to the first caller only", () => {
    const pending = createPendingMessage(() => {});
    pending.arm("I want to add a new widget.");

    expect(pending.take()).toBe("I want to add a new widget.");
    // The re-render that used to send it again, holding the same stale prop.
    expect(pending.take()).toBeNull();
    expect(pending.take()).toBeNull();
  });

  it("empties the slot in the same step it is claimed, not on a later render", () => {
    const seen: (string | null)[] = [];
    const pending = createPendingMessage((text) => seen.push(text));
    pending.arm("hello");

    let sends = 0;
    // Two effect runs back to back, before anything could re-render.
    for (let run = 0; run < 2; run++) if (pending.take()) sends++;

    expect(sends).toBe(1);
    expect(seen).toEqual(["hello", null]);
  });

  it("can be armed again by a second click", () => {
    const pending = createPendingMessage(() => {});
    pending.arm("I want to add a new widget.");
    pending.take();
    pending.arm("I want to add a new widget.");
    expect(pending.take()).toBe("I want to add a new widget.");
  });

  it("does not announce a change when there was nothing to take", () => {
    const seen: (string | null)[] = [];
    const pending = createPendingMessage((text) => seen.push(text));
    expect(pending.take()).toBeNull();
    expect(seen).toEqual([]);
  });
});
