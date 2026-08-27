import type {
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  CustomTab,
  DigestConfig,
  GridCell,
  LayoutPlan,
  FileTicketBody,
  Ticket,
} from "@freebirdai/core";
import type { ActionState } from "../actions/state.js";
import type { ConfirmActionResult, FreeBirdTransport } from "./types.js";

export interface FetchTransportOptions {
  /** Base URL where `@freebirdai/server` is mounted. Default: `/freebird`. */
  baseUrl?: string;
  /** Extra headers added to every request (auth tokens, etc.). */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /**
   * Returns the current auth token (or `null` for unauthenticated). Resolved
   * before every fetch and SSE stream open. When provided, the transport
   * automatically attaches `Authorization: <authScheme> <token>`.
   */
  getAuthToken?: () => string | null | Promise<string | null>;
  /** Auth scheme used with `getAuthToken`. Default: `"Bearer"`. */
  authScheme?: string;
  /**
   * Called once when a request 401s. Should return a fresh token, or `null`
   * to give up. The transport single-flights concurrent 401s into a single
   * `onUnauthorized()` call, then retries the failing request once.
   *
   * For SSE streams the failing request is the *initial* POST that opens the
   * stream; mid-stream auth rotation is not handled here (see roadmap).
   */
  onUnauthorized?: () => string | null | Promise<string | null>;
  /** Called if a request fails. Useful for global error toasts. */
  onError?: (err: unknown) => void;
  /**
   * Invoked when `getAuthToken()` returns a different value than the previous
   * poll (logout, rotation, login). Use with {@link FreeBirdStore.invalidateAuth}
   * to abort dangling SSE streams.
   */
  onAuthTokenChange?: (
    token: string | null,
    previous: string | null,
  ) => void;
  /** How often to poll `getAuthToken` for changes. Default `5000` ms. Set `0` to disable. */
  authTokenPollMs?: number;
  /** Override the fetch implementation (e.g. for testing). */
  fetch?: typeof fetch;
}

export class TransportUnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "FreeBird transport: unauthorized") {
    super(message);
    this.name = "TransportUnauthorizedError";
  }
}

/**
 * Default HTTP transport. Works against the routes mounted by
 * `@freebirdai/server` (POST /freebird/chat, etc.). Uses SSE for streaming.
 *
 * Auth flow:
 *   1. Before each call, resolve `getAuthToken()` (if configured) and
 *      attach `Authorization: <scheme> <token>`.
 *   2. On a 401 response, single-flight `onUnauthorized()` to get a new
 *      token, then retry the request **once** with the fresh token. A
 *      second 401 surfaces as `TransportUnauthorizedError`.
 *   3. `headers` (static or async) is still applied — useful for tenant
 *      ids, CSRF tokens, etc.
 */
