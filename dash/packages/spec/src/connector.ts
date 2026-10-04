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

/**
 * What a request is for. Reads and searches read; an exchange signs in; an
 * export is created, then its status asked, then downloaded. Each is allowed
 * apart, so a grant to start an export is not a grant to send anything else.
 */
export const CONNECTOR_PURPOSES = ["read", "search", "exchange", "export-create", "export-status", "download"] as const;
export type ConnectorPurpose = (typeof CONNECTOR_PURPOSES)[number];

/** `{name}` stands for one path segment; `/**` at the end of a GET's path, for anything below it. */
const templatePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^\/[^?#\s]*$/, "a path starting with /, with no query string");

/**
 * One request the connector may send: the method, the host, the path (a
 * template), what it is for, and which credentials it may carry. Checked
 * before anything leaves; a request no template allows is refused unsent.
 *
 * Only a GET may cover a whole subtree (`/**`). A POST names its one path,
 * so permission to search is never permission to post anywhere on the host.
 */
export const connectorRequestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    purpose: z.enum(CONNECTOR_PURPOSES),
    method: z.enum(CONNECTOR_METHODS),
    host: hostSchema,
    path: templatePathSchema,
    credentials: z.array(credentialNameSchema).max(8).default([]),
    /** What a POST's body may be. `keys`: the top-level fields a JSON or form body may carry. */
    body: z
      .object({
        type: z.enum(["json", "form", "xml", "graphql", "text"]),
        keys: z.array(z.string().min(1).max(80)).max(40).optional(),
      })
      .optional(),
    /** Which endpoints may send it. Absent: any the connector serves or signs. */
    ops: z.array(idSchema).max(50).optional(),
  })
  .superRefine((request, context) => {
    if (request.method !== "GET" && /\*/.test(request.path))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "only a GET may cover more than one path" });
    if (/\*/.test(request.path) && !/^[^*]*\/\*\*$/.test(request.path))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "a wildcard is only /** at the end" });
    if (request.purpose === "download" && (request.method !== "GET" || request.credentials.length > 0))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["purpose"], message: "a download is a GET that carries no credential" });
    if (request.body && request.method !== "POST")
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "only a POST sends a body" });
  });
export type ConnectorRequest = z.infer<typeof connectorRequestSchema>;

/** What the connector is allowed to do, checked by the server on every request it asks for. */
export const connectorAuthoritySchema = z
  .object({
    destinations: z.array(connectorDestinationSchema).min(1).max(8),
    exchanges: z.array(connectorExchangeSchema).max(4).default([]),
    /**
     * Every request the code may send, as templates. Absent on a connector
     * written before templates existed: its hosts and methods are its limit
     * until a check declares the requests it really sends.
     */
    templates: z.array(connectorRequestSchema).max(40).optional(),
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
    const ids = (authority.templates ?? []).map((one) => one.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["templates"], message: "each request is named once" });
    for (const [index, template] of (authority.templates ?? []).entries()) {
      if (!hosts.includes(template.host))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["templates", index, "host"], message: `${template.host} is not a destination` });
    }
  });
export type ConnectorAuthority = z.infer<typeof connectorAuthoritySchema>;

const authorSchema = z.object({
  by: z.enum(["model", "person", "built-in"]),
  model: z.string().max(80).optional(),
  at: z.string().datetime(),
});

/** The hooks an endpoint's own module may define: how it reads, never how the connection signs in. */
export const OPERATION_HOOKS = ["read", "paginate", "parse"] as const;

/**
 * One endpoint's reading code, apart from the shared sign-in. Written for that
 * endpoint alone, so writing code for a second endpoint never replaces the
 * code that reads the first.
 */
export const connectorOperationSchema = z.object({
  code: z.string().min(1).max(64_000),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  hooks: z.array(z.enum(OPERATION_HOOKS)).min(1),
  /** The templates this endpoint's code sends, by id: what it was written to need. */
  templates: z.array(z.string().max(40)).max(20).default([]),
  summary: z.string().max(600).optional(),
  author: authorSchema,
});
export type ConnectorOperation = z.infer<typeof connectorOperationSchema>;

export const connectorSchema = z.object({
  /**
   * Plain JavaScript that defines some of the hooks. Runs only in the sandbox.
   * Shared by every endpoint: the sign-in (`authenticate`, `signRequest`) and,
   * for a connector written before endpoints had modules of their own, the
   * reading too.
   */
  code: z.string().min(1).max(64_000),
  /** `sha256:<hex>` of `code`. Checked before every run; code that does not match is not run. */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  hooks: z.array(z.enum(CONNECTOR_HOOKS)).default([]),
  /** Endpoints the connector reads itself, rather than the connection's declared request. */
  serves: z.array(idSchema).max(50).default([]),
  /** Each endpoint's own reading code, by endpoint. Loaded after `code`, for that endpoint's reads only. */
  operations: z.record(idSchema, connectorOperationSchema).default({}),
  authority: connectorAuthoritySchema,
  /** Raised each time the shared code is replaced; installed whole, never piece by piece. */
  version: z.number().int().min(1).default(1),
  /** The shared code this replaced, kept for one rollback. */
  previous: z
    .object({
      code: z.string().min(1).max(64_000),
      hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      hooks: z.array(z.enum(CONNECTOR_HOOKS)).default([]),
      version: z.number().int().min(1),
    })
    .optional(),
  /** What it does, in plain words, for whoever reviews it. */
  summary: z.string().max(600).optional(),
  author: authorSchema,
});
export type ConnectorSpec = z.infer<typeof connectorSchema>;

