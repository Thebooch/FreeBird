// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type EmbedConfig } from "./config.js";
import { start } from "./index.js";

/**
 * Routes fetch calls the embed makes during `start()`/`ensureSession()`:
 * handshake, session create, and message history lookup. Body/response
 * shapes are the minimum `EmbedBackend`/`FreeBirdTransport` need to proceed
 * without throwing.
 */
const mockFetch = (opts: { existingMessages?: unknown[] } = {}) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/handshake")) {
      return new Response(JSON.stringify({ token: "tok_test" }), { status: 200 });
    }
    if (url.includes("/sessions/") && url.includes("/messages")) {
      if (opts.existingMessages) {
        return new Response(JSON.stringify(opts.existingMessages), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (url.endsWith("/sessions")) {
      return new Response(JSON.stringify({ id: "new-session-id" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });

const config: EmbedConfig = {
  ...DEFAULT_CONFIG,
  siteId: "fb_test",
  api: "https://api.example.test",
  autoScan: false, // no data-freebird-component markup in these fixtures
};

describe("start() — session persistence across page loads", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a session and stores it in sessionStorage on first load", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const api = start(config);
    // ensureSession is normally lazy (fires on first open/send) — open the
    // widget the way a real visitor would.
    api.open();
    await vi.waitFor(() => expect(api.store.getState().sessionId).toBe("new-session-id"));

    expect(sessionStorage.getItem("freebird:session:fb_test")).toBe("new-session-id");
  });

  it("reuses a stored session id and hydrates history instead of creating a new one", async () => {
    sessionStorage.setItem("freebird:session:fb_test", "existing-session-id");
    const history = [
      {
        id: "m1",
        sessionId: "existing-session-id",
        role: "assistant",
        content: "Welcome back!",
        references: [],
        createdAt: new Date().toISOString(),
      },
    ];
    const fetchMock = mockFetch({ existingMessages: history });
    vi.stubGlobal("fetch", fetchMock);

    const api = start(config);
    api.open();
    await vi.waitFor(() => expect(api.store.getState().sessionId).toBe("existing-session-id"));

    expect(api.store.getState().messages).toHaveLength(1);
    expect(api.store.getState().messages[0]?.content).toBe("Welcome back!");
    // Never called POST /sessions — reused the stored id instead of creating one.
    const calledCreateSession = fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.endsWith("/sessions");
    });
    expect(calledCreateSession).toBe(false);
  });

  it("falls back to creating a new session when the stored one is no longer valid", async () => {
    sessionStorage.setItem("freebird:session:fb_test", "stale-session-id");
    const fetchMock = mockFetch(); // listMessages returns 404 for any id
    vi.stubGlobal("fetch", fetchMock);

    const api = start(config);
    api.open();
    await vi.waitFor(() => expect(api.store.getState().sessionId).toBe("new-session-id"));

    expect(sessionStorage.getItem("freebird:session:fb_test")).toBe("new-session-id");
  });
});
