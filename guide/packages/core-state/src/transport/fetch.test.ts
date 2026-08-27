import { describe, expect, it, vi } from "vitest";
import { FetchTransport, TransportUnauthorizedError } from "./fetch.js";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Build a Response stub matching the shape FetchTransport reads. */
const jsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response;
};

const headerValue = (init: RequestInit | undefined, name: string): string | null => {
  const h = init?.headers;
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) {
    for (const [k, v] of h) if (k.toLowerCase() === name.toLowerCase()) return v;
    return null;
  }
  const obj = h as Record<string, string>;
  for (const k of Object.keys(obj)) if (k.toLowerCase() === name.toLowerCase()) return obj[k] ?? null;
  return null;
};

describe("FetchTransport — auth", () => {
  it("attaches Authorization: Bearer <token> when getAuthToken returns a value", async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse(200, { id: "s1", title: "t", topic: "", tags: [] }),
    );
    const t = new FetchTransport({
      baseUrl: "/freebird",
      getAuthToken: () => "tok-123",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.createSession({ title: "t" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(headerValue(init, "Authorization")).toBe("Bearer tok-123");
  });

  it("supports a custom authScheme", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, []));
    const t = new FetchTransport({
      getAuthToken: async () => "abc",
      authScheme: "Token",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.listMessages("sess-1");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(headerValue(init, "Authorization")).toBe("Token abc");
  });

  it("omits Authorization when getAuthToken returns null", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, []));
    const t = new FetchTransport({
      getAuthToken: () => null,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.listMessages("sess-1");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(headerValue(init, "Authorization")).toBeNull();
  });

  it("calls onUnauthorized once and retries with the fresh token", async () => {
    const tokens = ["stale", "fresh"];
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      const auth = headerValue(init, "Authorization");
      if (auth === "Bearer stale") return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, { ok: true });
    });
    const onUnauthorized = vi.fn(async () => "fresh");
    const t = new FetchTransport({
      getAuthToken: () => tokens.shift() ?? null,
      onUnauthorized,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.listTabs();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1]?.[1];
    expect(headerValue(retryInit, "Authorization")).toBe("Bearer fresh");
  });

  it("single-flights concurrent 401s into one onUnauthorized call", async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url, init) => {
      const auth = headerValue(init, "Authorization");
      if (auth === "Bearer fresh") return jsonResponse(200, []);
      return jsonResponse(401, { error: "expired" });
    });
    let refreshCalls = 0;
    const onUnauthorized = vi.fn(async () => {
      refreshCalls += 1;
      // simulate latency to make sure both calls run concurrently
      await new Promise((r) => setTimeout(r, 5));
      return "fresh";
    });
    const t = new FetchTransport({
      getAuthToken: () => "stale",
      onUnauthorized,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await Promise.all([t.listTabs(), t.listTabs(), t.listTabs()]);
    expect(refreshCalls).toBe(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("throws TransportUnauthorizedError when refresh returns null", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(401, { error: "expired" }));
    const onUnauthorized = vi.fn(async () => null);
    const t = new FetchTransport({
      getAuthToken: () => "stale",
      onUnauthorized,
      onError: () => {},
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(t.listTabs()).rejects.toBeInstanceOf(TransportUnauthorizedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TransportUnauthorizedError if the retry also 401s", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(401, { error: "still bad" }));
    const onUnauthorized = vi.fn(async () => "still-bad");
    const t = new FetchTransport({
      getAuthToken: () => "stale",
      onUnauthorized,
      onError: () => {},
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(t.listTabs()).rejects.toBeInstanceOf(TransportUnauthorizedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TransportUnauthorizedError when no onUnauthorized handler is configured", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(401, { error: "no auth" }));
    const t = new FetchTransport({
      getAuthToken: () => "tok",
      onError: () => {},
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(t.listTabs()).rejects.toBeInstanceOf(TransportUnauthorizedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves additional static headers alongside Authorization", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, []));
    const t = new FetchTransport({
      headers: { "X-Tenant-Id": "acme" },
      getAuthToken: () => "tok",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.listTabs();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(headerValue(init, "Authorization")).toBe("Bearer tok");
    expect(headerValue(init, "X-Tenant-Id")).toBe("acme");
  });
});
