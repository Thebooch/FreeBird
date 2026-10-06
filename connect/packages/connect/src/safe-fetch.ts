import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
 * Where requests may go: a plug-in point, public addresses
 * only unless the operator says otherwise.
 *
 * A self-hosted instance often needs an API on its own network — an ERP in
 * the office, a service on a VPN. The operator names those addresses
 * (`DASH_PRIVATE_EGRESS`: hostnames, `*.suffix`, CIDR ranges), and a
 * connection that should reach one says so itself (`privateNetwork`), visibly.
 * Both are needed. Link-local addresses — where cloud metadata lives — are
 * never reachable, however they are listed. The address checked is the
 * address connected to: a private one is pinned for the request, so a name
 * that resolves differently a moment later cannot be used to slip past.
 */
export interface EgressPolicy {
  /** Whether a private address may be reached, for a request that opted in. */
  allowsPrivate(hostname: string, address: string): boolean;
  /** How the operator's allowance reads, for a refusal to name. */
  readonly described: string | null;
}

const V6_LINK_LOCAL = /^fe[89ab]/i;

const cidrMatch = (address: string, cidr: string): boolean => {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits);
  const value = v4ToInt(address);
  const start = base ? v4ToInt(base) : null;
  if (value === null || start === null || !Number.isInteger(mask) || mask < 0 || mask > 32) return false;
  return mask === 0 || inRange(value, start, mask);
};

/** The open-source default: nothing private, ever. */
export const publicOnlyEgress: EgressPolicy = { allowsPrivate: () => false, described: null };

/** An operator's list of private places a connection may reach, from `DASH_PRIVATE_EGRESS`. */
export const allowlistEgress = (list: string): EgressPolicy => {
  const entries = list
    .split(/[\s,]+/)
    .map((one) => one.trim().toLowerCase())
    .filter((one) => one !== "");
  return {
    described: entries.join(", "),
    allowsPrivate: (hostname, address) => {
      const host = hostname.toLowerCase();
      /* Link-local, and so cloud metadata, is never on anybody's list. */
      if (/^169\.254\./.test(address) || V6_LINK_LOCAL.test(address)) return false;
      return entries.some((entry) =>
        entry.includes("/")
          ? cidrMatch(address, entry)
          : entry.startsWith("*.")
            ? host.endsWith(entry.slice(1))
            : host === entry || address === entry,
      );
    },
  };
};

let egress: EgressPolicy = publicOnlyEgress;

/** Set once, at start: see `createLocalPlatform`. */
export const configureEgress = (policy: EgressPolicy): void => {
  egress = policy;
};

/**
 * An address a request may be sent to, and the address to connect to when it
 * is a private one. Public addresses are checked as they always were.
 */
export const assertReachable = async (raw: string, privateNetwork: boolean): Promise<{ url: URL; pinned?: string }> => {
  if (!privateNetwork) return { url: await assertPublicHttpUrl(raw) };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("that doesn't look like a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedUrlError("only http(s) urls can be fetched");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = (await lookup(hostname, { all: true })).map((entry) => entry.address);
    } catch {
      throw new BlockedUrlError(`couldn't resolve ${hostname}`);
    }
  }
  if (addresses.length === 0) throw new BlockedUrlError(`couldn't resolve ${hostname}`);
  if (addresses.every((address) => !isPrivateIp(address))) return { url };
  const allowed = addresses.find((address) => !isPrivateIp(address) || egress.allowsPrivate(hostname, address));
  if (!allowed)
    throw new BlockedUrlError(
      egress.described
        ? `${hostname} is on a private network that is not in this server's allowance (${egress.described}).`
        : `${hostname} is on a private network, and this server reaches none: its operator can name private addresses in DASH_PRIVATE_EGRESS.`,
    );
  return { url, pinned: allowed };
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
  init: GuardedInit,
  allowedHost: string | null,
): Promise<GuardedFetchResult> => fetchGuarded(rawUrl, init, (url) => assertAllowedHost(url, allowedHost));

