import { readFileSync, writeFileSync } from "node:fs";
import type { HttpFetch, HttpResponse } from "@freebirdai/connect/adapters";
import { fetchPublicDocument, guardedFetch } from "@freebirdai/connect/host";
import type { BenchResponse, IntegrationEnv, MockProvider } from "./types.js";

/**
 * How the benchmark reaches its providers: in-process, with nothing on the
 * network.
 *
 * Both of the server's transports are replaced: `http` for account reads, and
 * `fetchDocument` for the documentation discovery reads. Anything addressed to
 * a host no provider answers for is refused as unreachable, the way the real
 * guard refuses a private address — so a run can never leak to the internet,
 * and a stray request shows up as a failure rather than a slow success.
 */

export interface BenchTransport {
  readonly http: HttpFetch;
  readonly fetchDocument: IntegrationEnv["fetchDocument"];
  /** Every request made, in order, as method and URL. */
  readonly log: string[];
  /** Requests that reached a provider's API (not its docs). */
  readonly apiRequests: () => number;
}

const textOf = (body: unknown): string => (typeof body === "string" ? body : JSON.stringify(body));

const lowered = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

const toResponse = (url: string, answer: BenchResponse): HttpResponse => {
  const headers = lowered(answer.headers ?? {});
  return {
    status: answer.status,
    text: textOf(answer.body),
    url,
    header: (name) => headers[name.toLowerCase()] ?? null,
  };
};

export const benchTransport = (providers: readonly MockProvider[]): BenchTransport => {
  const byHost = new Map<string, MockProvider>();
  for (const provider of providers) for (const host of provider.hosts) byHost.set(host, provider);
  const log: string[] = [];
  let api = 0;

  const route = (method: string, raw: string, headers: Record<string, string>, body?: string) => {
    const url = new URL(raw);
    log.push(`${method} ${url.toString()}`);
    const provider = byHost.get(url.hostname);
    if (!provider) throw new Error(`unreachable: ${url.hostname} is not a benchmark provider`);
    return provider.handle({ method, url, headers: lowered(headers), body });
  };

  const http: HttpFetch = async (raw, init, allowedHost) => {
    const url = new URL(raw);
    /* The same pin the real transport enforces: a connection reads its own host only. */
    if (allowedHost && url.hostname !== allowedHost && !url.hostname.endsWith(`.${allowedHost}`))
      throw new Error(`refused: ${url.hostname} is not ${allowedHost}`);
    api++;
    return toResponse(raw, route(init.method ?? "GET", raw, init.headers, init.body));
  };

  const fetchDocument: IntegrationEnv["fetchDocument"] = async (raw) => {
    try {
      const answer = route("GET", raw, {});
      return { status: answer.status, text: textOf(answer.body), url: raw };
    } catch {
      return { status: 404, text: "", url: raw };
    }
  };

  return { http, fetchDocument, log, apiRequests: () => api };
};

/**
 * The network, for real providers: the server's own SSRF guard, and only the
 * hosts the scenario's providers name. Anything else is refused before it is
 * sent, as a request to an unknown provider is in-process.
 */
export const liveTransport = (providers: readonly MockProvider[]): BenchTransport => {
  const hosts = new Set(providers.flatMap((provider) => provider.hosts));
  const log: string[] = [];
  let api = 0;
  const allowed = (raw: string): URL => {
    const url = new URL(raw);
    if (!hosts.has(url.hostname)) throw new Error(`unreachable: ${url.hostname} is not one of this scenario's hosts`);
    return url;
  };

  const http: HttpFetch = async (raw, init, allowedHost) => {
    allowed(raw);
    log.push(`${init.method ?? "GET"} ${raw}`);
    api++;
    const result = await guardedFetch(raw, init, allowedHost);
    return { status: result.status, text: result.text, url: result.url, header: (name) => result.headers.get(name) };
  };

  const fetchDocument: IntegrationEnv["fetchDocument"] = async (raw) => {
    try {
      allowed(raw);
      log.push(`GET ${raw}`);
      const result = await fetchPublicDocument(raw);
      return { status: result.status, text: result.text, url: result.url };
    } catch {
      return { status: 404, text: "", url: raw };
    }
  };

  return { http, fetchDocument, log, apiRequests: () => api };
};

/* ── Record and replay, for real APIs ────────────────────────────────────── */

interface Recording {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
}

/** Query parameters that commonly carry a credential; masked in every recording. */
const SECRET_PARAMS = /^(api[_-]?key|key|token|access[_-]?token|secret|signature|sig)$/i;

const sanitizedUrl = (raw: string): string => {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()])
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, "REDACTED");
  return url.toString();
};

/**
 * Record a real API once, for replay offline.
 *
 * Kept: the method, the URL with credentials masked, the status, the
 * response headers a reader uses (paging, content type) and the body — a
 * benchmark corpus is public data, and a value-bearing recording is what lets
 * pagination and totals be replayed. Never kept: request headers, which is
 * where credentials travel. Only ever point this at a benchmark corpus, or at
 * an account whose owner has agreed to its data being written to disk.
 */
export const recordingHttp = (real: HttpFetch, file: string): HttpFetch & { save(): void } => {
  const recorded: Recording[] = [];
  const http: HttpFetch = async (url, init, allowedHost) => {
    const response = await real(url, init, allowedHost);
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "link", "x-total-count", "etag", "last-modified"]) {
      const value = response.header(name);
      if (value !== null) headers[name] = value;
    }
    recorded.push({
      method: init.method ?? "GET",
      url: sanitizedUrl(url),
      status: response.status,
      headers,
      text: response.text,
    });
    return response;
  };
  return Object.assign(http, { save: () => writeFileSync(file, JSON.stringify(recorded, null, 2)) });
};

/** Replay a recording: each request gets the recorded answer for its method and masked URL. */
export const replayHttp = (file: string): HttpFetch => {
  const recorded = JSON.parse(readFileSync(file, "utf8")) as Recording[];
  const byKey = new Map(recorded.map((one) => [`${one.method} ${one.url}`, one]));
  return async (url, init) => {
    const found = byKey.get(`${init.method ?? "GET"} ${sanitizedUrl(url)}`);
    if (!found) throw new Error(`not in the recording: ${init.method ?? "GET"} ${sanitizedUrl(url)}`);
    return {
      status: found.status,
      text: found.text,
      url,
      header: (name) => found.headers[name.toLowerCase()] ?? null,
    };
  };
};
