import { describe, expect, it } from "vitest";
import { readWindow } from "./safe-fetch.js";

/* A stream that never ends, read for a window and closed. */

const endless = (events: string[], every: number) => {
  let cancelled = false;
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, every));
      controller.enqueue(encoder.encode(events[index % events.length]!));
      index++;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), cancelled: () => cancelled };
};

describe("reading a stream for a window", () => {
  it("stops at the number of events asked for, keeps only whole events, and closes the stream", async () => {
    const stream = endless(["data: 1\n\n", "data: 2\n", "\ndata: 3\n\ndata: 4", "\n\n"], 1);
    let stopped = false;
    const text = await readWindow(stream.response, { events: 3, seconds: 5 }, 1_000_000, () => {
      stopped = true;
    });
    expect(text).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    expect(stopped).toBe(true);
    expect(stream.cancelled()).toBe(true);
  });

  it("stops at the time asked for, with the events that came", async () => {
    const stream = endless(['data: {"a":1}\n\n'], 400);
    const started = Date.now();
    const text = await readWindow(stream.response, { events: 1000, seconds: 1 }, 1_000_000, () => undefined);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(text.split("\n\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });
});
