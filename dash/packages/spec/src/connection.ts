import { z } from "zod";
import {
  ARCHETYPES,
  archetypeSchema,
  dialectSchema,
  formatRangeToken,
  mappedFieldSchema,
} from "./dialect.js";
import {
  MAX_PAGES,
  authSchema,
  authCredentials,
  authKeyRefs,
  idSchema,
  paginationSchema,
  paramDefSchema,
  pagingParamNames,
  graphqlReadsOnly,
  readBodySchema,
  readSafetySchema,
  type AuthCredential,
  type ReadBody,
  type ReadSafety,
  pathParamNames,
  queryValueSchema,
  resolveServerUrl,
  serverTemplateSchema,
} from "./primitives.js";
import { resourceSchema } from "./resource.js";
import { onboardingSchema } from "./category.js";
import { connectorSchema } from "./connector.js";

export { authSchema, paginationSchema } from "./primitives.js";
export type { AuthSpec, PaginationSpec } from "./primitives.js";

/**
 * What an endpoint looks like *as stored*: a path, a name, and the handful of
 * things that genuinely differ from the rest of the API. Everything else is
 * inherited from the connection's dialect, so adding a second endpoint to a
 * known API costs one line rather than fifteen.
 */
const opDefObject = z.object({
  auth: authSchema.optional(),
  authRequired: z.boolean().optional(),
  fields: z.array(mappedFieldSchema).max(300).optional(),
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * An op is a read. Almost always a GET; a POST only for an API that reads
   * with a body — a search, a report, a GraphQL query — and then only with a
   * `readSafety` saying why it is believed to read (see `readSafetySchema`).
   * Endpoints that change things are a different list — `CatalogEntry.writes`
   * — and only the write service can send one, after a person has reviewed it.
   */
  method: z.enum(["GET", "POST"]).default("GET"),
  /** Appended to the connection's baseUrl. May contain `{{…}}` params. */
  path: z.string().min(1),
  /** What a POST read sends. Never on a GET. */
  body: readBodySchema.optional(),
  readSafety: readSafetySchema.optional(),
  /** Where the response states how many records match in all, e.g. `$.meta.total`. */
  totalPath: z.string().max(200).optional(),
  archetype: archetypeSchema.optional(),
  /**
   * What this endpoint accepts. Describes inputs; it does not supply them —
   * `query` below holds the values that are actually sent.
   */
  params: z.array(paramDefSchema).max(60).default([]),
  query: z.record(z.string(), queryValueSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  /** Overrides the dialect. Omit to inherit. */
  pagination: paginationSchema.optional(),
  /**
   * How this endpoint pages was confirmed — by a probe that read its second
   * page, or by a person — including that it does not page at all. Until
   * then an imported connection's unconfirmed paging is warned about.
   */
  paginationChecked: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(MAX_PAGES).optional(),
  /** Path to the row array. Overrides the dialect. */
  rowsPath: z.string().optional(),
  /** Set false to skip the dialect's date filter on this one endpoint. */
  timeFiltered: z.boolean().optional(),
  /** Hash of the inferred response schema, for drift detection. */
  schemaHash: z.string().optional(),
  /**
   * Read by the connection's connector rather than by the request described
   * here — a sign-in or a sequence of requests only code can perform. The
   * path stays as the documentation gives it; the connector decides what is
   * actually sent. See `connector.ts`.
   */
  servedBy: z.literal("connector").optional(),
  /**
   * The endpoint is a stream of server-sent events, never finished: it is read
   * for a window — this many events, or this many seconds, whichever comes
   * first — and what arrived in it is the answer. Always said on the tile: a
   * window of a stream is not everything the stream has ever carried.
   */
  stream: z
    .object({
      events: z.number().int().min(1).max(1000).default(100),
      seconds: z.number().int().min(1).max(30).default(5),
    })
    .optional(),
});

/**
 * The rules a read must keep, whatever wrote it — an importer, a repair, a
 * person. A POST says why it reads; a GraphQL body can only query.
 */
const readRules = (op: {
  method: "GET" | "POST";
  body?: ReadBody | undefined;
  readSafety?: ReadSafety | undefined;
}, context: z.RefinementCtx): void => {
  if (op.method === "GET" && op.body)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "a GET read sends no body" });
  if (op.method === "POST" && !op.readSafety)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readSafety"],
      message: "a read sent with POST must say why it is believed to read",
    });
  if (op.body?.type === "graphql" && !graphqlReadsOnly(op.body.query))
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body", "query"],
      message: "a GraphQL read may only query; this document can change something",
    });
};

