import { createHash, createHmac } from "node:crypto";
import { parseXml, type HttpFetch } from "@freebirdai/dash-adapters";
import type { ConnectionSpec, ConnectorDestination, ConnectorSpec, OpSpec } from "@freebirdai/dash-spec";

/**
 * Everything a connector's code can do outside the sandbox, decided here.
 *
 * The code asks; this answers or refuses. Each request is checked against the
 * connector's authority before anything leaves: the address must be one it
 * lists, the method one that address allows, and every credential the request
 * would carry one that address is bound to. The code never holds a credential
 * — it names one (`{{secret:name}}`), or asks for a signature made with one,
 * and the value is put in here, on the way out, for an address allowed it.
 *
 * What comes back is cleaned the same way: any credential an API echoes is
 * taken out of the answer before the code sees it.
 *
 * Not proof of containment — see the residual risks in `dash/PLATFORM.md`.
 */

/** A token a login answered with, as kept between runs. */
export interface KeptToken {
  readonly value: string;
  /** Epoch milliseconds; null when the API did not say. */
  readonly expiresAt: number | null;
  /** The non-secret fields the connector is allowed to see, from the same answer. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Where a connector's session tokens are kept. A plug-in point: memory in
 * tests and the benchmark, the vault (with expiry beside it) in the server.
 */
export interface ConnectorTokenStore {
  get(keyRef: string): Promise<KeptToken | null>;
  put(keyRef: string, connection: string, token: KeptToken): Promise<void>;
  forget(keyRef: string): Promise<void>;
}

export class MemoryConnectorTokens implements ConnectorTokenStore {
  private readonly tokens = new Map<string, KeptToken>();
  async get(keyRef: string): Promise<KeptToken | null> {
    return this.tokens.get(keyRef) ?? null;
  }
  async put(keyRef: string, _connection: string, token: KeptToken): Promise<void> {
    this.tokens.set(keyRef, token);
  }
  async forget(keyRef: string): Promise<void> {
    this.tokens.delete(keyRef);
  }
}

/** One request a run sent, or tried to: for the journal, the check's log, and whoever reviews it. */
export interface ConnectorRequestEvent {
  readonly method: string;
  readonly host: string;
  /** The path only: a query string can carry a credential. */
  readonly path: string;
  readonly status: number | null;
  readonly purpose: "read" | "exchange" | "download";
  readonly refused?: string;
}

/** Refused by the authority. The code sees the message; nothing was sent. */
export class ConnectorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorRefusal";
  }
}

export interface ConnectorHostDeps {
  readonly connection: ConnectionSpec;
  readonly connector: ConnectorSpec;
  /** The endpoint this run is for, when it is for one. */
  readonly op?: OpSpec | undefined;
  readonly http: HttpFetch;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly tokens: ConnectorTokenStore;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
  readonly onRequest?: ((event: ConnectorRequestEvent) => void) | undefined;
}

export interface ConnectorHost {
  call(name: string, args: unknown): Promise<unknown>;
  now(): number;
  log(line: string): void;
  readonly trace: readonly ConnectorRequestEvent[];
  readonly logs: readonly string[];
  requests(): number;
  /** Takes every credential value this run has seen out of `text`. */
  redact(text: string): string;
}