export class FetchTransport implements FreeBirdTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getHeaders: () => Promise<HeadersInit>;
  private readonly onError: (err: unknown) => void;
  private readonly getAuthToken?: () => string | null | Promise<string | null>;
  private readonly authScheme: string;
  private readonly onUnauthorized?: () => string | null | Promise<string | null>;
  /** Single-flight latch for {@link onUnauthorized}. */
  private inflightRefresh: Promise<string | null> | null = null;
  private lastAuthToken: string | null | undefined;
  private authPollTimer: ReturnType<typeof setInterval> | null = null;
  private authBaselineReady = false;

  /** Treat empty strings like missing auth. */
  private normalizeAuthToken(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  constructor(opts: FetchTransportOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "/freebird").replace(/\/+$/, "");
    // Global `fetch` must not be stored unbound — calling it as a plain
    // function throws "Illegal invocation" in browsers.
    const base = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
      base.call(globalThis, input as RequestInfo | URL, init);
    this.onError = opts.onError ?? (() => {});
    const headers = opts.headers;
    this.getHeaders = async () => {
      if (!headers) return {};
      return typeof headers === "function" ? await headers() : headers;
    };
    this.getAuthToken = opts.getAuthToken;
    this.authScheme = opts.authScheme ?? "Bearer";
    this.onUnauthorized = opts.onUnauthorized;
    if (this.getAuthToken && opts.onAuthTokenChange) {
      const pollMs = opts.authTokenPollMs ?? 5000;
      if (pollMs > 0 && typeof setInterval !== "undefined") {
        void Promise.resolve(this.getAuthToken()).then((t: string | null) => {
          this.lastAuthToken = this.normalizeAuthToken(t);
          this.authBaselineReady = true;
        });
        this.authPollTimer = setInterval(() => {
          void this.pollAuthToken(opts.onAuthTokenChange!);
        }, pollMs);
      }
    }
  }

  private async pollAuthToken(
    onChange: (token: string | null, previous: string | null) => void,
  ): Promise<void> {
    if (!this.getAuthToken) return;
    const next = this.normalizeAuthToken(await this.getAuthToken());
    if (!this.authBaselineReady) {
      this.lastAuthToken = next;
      this.authBaselineReady = true;
      return;
    }
    const prev = this.normalizeAuthToken(this.lastAuthToken ?? null);
    if (next === prev) return;
    this.lastAuthToken = next;
    onChange(next, prev);
  }

  /** Build headers for one call. `tokenOverride` lets retries inject a fresh token. */
  private async buildHeaders(
    extra: HeadersInit | undefined,
    tokenOverride?: string | null,
  ): Promise<HeadersInit> {
    const out: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const baseHeaders = await this.getHeaders();
    Object.assign(out, normalizeHeaders(baseHeaders));
    if (extra) Object.assign(out, normalizeHeaders(extra));
    const token =
      tokenOverride !== undefined
        ? this.normalizeAuthToken(tokenOverride)
        : this.getAuthToken
          ? this.normalizeAuthToken(await this.getAuthToken())
          : null;
    if (token) out["Authorization"] = `${this.authScheme} ${token}`;
    return out;
  }

  /**
   * Single-flight: if multiple in-flight requests 401 simultaneously, only
   * one `onUnauthorized()` runs. The rest await the same promise.
   */
  private refreshToken(): Promise<string | null> {
    if (!this.onUnauthorized) return Promise.resolve(null);
    if (!this.inflightRefresh) {
      this.inflightRefresh = Promise.resolve()
        .then(() => this.onUnauthorized!())
        .catch(() => null)
        .finally(() => {
          this.inflightRefresh = null;
        });
    }
    return this.inflightRefresh;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { parse?: "json" | "void" } = {},
  ): Promise<T> {
    try {
      const headers = await this.buildHeaders(init.headers);
      let res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
      if (res.status === 401 && this.onUnauthorized) {
        const fresh = await this.refreshToken();
        if (fresh) {
          const retryHeaders = await this.buildHeaders(init.headers, fresh);
          res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            ...init,
            headers: retryHeaders,
          });
        }
      }
      if (res.status === 401) {
        throw new TransportUnauthorizedError();
      }
      if (!res.ok) {
        throw new Error(
          `FreeBird transport: ${res.status} ${res.statusText}`,
        );
      }
      if (init.parse === "void" || res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  async createSession(input: { title?: string; topic?: string; tags?: string[] }): Promise<ChatSession> {
    return this.request<ChatSession>("/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.request<ChatMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async *streamMessage(input: {
    sessionId: string;
    text: string;
    lockedCells?: GridCell[];
    actionState?: ActionState;
    activeComponentIds?: string[];
    supportContext?: {
      subject?: Record<string, unknown>;
      transcriptExcerpt?: string;
      metadata?: Record<string, unknown>;
    };
    signal?: AbortSignal;
  }): AsyncIterable<ChatStreamEvent> {
    yield* this.sse(
      `/chat`,
      {
        sessionId: input.sessionId,
        text: input.text,
        lockedCells: input.lockedCells,
        actionState: input.actionState,
        activeComponentIds: input.activeComponentIds,
        supportContext: input.supportContext,
      },
      input.signal,
    );
  }

  async fileTicket(
    input: FileTicketBody,
  ): Promise<{ ok: boolean; ticket?: Ticket; error?: string }> {
    return this.request<{ ok: boolean; ticket?: Ticket; error?: string }>(
      "/support/tickets",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async confirmAction(input: {
    sessionId: string;
    recordId: string;
    componentId: string;
    actionId: string;
    args: Record<string, unknown>;
  }): Promise<ConfirmActionResult> {
    return this.request<ConfirmActionResult>("/actions/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async cancelAction(input: {
    sessionId: string;
    recordId: string;
    reason?: string;
  }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/actions/cancel", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateActionArgs(input: {
    sessionId: string;
    recordId: string;
    componentId?: string;
    actionId?: string;
    args: Record<string, unknown>;
  }): Promise<{ ok: boolean; missing: string[]; error?: string }> {
    return this.request<{ ok: boolean; missing: string[]; error?: string }>(
      "/actions/update-args",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async *explainComponent(input: {
    sessionId: string;
    componentId: string;
  }): AsyncIterable<ChatStreamEvent> {
    yield* this.sse(`/chat/explain`, input);
  }

  async getActiveLayout(sessionId: string): Promise<LayoutPlan | null> {
    return this.request<LayoutPlan | null>(
      `/sessions/${encodeURIComponent(sessionId)}/layout`,
    );
  }

  async listTabs(): Promise<CustomTab[]> {
    return this.request<CustomTab[]>("/tabs");
  }

  async saveTab(input: {
    title: string;
    layout: LayoutPlan;
    digest?: DigestConfig;
  }): Promise<CustomTab> {
    return this.request<CustomTab>("/tabs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getTab(id: string): Promise<CustomTab | null> {
    return this.request<CustomTab | null>(`/tabs/${encodeURIComponent(id)}`);
  }

  async updateTab(
    id: string,
    input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>,
  ): Promise<CustomTab> {
    return this.request<CustomTab>(`/tabs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteTab(id: string): Promise<void> {
    await this.request<void>(`/tabs/${encodeURIComponent(id)}`, {
      method: "DELETE",
      parse: "void",
    });
  }

  // -------------------------------------------------------------------------
  // SSE helper
  //
  // Auth on streams: the initial POST that opens the stream goes through the
  // same auth pipeline as `request()` — including the single-flight 401
  // refresh + retry. Once the stream is open, headers are fixed; mid-stream
  // token rotation requires a control-event protocol that's planned for a
  // later release.
  // -------------------------------------------------------------------------
  private async *sse(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamEvent> {
    const accept = { Accept: "text/event-stream" };
    const open = async (tokenOverride?: string | null): Promise<Response> => {
      const headers = await this.buildHeaders(accept, tokenOverride);
      return this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    };

    let res = await open();
    if (res.status === 401 && this.onUnauthorized) {
      const fresh = await this.refreshToken();
      if (fresh) res = await open(fresh);
    }
    if (res.status === 401) {
      try {
        await (res as Response).body?.cancel?.();
      } catch {
        /* noop */
      }
      throw new TransportUnauthorizedError(
        "FreeBird SSE failed: unauthorized",
      );
    }
    if (!res.ok || !res.body) {
      const text = await (res as Response).text?.().catch(() => "");
      throw new Error(`FreeBird SSE failed (${res.status}): ${text}`);
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseEvent(raw);
        if (event) yield event;
      }
    }
  }
}

export const createFetchTransport = (opts?: FetchTransportOptions): FetchTransport =>
  new FetchTransport(opts);

const parseSseEvent = (raw: string): ChatStreamEvent | null => {
  let dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as ChatStreamEvent;
  } catch {
    return null;
  }
};

const normalizeHeaders = (h: HeadersInit): Record<string, string> => {
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return { ...(h as Record<string, string>) };
};
