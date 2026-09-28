import { z } from "zod";
import { credentialNameSchema, idSchema } from "./primitives.js";

/**
 * Connector code: for the API the declarative connection cannot describe.
 *
 * Most APIs are a key in a header and a list at a path, and a connection says
 * so in data. Some are not: every request signed with a secret, a login for a
 * session token, records that exist only as a file an export produces. For
 * those, a connection carries a small program — written by a model at
 * configuration time, or by a person — that runs only inside the
 * `ConnectorSandbox`, never in the server's own process.
 *
 * The code has no network, no file system and no clock of its own. Everything
 * it does outside itself it asks the server for, and the server checks each
 * request against the connector's **authority**: where it may send, with which
 * methods, carrying which credentials. The code never holds a credential. It
 * asks the server to sign with one, or to put one in a request by name, and the
 * server does that only for an address the authority binds that credential
 * to. See `apps/server/src/connector/` and `dash/PLATFORM.md`.
 */

/** Every hook a connector may define. See `CONNECTOR_CONTRACT` for what each does. */
export const CONNECTOR_HOOKS = ["authenticate", "signRequest", "read", "paginate", "parse"] as const;
export type ConnectorHook = (typeof CONNECTOR_HOOKS)[number];

/**
 * The methods a connector may send. A read, or a POST that a read needs (a
 * search, an export being started) — never a change: those go through the
 * write service and a person's review like every other change.
 */
export const CONNECTOR_METHODS = ["GET", "HEAD", "POST"] as const;

const hostSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "a host name, like api.example.com");

/**
 * One address the connector may reach.
 *
 * `api` is the service itself. `download` is somewhere the service hands out
 * an address for — a file store holding an export — which is reached only at
 * an address the service actually answered with during the same run, and
 * never with a credential.
 */
export const connectorDestinationSchema = z
  .object({
    host: hostSchema,
    role: z.enum(["api", "download"]).default("api"),
    methods: z.array(z.enum(CONNECTOR_METHODS)).min(1).max(3),
    /** Which credentials and tokens, by name, may be used on a request to this host. */
    credentials: z.array(credentialNameSchema).max(8).default([]),
    /** Which endpoints may reach this host. Absent: any the connector serves or signs. */
    ops: z.array(idSchema).max(50).optional(),
  })
  .superRefine((destination, context) => {
    if (destination.role === "download" && destination.credentials.length > 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials"],
        message: "a download address never carries a credential",
      });
    if (destination.role === "download" && destination.methods.includes("POST"))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["methods"], message: "a download is only read" });
  });
export type ConnectorDestination = z.infer<typeof connectorDestinationSchema>;

/**
 * A token exchange the connector may ask for: a login that answers with a
 * session token. The server sends it, keeps the token, and tells the code only
 * the fields named here — never the token.
 */
export const connectorExchangeSchema = z.object({
  name: credentialNameSchema,
  /** Paths into the answer the code may see, e.g. `$.account.id`. Never the token. */
  fields: z.array(z.string().min(1).max(120)).max(8).default([]),
});