const SLOT = /\{\{\s*secret:([a-z][a-z0-9_]{0,31})\s*\}\}/g;
const MAX_TEXT = 16_000_000;
const MAX_DATA = 1_000_000;
/** Shorter than this, a value is too likely to appear by chance to be searched for. */
const MIN_SECRET = 4;
const HASHES = new Set(["sha256", "sha1", "sha512", "md5"]);
/** Words that name a secret: a credential called one is never handed to code, whatever it declares. */
const SECRET_WORDS = /secret|password|passphrase|passwd|private|token|signing/i;
const HMACS = new Set(["sha256", "sha1", "sha512"]);
const ENCODINGS = new Set(["hex", "base64", "base64url"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, what: string, max = MAX_DATA): string => {
  if (typeof value !== "string") throw new ConnectorRefusal(`${what} must be text`);
  if (value.length > max) throw new ConnectorRefusal(`${what} is longer than allowed`);
  return value;
};

/** `$.a.b[0]` into a parsed answer. */
const at = (value: unknown, path: string): unknown => {
  const steps = path
    .replace(/^\$\.?/, "")
    .split(/\.|\[(\d+)\]/)
    .filter((step): step is string => step !== undefined && step !== "");
  let here = value;
  for (const step of steps) {
    if (!isRecord(here) && !Array.isArray(here)) return undefined;
    here = (here as Record<string, unknown>)[step];
  }
  return here;
};

/** Every https address in an answer, for knowing which downloads the API itself handed out. */
const addressesIn = (body: string): string[] => {
  const found: string[] = [];
  for (const match of body.replace(/\\\//g, "/").matchAll(/https:\/\/[^\s"'<>\\,)\]}]+/g)) {
    try {
      found.push(new URL(match[0]).href);
    } catch {
      /* not an address */
    }
  }
  return found;
};

export const createConnectorHost = (deps: ConnectorHostDeps): ConnectorHost => {
  const { connection, connector } = deps;
  const authority = connector.authority;
  const auth: { credentials: Extract<ConnectionSpec["auth"], { type: "connector" }>["credentials"]; tokens: Extract<ConnectionSpec["auth"], { type: "connector" }>["tokens"] } =
    connection.auth.type === "connector" ? connection.auth : { credentials: [], tokens: [] };
  /** Values the connector declared identifiers, never named like a secret: readable by the code. */
  const identifiers = new Set(
    auth.credentials
      .filter((one) => one.secret === false && !SECRET_WORDS.test(`${one.name} ${one.label ?? ""}`))
      .map((one) => one.name),
  );
  const trace: ConnectorRequestEvent[] = [];
  const logs: string[] = [];
  /** Every credential value resolved in this run, by name: for redaction and for spotting a leak. */
  const values = new Map<string, string>();
  /** Signatures made in this run, and whose credential made each. */
  const signatures: { value: string; root: string }[] = [];
  const derived = new Map<string, { key: Buffer; root: string }>();
  /** Addresses the API answered with: the only ones a download may go to. */
  const handedOut = new Set<string>();
  let sent = 0;
  let slept = 0;

  const note = (event: ConnectorRequestEvent) => {
    trace.push(event);
    deps.onRequest?.(event);
  };

  const redact = (input: string): string => {
    let out = input;
    for (const value of values.values()) if (value.length >= MIN_SECRET) out = out.split(value).join("[redacted]");
    return out;
  };

  /** A credential or a token, by the name the code uses. Null when there is none (yet). */
  const valueOf = async (name: string): Promise<string | null> => {
    if (values.has(name)) return values.get(name)!;
    const credential = auth.credentials.find((one) => one.name === name);
    if (credential) {
      const value = await deps.resolveSecret(credential.keyRef);
      if (value && !identifiers.has(name)) values.set(name, value);
      return value;
    }
    const token = auth.tokens.find((one) => one.name === name);
    if (token) {
      const kept = await deps.tokens.get(token.keyRef);
      if (!kept) return null;
      if (kept.expiresAt !== null && kept.expiresAt <= deps.now()) return null;
      values.set(name, kept.value);
      return kept.value;
    }
    return null;
  };

  /*
   * Every secret the connection holds, resolved up front so that none can slip
   * past the checks unseen. An identifier is not a secret — the code may read
   * it — so it is neither searched for nor taken out of answers.
   */
  let primed: Promise<void> | null = null;
  const prime = () =>
    (primed ??= (async () => {
      for (const one of [...auth.credentials, ...auth.tokens]) await valueOf(one.name);
    })());

  const destinationFor = (url: URL): ConnectorDestination => {
    if (url.protocol !== "https:") throw new ConnectorRefusal(`only https addresses may be reached, not ${url.protocol}`);
    const destination = authority.destinations.find((one) => one.host === url.hostname.toLowerCase());
    if (!destination)
      throw new ConnectorRefusal(`${url.hostname} is not an address this connector may reach`);
    if (destination.ops && deps.op && !destination.ops.includes(deps.op.id))
      throw new ConnectorRefusal(`${url.hostname} may not be reached while reading ${deps.op.title}`);
    return destination;
  };

  /**
   * Whether anything this request carries belongs to a credential the address
   * is not bound to: a signature made with it, or the value itself.
   */
  const assertNoLeak = (request: string, destination: ConnectorDestination) => {
    for (const signature of signatures) {
      if (!destination.credentials.includes(signature.root) && request.includes(signature.value))
        throw new ConnectorRefusal(
          `a signature made with "${signature.root}" may not be sent to ${destination.host}`,
        );
    }
    for (const [name, value] of values) {
      if (value.length >= MIN_SECRET && !destination.credentials.includes(name) && request.includes(value))
        throw new ConnectorRefusal(`"${name}" may not be sent to ${destination.host}`);
    }
  };

  /** Put each named credential in, where the address is bound to it. */
  const fill = async (
    input: string,
    destination: ConnectorDestination,
    encode: (value: string) => string,
  ): Promise<string> => {
    const names = [...input.matchAll(SLOT)].map((match) => match[1]!);
    const filled = new Map<string, string>();
    for (const name of names) {
      if (!destination.credentials.includes(name))
        throw new ConnectorRefusal(`"${name}" may not be sent to ${destination.host}`);
      const value = await valueOf(name);
      if (value === null) {
        const token = auth.tokens.some((one) => one.name === name);
        throw new ConnectorRefusal(
          token ? `there is no "${name}" token yet: sign in with auth.exchange first` : `no credential named "${name}" is stored`,
        );
      }
      filled.set(name, value);
    }
    return input.replace(SLOT, (_slot, name: string) => encode(filled.get(name)!));
  };

  interface Outgoing {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  }

  const readRequest = (args: unknown): Outgoing => {
    if (!isRecord(args)) throw new ConnectorRefusal("a request is an object");
    const method = String(args.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "POST")
      throw new ConnectorRefusal(
        `${method} changes things; a connector only reads, and changes go through a person's review`,
      );
    const headers: Record<string, string> = {};
    if (args.headers !== undefined) {
      if (!isRecord(args.headers)) throw new ConnectorRefusal("headers are an object");
      for (const [name, value] of Object.entries(args.headers)) {
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/i.test(name)) throw new ConnectorRefusal(`"${name}" is not a header name`);
        headers[name.toLowerCase()] = text(value, `the ${name} header`, 8_000);
      }
    }
    if (headers.host !== undefined) throw new ConnectorRefusal("the host header is set by the server");
    const body = args.body === undefined || args.body === null ? undefined : text(args.body, "a body");
    if (body !== undefined && method !== "POST") throw new ConnectorRefusal(`a ${method} sends no body`);
    return { method, url: text(args.url, "a url", 8_000), headers, ...(body !== undefined ? { body } : {}) };
  };

  /** Check, fill and send one request. Refusals throw before anything leaves. */
  const send = async (
    request: Outgoing,
    purpose: ConnectorRequestEvent["purpose"] | "api",
  ): Promise<{ status: number; headers: Record<string, string>; text: string; url: string; destination: ConnectorDestination }> => {
    await prime();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new ConnectorRefusal(`"${request.url.slice(0, 200)}" is not an address`);
    }
    let destination: ConnectorDestination;
    try {
      destination = destinationFor(url);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      note({ method: request.method, host: url.hostname, path: url.pathname, status: null, purpose: "read", refused: why });
      throw error;
    }
    const kind: ConnectorRequestEvent["purpose"] =
      purpose === "exchange" ? "exchange" : destination.role === "download" ? "download" : "read";
    const refuse = (why: string): never => {
      note({ method: request.method, host: url.hostname, path: url.pathname, status: null, purpose: kind, refused: why });
      throw new ConnectorRefusal(why);
    };
    if (!destination.methods.includes(request.method as "GET"))
      refuse(`${request.method} is not allowed to ${destination.host}`);
    if (destination.role === "download" && !handedOut.has(url.href))
      refuse(`${url.href.slice(0, 200)} is a download address the API did not give`);
    if (sent >= authority.requests) refuse(`this run has sent all ${authority.requests} requests it may`);
    try {
      assertNoLeak(`${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ""}`, destination);
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }

    const finalUrl = await fill(request.url, destination, encodeURIComponent).catch((error: Error) => refuse(error.message));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      headers[name] = await fill(value, destination, (one) => one).catch((error: Error) => refuse(error.message));
    const json = (headers["content-type"] ?? "").includes("json");
    const body =
      request.body === undefined
        ? undefined
        : await fill(request.body, destination, (one) => (json ? JSON.stringify(one).slice(1, -1) : one)).catch(
            (error: Error) => refuse(error.message),
          );

    /* A read that failed on the way may go again, within the authority's allowance. A POST never does. */
    const attempts = request.method === "POST" ? 1 : 1 + authority.retries;
    for (let attempt = 1; ; attempt++) {
      sent++;
      try {
        const response = await deps.http(
          finalUrl,
          {
            method: request.method,
            headers,
            ...(body !== undefined ? { body } : {}),
            purpose: "read",
            ...(deps.signal ? { signal: deps.signal } : {}),
            ...(deps.connection.privateNetwork ? { privateNetwork: true } : {}),
          },
          destination.host,
        );
        if (response.status >= 500 && attempt < attempts && sent < authority.requests) {
          note({ method: request.method, host: url.hostname, path: url.pathname, status: response.status, purpose: kind });
          await deps.sleep(250 * attempt);
          continue;
        }
        note({ method: request.method, host: url.hostname, path: url.pathname, status: response.status, purpose: kind });
        const raw = response.text.length > MAX_TEXT ? response.text.slice(0, MAX_TEXT) : response.text;
        const answerHeaders: Record<string, string> = {};
        for (const name of ["content-type", "location", "retry-after", "link", "x-total-count", "etag", "last-modified"]) {
          const value = response.header(name);
          if (value !== null) answerHeaders[name] = redact(value);
        }
        if (destination.role === "api") {
          for (const address of addressesIn(raw)) handedOut.add(address);
          if (answerHeaders.location) {
            try {
              handedOut.add(new URL(answerHeaders.location, finalUrl).href);
            } catch {
              /* not an address */
            }
          }
        }
        return { status: response.status, headers: answerHeaders, text: raw, url: redact(response.url), destination };
      } catch (error) {
        if (attempt < attempts && sent < authority.requests && !(error instanceof ConnectorRefusal)) {
          await deps.sleep(250 * attempt);
          continue;
        }
        note({ method: request.method, host: url.hostname, path: url.pathname, status: null, purpose: kind });
        throw new ConnectorRefusal(
          `${url.hostname} could not be reached: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        );
      }
    }
  };

  const keyFor = async (key: unknown): Promise<{ key: Buffer; root: string }> => {
    const name = text(key, "a key", 64);
    const kept = derived.get(name);
    if (kept) return kept;
    if (![...auth.credentials, ...auth.tokens].some((one) => one.name === name))
      throw new ConnectorRefusal(`no credential named "${name}"`);
    await prime();
    const value = await valueOf(name);
    if (value === null) throw new ConnectorRefusal(`no credential named "${name}" is stored`);
    return { key: Buffer.from(value, "utf8"), root: name };
  };

  const encodingOf = (value: unknown): "hex" | "base64" | "base64url" => {
    const encoding = value === undefined ? "hex" : String(value);
    if (!ENCODINGS.has(encoding)) throw new ConnectorRefusal(`encoding must be one of ${[...ENCODINGS].join(", ")}`);
    return encoding as "hex";
  };

  const call = async (name: string, args: unknown): Promise<unknown> => {
    switch (name) {
      case "http.request": {
        const answer = await send(readRequest(args), "api");
        return { status: answer.status, headers: answer.headers, text: redact(answer.text), url: answer.url };
      }

      case "crypto.hmac": {
        if (!isRecord(args)) throw new ConnectorRefusal("crypto.hmac takes { key, data }");
        const alg = String(args.alg ?? "sha256");
        if (!HMACS.has(alg)) throw new ConnectorRefusal(`alg must be one of ${[...HMACS].join(", ")}`);
        const { key, root } = await keyFor(args.key);
        const digest = createHmac(alg, key).update(text(args.data, "data"), "utf8").digest(encodingOf(args.encoding));
        signatures.push({ value: digest, root });
        return digest;
      }

      case "crypto.derive": {
        if (!isRecord(args) || !Array.isArray(args.steps)) throw new ConnectorRefusal("crypto.derive takes { key, steps }");
        if (args.steps.length > 8) throw new ConnectorRefusal("at most 8 steps");
        let { key } = await keyFor(args.key);
        const { root } = await keyFor(args.key);
        for (const step of args.steps) {
          if (isRecord(step) && typeof step.prefix === "string")
            key = Buffer.concat([Buffer.from(text(step.prefix, "a prefix", 200), "utf8"), key]);
          else if (isRecord(step) && typeof step.hmac === "string") {
            const alg = String(step.alg ?? "sha256");
            if (!HMACS.has(alg)) throw new ConnectorRefusal(`alg must be one of ${[...HMACS].join(", ")}`);
            key = createHmac(alg, key).update(text(step.hmac, "data"), "utf8").digest();
          } else throw new ConnectorRefusal("each step is { prefix } or { hmac }");
        }
        const handle = `derived_${derived.size + 1}`;
        derived.set(handle, { key, root });
        return handle;
      }

      case "xml.parse": {
        /* Text the code already holds, read here so XML is never picked apart with regular expressions. */
        if (typeof args !== "string") throw new ConnectorRefusal("XML.parse takes text");
        try {
          return parseXml(args);
        } catch (error) {
          throw new ConnectorRefusal(error instanceof Error ? error.message : String(error));
        }
      }

      case "crypto.hash": {
        if (!isRecord(args)) throw new ConnectorRefusal("crypto.hash takes { data }");
        const alg = String(args.alg ?? "sha256");
        if (!HASHES.has(alg)) throw new ConnectorRefusal(`alg must be one of ${[...HASHES].join(", ")}`);
        return createHash(alg).update(text(args.data, "data"), "utf8").digest(encodingOf(args.encoding));
      }

      case "auth.exchange": {
        if (!isRecord(args)) throw new ConnectorRefusal("auth.exchange takes { name, request, token }");
        const exchangeName = text(args.name, "a name", 32);
        const declared = authority.exchanges.find((one) => one.name === exchangeName);
        const slot = auth.tokens.find((one) => one.name === exchangeName);
        if (!declared || !slot) throw new ConnectorRefusal(`no exchange named "${exchangeName}" is allowed`);
        const kept = await deps.tokens.get(slot.keyRef);
        /* A token with a minute left is as good as gone: renew it before a read stops half-way. */
        if (kept && (kept.expiresAt === null || kept.expiresAt - 60_000 > deps.now())) {
          values.set(exchangeName, kept.value);
          return { name: exchangeName, expiresAt: kept.expiresAt, fields: kept.fields };
        }
        const answer = await send(readRequest(args.request), "exchange");
        if (answer.status < 200 || answer.status >= 300)
          throw new ConnectorRefusal(
            `the sign-in answered ${answer.status}${answer.text ? `: ${redact(answer.text).replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(answer.text);
        } catch {
          throw new ConnectorRefusal("the sign-in did not answer with JSON");
        }
        const token = at(parsed, text(args.token, "the token's path", 120));
        if (typeof token !== "string" || token.length < MIN_SECRET)
          throw new ConnectorRefusal(`no token at ${String(args.token)}`);
        const seconds =
          typeof args.expiresIn === "number" ? args.expiresIn : typeof args.expiresIn === "string" ? at(parsed, args.expiresIn) : undefined;
        const expiresAt =
          typeof seconds === "number" && seconds > 0
            ? deps.now() + seconds * 1000
            : typeof seconds === "string" && Number(seconds) > 0
              ? deps.now() + Number(seconds) * 1000
              : null;
        values.set(exchangeName, token);
        const fields: Record<string, string | number | boolean | null> = {};
        const asked = Array.isArray(args.fields) ? args.fields.filter((one): one is string => typeof one === "string") : [];
        for (const path of asked) {
          if (!declared.fields.includes(path)) continue;
          const value = at(parsed, path);
          if (value === token) continue;
          if (typeof value === "string") fields[path] = redact(value).slice(0, 500);
          else if (typeof value === "number" || typeof value === "boolean" || value === null) fields[path] = value;
        }
        await deps.tokens.put(slot.keyRef, connection.id, { value: token, expiresAt, fields });
        return { name: exchangeName, expiresAt, fields };
      }

      case "credentials.identifier": {
        const wanted = text(args, "a name", 32);
        const credential = auth.credentials.find((one) => one.name === wanted);
        if (!credential) throw new ConnectorRefusal(`no credential named "${wanted}"`);
        /* Only what the connector declared an identifier, and never anything named like a secret. */
        if (!identifiers.has(wanted))
          throw new ConnectorRefusal(`"${wanted}" is a secret; the server uses it for the code, and never hands it over`);
        const value = await deps.resolveSecret(credential.keyRef);
        if (!value) throw new ConnectorRefusal(`no credential named "${wanted}" is stored`);
        return value;
      }

      case "auth.forget": {
        const forgetName = text(args, "a name", 32);
        const slot = auth.tokens.find((one) => one.name === forgetName);
        if (!slot) throw new ConnectorRefusal(`no token named "${forgetName}"`);
        await deps.tokens.forget(slot.keyRef);
        return null;
      }

      case "sleep": {
        const ms = typeof args === "number" && Number.isFinite(args) ? Math.max(0, Math.round(args)) : 0;
        if (slept + ms > authority.sleepMs)
          throw new ConnectorRefusal(`this run may wait ${Math.round(authority.sleepMs / 1000)}s in all, and has used it`);
        slept += ms;
        await deps.sleep(ms);
        return null;
      }

      default:
        throw new ConnectorRefusal(`"${name}" is not something a connector can ask for`);
    }
  };

  return {
    call,
    now: deps.now,
    log(line) {
      if (logs.length < 200) logs.push(redact(line));
    },
    trace,
    logs,
    requests: () => sent,
    redact,
  };
};