export const opDefSchema = opDefObject.superRefine(readRules);

export type OpDef = z.infer<typeof opDefSchema>;

/** A fully-resolved endpoint: what the adapter actually executes. */
const opObject = z.object({
  auth: authSchema.optional(),
  authRequired: z.boolean().optional(),
  fields: z.array(mappedFieldSchema).max(300).optional(),
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().min(1),
  body: readBodySchema.optional(),
  readSafety: readSafetySchema.optional(),
  totalPath: z.string().max(200).optional(),
  /** Carried through resolution so the adapter and UI can ask what it needs. */
  params: z.array(paramDefSchema).max(60).default([]),
  query: z.record(z.string(), queryValueSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  pagination: paginationSchema.default({ kind: "none" }),
  paginationChecked: z.boolean().optional(),
  /** Hard stop on pages fetched, whatever the strategy claims. */
  maxPages: z.number().int().min(1).max(MAX_PAGES).default(5),
  rowsPath: z.string().optional(),
  schemaHash: z.string().optional(),
  servedBy: z.literal("connector").optional(),
  /** See `opDefSchema.stream`. */
  stream: z.object({ events: z.number().int().min(1).max(1000), seconds: z.number().int().min(1).max(30) }).optional(),
  /**
   * Whether anything this endpoint sends actually reads the time range.
   *
   * Carried because the cache key is scoped by the resolved window, and a
   * relative window is re-resolved into a new bucket every few minutes — so an
   * endpoint that never reads it was getting a fresh key, and therefore a
   * fresh upstream call, for data identical by construction. Measured on two
   * real connections: **none of their 243 endpoints read the range**, and the
   * whole cache was being discarded every fifteen minutes for nothing.
   *
   * A fact about the endpoint rather than about the request, which is what
   * lets the browser and the server agree on a key without either re-deriving
   * it — see `opUsesRange`.
   */
  usesRange: z.boolean().default(false),
});

export const opSchema = opObject.superRefine(readRules);

export type OpSpec = z.infer<typeof opSchema>;

export const connectionSchema = z.object({
  credentialsRevision: z.number().int().min(0).optional(),
  paginationPending: z.boolean().optional(),
  /**
   * The API is on a private network — an office server, a VPN — and this
   * connection may reach it, where the server's operator has allowed that
   * address (`DASH_PRIVATE_EGRESS`). Both are needed; see `EgressPolicy`.
   */
  privateNetwork: z.boolean().optional(),
  specVersion: z.literal(1).default(1),
  id: idSchema,
  title: z.string().min(1),
  kind: z.enum(["rest", "mcp", "inline"]),
  /** REST base URL or MCP server URL. Absent for `inline`. */
  baseUrl: z.string().url().optional(),
  /**
   * The address template this connection's `baseUrl` was filled in from,
   * with this account's values — `{ account: "northgate" }`. Kept so the values
   * can be changed later without retyping the whole address, and so an
   * address that still has a blank in it is recognised as unfinished.
   */
  server: serverTemplateSchema
    .extend({ values: z.record(z.string(), z.string().max(200)).default({}) })
    .optional(),
  /**
   * The address has not been confirmed by anybody who knows it. Set when the
   * connection came from a description that had to guess, or that writes the
   * address with a per-account blank; cleared when somebody saves it. Nothing
   * is sent while it is set — see `connectionNeedsAddress`.
   */
  addressPending: z.boolean().optional(),
  auth: authSchema.default({ type: "none" }),
  /**
   * A client certificate the API asks for (mutual TLS), beside whatever the
   * sign-in sends: the certificate and its private key, both in the vault,
   * sent with every request to this connection's host and nowhere else.
   * PEM, as the provider issued them.
   */
  clientCertificate: z
    .object({
      certRef: idSchema,
      keyRef: idSchema,
      /** The provider's own certificate authority, where its server is not signed by a public one. */
      caRef: idSchema.optional(),
      certLabel: z.string().max(80).optional(),
      keyLabel: z.string().max(80).optional(),
    })
    .optional(),
  /** How this vendor does things, stated once. */
  dialect: dialectSchema.optional(),
  /** Catalog entry this connection was created from, for provenance. */
  catalog: z.string().optional(),
  ops: z.array(opDefSchema).default([]),
  /** The nouns this API exposes, and how its endpoints relate. */
  resources: z.array(resourceSchema).max(200).default([]),
  /** Op fired to prove a key works, so onboarding fails fast and clearly. */
  validateOpId: idSchema.optional(),
  /**
   * Code for what this API needs that a connection cannot describe in data —
   * signed requests, a login for a session token, a multi-step read. Runs only
   * in the sandbox, within its authority. See `connector.ts`.
   */
  connector: connectorSchema.optional(),
  /** Where the user gets a key, and what to tick. Shown during onboarding. */
  docsUrl: z.string().url().optional(),
  keyHelp: z.string().optional(),
  /**
   * A key is needed but the description never said how it is sent, so
   * `auth` is still `none` and the user must choose. See `catalogEntrySchema`.
   */
  authRequired: z.boolean().default(false),
  /** Set when an MCP tool returns prose rather than a declared outputSchema. */
  brittle: z.boolean().optional(),
  /**
   * Which parts of this API somebody wanted, and the boards that came of it.
   *
   * The personal half of onboarding. The categories themselves describe the
   * API and live in the catalog entry, shared with everybody who connects it;
   * what one person picked out of them, and whether they wanted it on one tab
   * or several, is theirs. Recorded so the question is asked once.
   */
  onboarding: onboardingSchema.optional(),
  /**
   * The last time the integration loop checked this connection, and how it
   * went: what it changed, and what it could not get past.
   *
   * A summary for the setup screens only. What was actually observed about
   * each endpoint is evidence, kept in the evidence store with the scope and
   * configuration it was observed under.
   */
  integration: z
    .object({
      at: z.string().datetime(),
      outcome: z.enum(["ready", "partial", "blocked"]),
      changes: z.array(z.string().max(400)).max(20).default([]),
      notes: z.array(z.string().max(400)).max(20).default([]),
    })
    .optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ConnectionSpec = z.infer<typeof connectionSchema>;
/** All credential slots needed by this connection's declared endpoints. */
export const connectionAuths = (connection: ConnectionSpec) =>
  connection.ops.length
    ? connection.ops.map((op) => op.auth ?? connection.auth)
    : [connection.auth];
export const connectionKeyRefs = (connection: ConnectionSpec): string[] => [
  ...new Set([
    ...connectionAuths(connection).flatMap(authKeyRefs),
    ...(connection.clientCertificate
      ? [
          connection.clientCertificate.certRef,
          connection.clientCertificate.keyRef,
          ...(connection.clientCertificate.caRef ? [connection.clientCertificate.caRef] : []),
        ]
      : []),
  ]),
];

/**
 * Every value a person pastes for this connection, once each: the sign-in's,
 * endpoint by endpoint, and a client certificate's where it asks for one.
 */
export const connectionCredentials = (connection: ConnectionSpec): AuthCredential[] => {
  const rows = [
    ...connectionAuths(connection).flatMap(authCredentials),
    ...(connection.clientCertificate
      ? [
          {
            keyRef: connection.clientCertificate.certRef,
            label: connection.clientCertificate.certLabel ?? "Client certificate",
            hint: "The certificate the provider issued for your account, in PEM (-----BEGIN CERTIFICATE-----).",
          },
          {
            keyRef: connection.clientCertificate.keyRef,
            label: connection.clientCertificate.keyLabel ?? "Client certificate key",
            hint: "The certificate's private key, in PEM (-----BEGIN PRIVATE KEY-----). Sent to nobody: it signs the connection.",
          },
          ...(connection.clientCertificate.caRef
            ? [
                {
                  keyRef: connection.clientCertificate.caRef,
                  label: "Provider's certificate authority",
                  hint: "The certificate authority the provider's server is signed by, in PEM, where the provider gives one.",
                },
              ]
            : []),
        ]
      : []),
  ];
  return [...new Map(rows.map((row) => [row.keyRef, row])).values()];
};
/**
 * Whether this connection still needs to be told where the API lives.
 *
 * True until somebody confirms an address that was guessed, or fills in every
 * per-account part of a templated one. Checked before any request is made, so
 * a connection never calls the placeholder host its description came with.
 */
export const connectionNeedsAddress = (connection: ConnectionSpec): boolean => {
  if (connection.kind !== "rest") return false;
  if (connection.addressPending) return true;
  if (!connection.server) return false;
  return resolveServerUrl(connection.server, connection.server.values).url === undefined;
};

export const connectionNeedsAuthSetup = (connection: ConnectionSpec): boolean =>
  connection.ops.length
    ? connection.ops.some(
        (op) =>
          op.authRequired ??
          (op.auth === undefined && connection.authRequired && connection.auth.type === "none"),
      )
    : connection.authRequired && connection.auth.type === "none";

/** A `{{range.…}}` token anywhere in what this endpoint sends. */
const RANGE_TOKEN = /\{\{\s*range\./;

/**
 * Does this endpoint read the time range?
 *
 * Two ways it can: the op writes a range token itself, or the dialect declares
 * a date convention and this op is the kind that inherits it. Both are checked
 * here rather than after resolution, so a caller can ask the question cheaply
 * — the public connection answers it for every op on every page load, and
 * parsing two hundred resolved ops to find out would cost more than it saves.
 */
export const opUsesRange = (connection: ConnectionSpec, def: OpDef): boolean => {
  const declared = Object.values(def.query).some(
    (value) => typeof value === "string" && RANGE_TOKEN.test(value),
  );
  /* A body or a header can read the window as well as the query can. */
  const elsewhere =
    (def.body !== undefined && RANGE_TOKEN.test(JSON.stringify(def.body))) ||
    Object.values(def.headers).some((value) => RANGE_TOKEN.test(value));
  if (declared || elsewhere || RANGE_TOKEN.test(def.path)) return true;
  /*
   * Code that reads the window itself (`ctx.range`): its answer depends on
   * the window, so the window is part of what it is cached under — or a
   * thirty-day read stands in for one since June.
   */
  if (
    def.servedBy === "connector" &&
    /\brange\b/.test(`${connection.connector?.code ?? ""}\n${connection.connector?.operations[def.id]?.code ?? ""}`)
  )
    return true;

  const timeFiltered = def.timeFiltered ?? ARCHETYPES[def.archetype ?? "list"].timeFiltered;
  return Boolean(timeFiltered && connection.dialect?.timeFilter);
};

/**
 * Collapse archetype defaults, the dialect, and the op's own overrides into
 * one executable endpoint. Precedence is always the same and always narrow to
 * broad: the op wins, then the dialect, then the archetype.
 */
export const resolveOp = (connection: ConnectionSpec, def: OpDef): OpSpec => {
  const dialect = connection.dialect;
  const archetype = ARCHETYPES[def.archetype ?? "list"];

  const pagination = def.pagination ?? (archetype.paginates ? dialect?.pagination : undefined);

  /*
   * A documented default for a parameter the paging rule sets is the rule's
   * to decide. Filling it in anyway put `limit=25` beside a rule asking for
   * 100 on every request — which the adapter rightly refuses as a conflict —
   * so an imported endpoint could never page once its paging was configured.
   */
  const pagingParams = new Set(pagingParamNames(pagination));
  const query: Record<string, string | number | boolean> = {
    ...(dialect?.query ?? {}),
    ...def.query,
  };
  for (const param of def.params) {
    if (
      param.in === "query" &&
      param.default !== undefined &&
      query[param.name] === undefined &&
      !pagingParams.has(param.name)
    )
      query[param.name] = param.default;
  }

  // The payoff of declaring a date convention once: the range token is
  // injected here, so nobody hand-writes `{{range.start | unix}}` per endpoint
  // and nobody gets the format wrong.
  const timeFiltered = def.timeFiltered ?? archetype.timeFiltered;
  if (timeFiltered && dialect?.timeFilter) {
    const { param, endParam, format } = dialect.timeFilter;
    if (!(param in def.query)) query[param] = formatRangeToken("start", format);
    if (endParam && !(endParam in def.query)) {
      query[endParam] = formatRangeToken("end", format);
    }
  }

  return opSchema.parse({
    auth: def.auth,
    authRequired: def.authRequired,
    fields: def.fields,
    id: def.id,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    method: def.method,
    path: def.path,
    ...(def.body ? { body: def.body } : {}),
    ...(def.readSafety ? { readSafety: def.readSafety } : {}),
    ...(def.totalPath ? { totalPath: def.totalPath } : {}),
    params: def.params,
    query,
    headers: { ...(dialect?.headers ?? {}), ...def.headers },
    pagination: pagination ?? { kind: "none" },
    ...(def.paginationChecked ? { paginationChecked: true } : {}),
    // A dialect setting that only makes sense for a paginated collection must
    // not leak into an endpoint that fetches exactly one object.
    maxPages:
      def.maxPages ??
      (archetype.paginates ? dialect?.maxPages : undefined) ??
      archetype.defaultMaxPages,
    rowsPath:
      def.rowsPath ??
      (archetype.collection ? dialect?.rowsPath : undefined) ??
      archetype.defaultRowsPath,
    ...(def.schemaHash ? { schemaHash: def.schemaHash } : {}),
    ...(def.servedBy ? { servedBy: def.servedBy } : {}),
    ...(def.stream ? { stream: def.stream } : {}),
    usesRange: opUsesRange(connection, def),
  });
};

/**
 * Re-exported from `primitives`, which is where it had to move: `resource.ts`
 * needs it to read a path's shape, and `connection.ts` already imports
 * `resource.ts` — so owning it here would have made a cycle.
 */
export { pathParamNames } from "./primitives.js";

/**
 * The inputs that must be supplied before this endpoint can be called at all.
 *
 * Path segments are the hard case and the reason this exists: `interpolate`
 * deliberately resolves an unknown token to an empty string rather than
 * leaving a dangling `{{…}}` in an outgoing request, which is right for a
 * query value and silently wrong for a path — it turns
 * `/v1/applications/{{param.applicationId}}/transactions` into
 * `/v1/applications//transactions` and the API answers 404, which reads
 * exactly like a rejected key.
 *
 * Declared `params` are authoritative when present; the path is scanned as a
 * fallback so an op written by hand still gets the check.
 */
export const requiredInputs = (op: OpSpec | OpDef): string[] => {
  /*
   * A connector reads the endpoint its own way: the documented path's ids are
   * values its requests produce, not ones a board supplies. Only what it
   * declares as a required input is asked for.
   */
  if (op.servedBy === "connector")
    return op.params
      .filter((param) => param.in !== "path" && param.required && !(param.name in op.query))
      .map((param) => param.name);
  const declared = op.params
    .filter((param) => {
      if (param.in === "path") return true;
      // A required query param the importer already seeded a value for is
      // satisfied — asking the caller for it again would be wrong. So is a
      // header, cookie or body parameter with a documented default, which is
      // sent with it (see `locateInputs`).
      if (param.in !== "query" && param.default !== undefined) return false;
      return param.required && !(param.name in op.query);
    })
    .map((param) => param.name);
  return [...new Set([...pathParamNames(op.path), ...declared])];
};

/**
 * What still has to come from a board: the inputs missing from the bag that
 * no other endpoint's records supply (`ParamDef.valueFrom`). An organisation's
 * projects need its id, and the organisations list gives it — so a board
 * reading every project needs nothing.
 */
export const boardInputs = (
  op: OpSpec | OpDef,
  supplied: Readonly<Record<string, string | number | boolean>>,
): string[] => missingInputs(op, supplied).filter((name) => !op.params.find((param) => param.name === name)?.valueFrom);

/** Which of `requiredInputs` has no value in the supplied bag. */
export const missingInputs = (
  op: OpSpec | OpDef,
  supplied: Readonly<Record<string, string | number | boolean>>,
): string[] =>
  requiredInputs(op).filter((name) => {
    const value = supplied[name];
    return value === undefined || value === "";
  });

/** The stored, un-inherited definition. */
export const getOpDef = (connection: ConnectionSpec, opId: string): OpDef | undefined =>
  connection.ops.find((op) => op.id === opId);

/** The resolved endpoint an adapter executes. */
export const getOp = (connection: ConnectionSpec, opId: string): OpSpec | undefined => {
  const def = getOpDef(connection, opId);
  return def ? resolveOp(connection, def) : undefined;
};

/**
 * The query parameter a read confirmed narrows an endpoint's records by a
 * field (`ParamDef.filters`), for asking the API for only the records a
 * number counts rather than reading every page to find them.
 */
export const filterParamsOf =
  (connection: ConnectionSpec) =>
  (opId: string, field: string): string | undefined =>
    getOpDef(connection, opId)?.params?.find((param) => param.in === "query" && param.filters === field)?.name;

/**
 * Whether an endpoint reads the board's time range: what a number over it is
 * scoped to when its request named no time of its own.
 */
export const readsRangeOf =
  (connection: ConnectionSpec) =>
  (opId: string): boolean => {
    const def = getOpDef(connection, opId);
    return def ? opUsesRange(connection, def) : false;
  };

/**
 * The only hostname a connection is ever allowed to reach. Combined with the
 * server's SSRF guard this means a compromised or hallucinated op cannot be
 * pointed at an unrelated host.
 */
export const allowedHost = (connection: ConnectionSpec): string | null => {
  if (!connection.baseUrl) return null;
  try {
    return new URL(connection.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Auth comes from the dialect unless the connection states its own. */
export const effectiveAuth = (connection: ConnectionSpec): ConnectionSpec["auth"] =>
  connection.auth.type === "none" ? (connection.dialect?.auth ?? connection.auth) : connection.auth;
