import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Resolved to a public address without touching a real resolver. The guard's
 * own DNS checks have their own tests; what is under test here is the 3xx
 * handling, and a suite that needs the network to prove it would be flaky for
 * a reason that has nothing to do with the code.
 */
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

import { BlockedUrlError, guardedFetch } from "./safe-fetch.js";

/**
 * What the transport lets through, and what it refuses.
 *
 * The 3xx handling is the interesting part and it had a hole in it: 304 is in
 * the redirect range, is not a redirect, and carries no `location` — so every
 * successful conditional request was thrown away as a malformed one. Nothing
 * noticed, because the cache catches a failed refresh and serves the copy it
 * already holds. The symptom was a Refresh button that appeared to work and
 * changed nothing.
 */

const response = (status: number, headers: Record<string, string> = {}, body = ""): Response =>
  ({
    status,
    headers: new Headers(headers),
    text: async () => body,
  }) as unknown as Response;

const original = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.stubGlobal("fetch", original);
  vi.restoreAllMocks();
});

describe("guardedFetch", () => {
  it("passes a 304 through as the answer it is", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response(304, { etag: 'W/"abc"' }));

    const result = await guardedFetch(
      "https://api.example.com/things",
      { headers: { "if-none-match": 'W/"abc"' } },
      "api.example.com",
    );

    expect(result.status).toBe(304);
    expect(result.headers.get("etag")).toBe('W/"abc"');
  });

  it("still refuses a real redirect with no location", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(response(302));
    await expect(
      guardedFetch("https://api.example.com/things", {}, "api.example.com"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("follows a redirect that has one", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(response(302, { location: "https://api.example.com/moved" }))
      .mockResolvedValueOnce(response(200, {}, "[]"));

    const result = await guardedFetch(
      "https://api.example.com/things",
      {},
      "api.example.com",
    );
    expect(result.status).toBe(200);
    expect(result.url).toContain("/moved");
  });

  /* A public host redirecting to a private one is the attack this guard is
   * for, and every hop is re-checked for exactly that reason. */
  it("refuses a redirect that leaves the allowed host", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response(302, { location: "https://elsewhere.example.net/x" }),
    );
    await expect(
      guardedFetch("https://api.example.com/things", {}, "api.example.com"),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