/** What the connector is allowed to do, checked by the server on every request it asks for. */
export const connectorAuthoritySchema = z
  .object({
    destinations: z.array(connectorDestinationSchema).min(1).max(8),
    exchanges: z.array(connectorExchangeSchema).max(4).default([]),
    /** Times a failed read (never a POST) may be sent again. */
    retries: z.number().int().min(0).max(3).default(1),
    /** Requests one run may send. */
    requests: z.number().int().min(1).max(500).default(100),
    /** Time one run may spend waiting — for an export to be prepared, say. */
    sleepMs: z.number().int().min(0).max(120_000).default(30_000),
    /** Time one run may take, start to finish, waiting included. */
    wallMs: z.number().int().min(1_000).max(300_000).default(60_000),
  })
  .superRefine((authority, context) => {
    const hosts = authority.destinations.map((one) => one.host);
    if (new Set(hosts).size !== hosts.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinations"], message: "each host is listed once" });
  });
export type ConnectorAuthority = z.infer<typeof connectorAuthoritySchema>;

export const connectorSchema = z.object({
  /** Plain JavaScript that defines some of the hooks. Runs only in the sandbox. */
  code: z.string().min(1).max(64_000),
  /** `sha256:<hex>` of `code`. Checked before every run; code that does not match is not run. */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  hooks: z.array(z.enum(CONNECTOR_HOOKS)).min(1),
  /** Endpoints the connector reads itself, rather than the connection's declared request. */
  serves: z.array(idSchema).max(50).default([]),
  authority: connectorAuthoritySchema,
  /** What it does, in plain words, for whoever reviews it. */
  summary: z.string().max(600).optional(),
  author: z.object({
    by: z.enum(["model", "person", "built-in"]),
    model: z.string().max(80).optional(),
    at: z.string().datetime(),
  }),
});
export type ConnectorSpec = z.infer<typeof connectorSchema>;

/**
 * The contract, in words: what a connector's code may define, and what it is
 * given. Shown to the model that writes one, and the reference for a person
 * writing one by hand. Describes the environment only — no API's own scheme.
 */
export const CONNECTOR_CONTRACT = `A connector is plain JavaScript (no imports, no require, no modules). Define any of these top-level async functions:

  async function authenticate(ctx)
    Called once at the start of every run, before anything else. Use it to log in for a session token with auth.exchange. Returns nothing.

  async function signRequest(request, ctx)
    Called for every request before it is sent — your own http.request calls, and every request the connection's declared endpoints send. Receives { method, url, headers, body } and returns it, changed as the API's sign-in requires (usually headers added). body is a string or undefined.

  async function read(ctx)
    Reads one endpoint the connector serves: every record it holds, however many requests that takes. Returns { rows: [...records], total?: number, complete?: boolean }. Set complete: false when you know records were left out — the read is then not accepted.

  async function paginate(page, ctx)
    Used only when there is no read(): given { request, response, rows, index } for the page just read, returns the next request ({ method?, url, headers?, body? }) or null when there are no more.

  async function parse(response, ctx)
    Used only when there is no read(): turns one response into { rows, total? } (or an array of records).

ctx is { op: { id, title, path, method, query, params }, baseUrl, inputs, range: { start, end }, maxPages }. maxPages is the most pages one run may read, not a page size or a place to stop.

What the environment provides (everything else is absent — no fetch, no timers, no Date of your own):

  await http.request({ method, url, headers?, query?, body?, as? })
    Sends one request through the server. method is GET, HEAD or POST. query is an object of values appended to the url. body is a string, or an object sent as JSON. as is "json" | "text" | "csv" | "ndjson" | "auto" (default "auto": by content type). Answers { status, headers, body, url } where headers are lower-cased and body is parsed per "as". It does not throw on an error status; check status. A request to an address or with a method your authority does not allow throws.

  Credentials are used by name and never seen. In a header, query value or body, write {{secret:NAME}} and the server puts the value in, only for an address allowed to receive it.
  await credentials.identifier(NAME)  — the value of a credential declared as an identifier (secret: false): a key ID or account number the API treats as public, which the code needs inside something it builds or signs. Never available for a secret, password or token.

  await crypto.hmac({ key: NAME, data: "text", alg?: "sha256" | "sha1" | "sha512", encoding?: "hex" | "base64" | "base64url" })
    A keyed hash of data with the credential NAME (or a derived key's handle). Returns the digest text.
  await crypto.derive({ key: NAME, steps: [ { prefix: "text" } | { hmac: "data", alg? } ... ] })
    A key derived from a credential by prefixing it and keying hashes in sequence. Returns a handle usable as key in crypto.hmac, valid for this run only.
  await crypto.hash({ data: "text", alg?: "sha256" | "sha1" | "sha512" | "md5", encoding? })
    A plain hash of text that holds no secret.

  await auth.exchange({ name, request: { method, url, headers?, body? }, token: "$.path", expiresIn?: "$.path" | seconds, fields?: ["$.path"] })
    Sends a login request (use {{secret:NAME}} for what the person pasted), keeps the token found at "token", and answers { name, expiresAt, fields }. The login is not passed through signRequest unless you add sign: true. The token itself is never returned: use it as {{secret:<exchange name>}}. A token still valid from an earlier run is reused without a request.
  await auth.forget(name)  — drops a kept token, for a token the API refused.

  clock.now()  — milliseconds since 1970, from the server.
  await sleep(ms)  — waits, within the run's allowance.
  CSV.parse(text, { header?: true, delimiter?: "," }) and NDJSON.parse(text)  — synchronous, like JSON.parse. CSV cells that are plain numbers become numbers.
  log(message)  — a line for whoever reviews the run. Never log anything secret; there is nothing secret to log.
  base64.encode(text), base64.decode(text), encodeURIComponent, JSON, Math.

Rules: records are plain objects. Keep numbers as numbers. Read every page or part there is; if you must stop early, say complete: false.`;
