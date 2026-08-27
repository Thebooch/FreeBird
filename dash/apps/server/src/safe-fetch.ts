import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard, ported from FreeBird Studio's `safe-fetch.ts` (MIT, same author).
 *
 * Users supply base URLs, so sooner or later someone points one at
 * `169.254.169.254` or an internal service. Private, link-local, loopback and
 * metadata ranges are rejected *after* DNS resolution, redirects are followed
 * manually with every hop re-validated, and responses are time- and
 * size-capped.
 *
 * Dash adds a second gate on top of this one: a connection may only reach its
 * own declared host. See `assertAllowedHost`.
 */

export class BlockedUrlError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const inRange = (ip: number, base: number, maskBits: number): boolean =>
  ip >>> (32 - maskBits) === base >>> (32 - maskBits);

const v4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value;
};

const isPrivateV4 = (ip: string): boolean => {
  const value = v4ToInt(ip);
  if (value === null) return true; // unparseable — treat as hostile
  return (
    inRange(value, v4ToInt("0.0.0.0")!, 8) ||
    inRange(value, v4ToInt("10.0.0.0")!, 8) ||
    inRange(value, v4ToInt("100.64.0.0")!, 10) || // CGNAT
    inRange(value, v4ToInt("127.0.0.0")!, 8) ||
    inRange(value, v4ToInt("169.254.0.0")!, 16) || // link-local + cloud metadata
    inRange(value, v4ToInt("172.16.0.0")!, 12) ||
    inRange(value, v4ToInt("192.0.0.0")!, 24) ||
    inRange(value, v4ToInt("192.168.0.0")!, 16) ||
    inRange(value, v4ToInt("198.18.0.0")!, 15) || // benchmarking
    value >>> 28 >= 0xe // multicast 224/4 + reserved 240/4
  );
};

export const isPrivateIp = (ip: string): boolean => {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (lower === "::" || lower === "::1") return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
};

export const assertPublicHttpUrl = async (raw: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("that doesn't look like a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedUrlError("only http(s) urls can be fetched");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new BlockedUrlError("that address isn't reachable from here");
    return url;
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new BlockedUrlError("that address isn't reachable from here");
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`couldn't resolve ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new BlockedUrlError("that address isn't reachable from here");
  }
  return url;
};

/**
 * The second gate: a connection may only ever reach the host its own baseUrl
 * declares. Even a hallucinated or tampered op cannot be pointed elsewhere.
 */
export const assertAllowedHost = (url: URL, allowedHost: string | null): void => {
  if (!allowedHost) throw new BlockedUrlError("this connection has no base URL");
  const host = url.hostname.toLowerCase();
  if (host !== allowedHost && !host.endsWith(`.${allowedHost}`)) {
    throw new BlockedUrlError(
      `this connection may only reach ${allowedHost}, not ${host}`,
    );
  }
};

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 8_000_000;

/**
 * Discovery reads documents, not data, and documentation pages are far bigger
 * than any API response has cause to be — a docs site that inlines its own
 * OpenAPI spec routinely clears 10 MB, because a 2 MB spec becomes 10 MB of
 * HTML once it is JSON-escaped into a script tag.
 *
 * Rejecting those throws away an exact, machine-readable description of the
 * API, which is the single most valuable thing discovery can find. The larger
 * ceiling applies only to `fetchPublicDocument`; every data-fetching call keeps
 * the tighter one.
 */
export const MAX_DOCUMENT_BYTES = 40_000_000;

export interface GuardedFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly url: string;
}

/**
 * The only function in the server that fetches a user-supplied URL. Guards the
 * initial URL and every redirect hop, against both the SSRF ranges and the
 * connection's own allowlist.
 */
export const guardedFetch = async (
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  allowedHost: string | null,
): Promise<GuardedFetchResult> => fetchGuarded(rawUrl, init, (url) => assertAllowedHost(url, allowedHost));

/**
 * Fetch a document for *discovery* — an OpenAPI spec or a docs page the user
 * just typed in.
 *
 * There is no connection yet, so there is no host to pin to; the SSRF guard is
 * still the whole defence. This is deliberately a separate entry point rather
 * than a `null` allowlist on `guardedFetch`, so that no data-fetching call can
 * ever accidentally lose its host restriction.
 */
export const fetchPublicDocument = async (
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<GuardedFetchResult> =>
  fetchGuarded(rawUrl, init, () => undefined, MAX_DOCUMENT_BYTES);

const fetchGuarded = async (
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  checkHost: (url: URL) => void,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<GuardedFetchResult> => {
  let current = await assertPublicHttpUrl(rawUrl);
  checkHost(current);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  init.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "user-agent": "FreeBirdDash/0.1 (+https://github.com/Thebooch/FreeBird)",
          ...init.headers,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new BlockedUrlError(`redirect without a location (${response.status})`);
        if (hop === MAX_REDIRECTS) throw new BlockedUrlError("too many redirects");
        // A public host can redirect to a private one — re-validate every hop.
        const next = await assertPublicHttpUrl(new URL(location, current).toString());
        checkHost(next);
        current = next;
        continue;
      }

      const text = await readCapped(response, maxBytes, current.toString());
      return { status: response.status, headers: response.headers, text, url: current.toString() };
    }
    throw new BlockedUrlError("too many redirects");
  } finally {
    clearTimeout(timer);
  }
};

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)}MB`;

/**
 * Errors name the URL and both sizes. One warning saying "response is too
 * large" among two dozen attempted URLs tells the user nothing they can act on.
 */
const readCapped = async (response: Response, maxBytes: number, url: string): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new BlockedUrlError(
      `${url} is too large to read (${megabytes(declared)}, limit ${megabytes(maxBytes)})`,
    );
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new BlockedUrlError(
      `${url} is too large to read (${megabytes(text.length)}, limit ${megabytes(maxBytes)})`,
    );
  }
  return text;
};