/**
 * What a request sends. `method` and `body` exist for writes; everything that
 * reads leaves them out and sends a GET exactly as before.
 */
export interface GuardedInit {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly method?: string;
  readonly body?: string;
  /** See `HttpFetch`'s init: a read sent with POST says it reads. */
  readonly purpose?: "read" | "write";
  /** A client certificate to present (mutual TLS), PEM. See `sendWithCertificate`. */
  readonly clientCertificate?: { readonly cert: string; readonly key: string; readonly ca?: string };
  /** A stream read for a window: see `readWindow`. */
  readonly stream?: { readonly events: number; readonly seconds: number };
  /** The connection says it is on a private network: see `EgressPolicy`. */
  readonly privateNetwork?: boolean;
}

/**
 * One request presenting a client certificate (mutual TLS),
 * answered as a standard `Response` so the guarded loop around it — public
 * addresses only, the connection's own host on every redirect hop, the size
 * cap — is the same one every other request goes through. Over https only:
 * a certificate is never offered to a plain connection. No connection is
 * pooled, so a certificate is never reused for a request that did not ask.
 */
export const sendWithCertificate = (
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | undefined;
    readonly signal: AbortSignal;
    /** `ca`: the provider's own certificate authority, where its server is not signed by a public one. */
    readonly certificate: { readonly cert: string; readonly key: string; readonly ca?: string };
  },
): Promise<Response> => sendDirect(url, init);

/**
 * One request through Node's own client rather than `fetch`: for a client
 * certificate, and for an address checked once and connected to as checked
 * (`pinned`) — the name is never looked up a second time.
 */
export const sendDirect = (
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | undefined;
    readonly signal: AbortSignal;
    readonly certificate?: { readonly cert: string; readonly key: string; readonly ca?: string };
    readonly pinned?: string;
  },
): Promise<Response> =>
  new Promise((resolve, reject) => {
    if (init.certificate && url.protocol !== "https:") {
      reject(new BlockedUrlError("a client certificate is only sent over https"));
      return;
    }
    const pinned = init.pinned;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method: init.method,
        headers: init.headers,
        ...(init.certificate
          ? { cert: init.certificate.cert, key: init.certificate.key, ...(init.certificate.ca ? { ca: init.certificate.ca } : {}) }
          : {}),
        ...(pinned
          ? {
              lookup: (_host: string, options: unknown, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
                const family = isIP(pinned);
                if ((options as { all?: boolean } | undefined)?.all) callback(null, [{ address: pinned, family }]);
                else callback(null, pinned, family);
              },
            }
          : {}),
        agent: false,
        signal: init.signal,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) incoming.destroy(new BlockedUrlError(`response from ${url.toString()} is too large`));
          else chunks.push(chunk);
        });
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const one of value) headers.append(name, one);
            else if (value !== undefined) headers.set(name, String(value));
          }
          const status = incoming.statusCode ?? 502;
          const empty = status === 204 || status === 205 || status === 304;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
        });
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    if (init.body !== undefined) outgoing.write(init.body);
    outgoing.end();
  });

/**
 * Failures that happen before a request leaves this machine.
 *
 * A write that failed here changed nothing, and can say so. Any other
 * failure — a timeout, a dropped connection, a body that could not be read —
 * may have happened after the API acted, and saying "nothing changed" then
 * would be a guess presented as a fact.
 */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/** Marks an error as one that happened before anything was sent. */
export const notSent = <T extends Error>(error: T): T & { readonly notSent: true } =>
  Object.assign(error, { notSent: true as const });