/** Whether the connector reads this endpoint itself: by its own module, or by its shared code's `read`. */
export const connectorServes = (connector: ConnectorSpec, opId: string): boolean =>
  connector.serves.includes(opId) || connector.operations[opId] !== undefined;

/**
 * Whether a request is one a template allows: the same method and host, and
 * a path the template's matches — `{name}` one segment, a GET's trailing `/**`
 * anything below. Nothing about the query string: a template is the endpoint,
 * the query its inputs.
 */
export const requestMatches = (
  template: { readonly method: string; readonly host: string; readonly path: string },
  method: string,
  host: string,
  path: string,
): boolean => {
  if (template.method.toUpperCase() !== method.toUpperCase() || template.host.toLowerCase() !== host.toLowerCase()) return false;
  const want = template.path.replace(/\/+$/, "").split("/");
  const got = path.replace(/\/+$/, "").split("/");
  const subtree = want[want.length - 1] === "**";
  const fixed = subtree ? want.slice(0, -1) : want;
  if (subtree ? got.length < fixed.length : got.length !== fixed.length) return false;
  return fixed.every((segment, index) => /^\{[^/{}]+\}$/.test(segment) ? got[index] !== "" : segment === got[index]);
};

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
    Reads one endpoint the connector serves: every record it holds, however many requests that takes. Returns { rows: [...records], done: "all" | "partial", reason?: string, total?: number, pages?: number, resume?: any }.
    done says how the read ended, and nothing else does: "all" only when the API itself showed there is nothing more — an empty or short last page, no next cursor, has_more false, every id an export listed, every window of the range. "partial" when you know records were left out, with reason saying why (the read is then not accepted). Leave done out and the read counts as never having said it reached the end: it is shown as possibly incomplete. pages is how many pages of records were read (not sign-ins or export requests).
    One run may send about 100 requests and last about a minute. When every record needs more than that, do not stop short and do not return done: "partial": count your requests, and before the allowance runs out return the records read so far with resume set to a small JSON value saying where you got to (a page number, a date, a cursor, a list of ids still to read). read() is then called again in a new run, with a new allowance, and ctx.resume holds that value: carry on from there and return only the records not yet returned. Leave resume out when everything has been read, and say done: "all" on that last run.

  async function paginate(page, ctx)
    Used only when there is no read(): given { request, response, rows, index } for the page just read, returns the next request ({ method?, url, headers?, body? }) or null when there are no more.

  async function parse(response, ctx)
    Used only when there is no read(): turns one response into { rows, total? } (or an array of records).

ctx is { op: { id, title, path, method, query, params }, baseUrl, inputs, request?, range: { start, end }, maxPages, resume? }. maxPages is the most pages one run may read, not a page size or a place to stop.
ctx.inputs is every value this read was asked with, by parameter name: what the widget asked for, the board's filters, and each parameter's documented default. Honour every one of them — a widget narrowed by a value must get only the records with that value — and send each where the API takes it.
ctx.request, for an endpoint the connector reads, is the endpoint's own first request with those inputs already in place and no credential: { method, url, headers, body?, missing? }. missing lists inputs nobody supplied (an id the code must find first, say).
ctx.range is the window the widget reads: start and end are ISO 8601 strings (new Date(ctx.range.start) reads one; end is exclusive), or ctx.range is null when no window applies. When it is given, read every record in it: where the API allows only a shorter window per request, ask window by window until the whole range is covered. Never replace it with a window of your own.

What the environment provides (everything else is absent — no fetch, no timers, no Date of your own):

  await http.request({ method, url, headers?, query?, body?, as? })
    Sends one request through the server. method is GET, HEAD or POST. query is an object of values appended to the url. body is a string, or an object sent as JSON. as is "json" | "text" | "csv" | "ndjson" | "xml" | "auto" (default "auto": by content type). Answers { status, headers, body, url } where headers are lower-cased and body is parsed per "as". It does not throw on an error status; check status. A request to an address or with a method your authority does not allow throws.

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
  await XML.parse(text)  — an XML document as plain values: { root: … }. An element holding only text is that text (a number where it plainly is one); an element holding elements is an object; a name that repeats is an array, and one that appears once is NOT an array, so wrap it: [].concat(value ?? []). Attributes are fields too (id="7" is id: 7), and text beside attributes is "value"; namespace prefixes are dropped; a SOAP Envelope is opened to what its Body holds, and a Fault throws. Never read XML with regular expressions.
  log(message)  — a line for whoever reviews the run. Never log anything secret; there is nothing secret to log.
  base64.encode(text), base64.decode(text), encodeURIComponent, URL and URLSearchParams (for building and reading addresses), JSON, Math.

Rules: records are plain objects. Keep numbers as numbers. Read every page or part there is, and say done: "all" when the API showed you reached the end; if you must stop early, say done: "partial".`;