const failedBeforeSending = (error: unknown): boolean => {
  if (error instanceof BlockedUrlError) return true;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && NOT_SENT_CODES.has(cause.code);
};

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
  init: GuardedInit,
  checkHost: (url: URL) => void,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<GuardedFetchResult> => {
  const method = (init.method ?? "GET").toUpperCase();
  /*
   * A read sent with POST is still a read — a failure before it left is not a
   * "change not sent" — but it is never redirected: following one would send
   * its body to a second address.
   */
  const reading = init.purpose ? init.purpose === "read" : method === "GET";
  const follows = method === "GET";
  let current: URL;
  /* The private address a request connects to, once checked: never looked up again. */
  let pinned: string | undefined;
  try {
    const reached = await assertReachable(rawUrl, init.privateNetwork === true);
    current = reached.url;
    pinned = reached.pinned;
    checkHost(current);
  } catch (error) {
    throw reading || !(error instanceof Error) ? error : notSent(error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  init.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        const headers = {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "user-agent": "FreeBirdDash/0.1 (+https://github.com/Thebooch/FreeBird)",
          ...init.headers,
        };
        const body = method === "GET" || init.body === undefined ? undefined : init.body;
        response = init.clientCertificate || pinned
          ? await sendDirect(current, {
              method,
              headers,
              body,
              signal: controller.signal,
              ...(init.clientCertificate ? { certificate: init.clientCertificate } : {}),
              ...(pinned ? { pinned } : {}),
            })
          : await fetch(current.toString(), {
              method,
              redirect: "manual",
              signal: controller.signal,
              headers,
              ...(body === undefined ? {} : { body }),
            });
      } catch (error) {
        if (!reading && error instanceof Error && failedBeforeSending(error)) throw notSent(error);
        throw error;
      }

      /*
       * A change is never sent twice. A redirect answering a write is handed
       * back as it is: following it would mean sending the body again to a
       * second address, and a 303 after a POST can mean the API already did
       * what was asked. The caller says so rather than guessing which.
       */
      if (!follows && response.status >= 300 && response.status < 400) {
        return { status: response.status, headers: response.headers, text: "", url: current.toString() };
      }

      /*
       * 304 is in the 3xx range and is not a redirect.
       *
       * It is the answer to a conditional request — "what you have is still
       * current" — and it carries no `location`, so the redirect branch threw
       * `redirect without a location (304)` on every successful
       * revalidation. The cache then caught a non-adapter error, served the
       * copy it already had and labelled it stale, which is why a refresh
       * could appear to do nothing and why the `notModified` counter had
       * never once been above zero. The cheapest possible answer an API can
       * give was the one thing this could not accept.
       */
      if (response.status !== 304 && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new BlockedUrlError(`redirect without a location (${response.status})`);
        if (hop === MAX_REDIRECTS) throw new BlockedUrlError("too many redirects");
        // A public host can redirect to a private one — re-validate every hop.
        const next = await assertReachable(new URL(location, current).toString(), init.privateNetwork === true);
        checkHost(next.url);
        current = next.url;
        pinned = next.pinned;
        continue;
      }

      const streaming = init.stream && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
      const text = streaming
        ? await readWindow(response, init.stream!, maxBytes, () => controller.abort())
        : await readCapped(response, maxBytes, current.toString());
      return { status: response.status, headers: response.headers, text, url: current.toString() };
    }
    throw new BlockedUrlError("too many redirects");
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A stream of server-sent events, read for a window: until this many events
 * have arrived or this many seconds have passed, then the connection is
 * closed. Only whole events are kept — one cut off by the window is not half
 * a record.
 */
export const readWindow = async (
  response: Response,
  window: { readonly events: number; readonly seconds: number },
  maxBytes: number,
  stop: () => void,
): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const ends = () => (text.replace(/\r\n?/g, "\n").match(/\n\n/g) ?? []).length;
  const deadline = Date.now() + window.seconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  try {
    while (ends() < window.events && text.length < maxBytes) {
      const chunk = await Promise.race([reader.read(), late]);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    stop();
    void reader.cancel().catch(() => undefined);
  }
  const normal = text.replace(/\r\n?/g, "\n");
  const last = normal.lastIndexOf("\n\n");
  return last < 0 ? "" : normal.slice(0, last + 2);
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
