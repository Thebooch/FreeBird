import { z } from "zod";
import { ARCHETYPES, archetypeSchema, dialectSchema, formatRangeToken } from "./dialect.js";
import {
  authSchema,
  idSchema,
  paginationSchema,
  paramDefSchema,
  pathParamNames,
  queryValueSchema,
} from "./primitives.js";
import { resourceSchema } from "./resource.js";

export { authSchema, paginationSchema } from "./primitives.js";
export type { AuthSpec, PaginationSpec } from "./primitives.js";

/**
 * What an endpoint looks like *as stored*: a path, a name, and the handful of
 * things that genuinely differ from the rest of the API. Everything else is
 * inherited from the connection's dialect, so adding a second endpoint to a
 * known API costs one line rather than fifteen.
 */
export const opDefSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * Read-only by construction: v1 issues GET and nothing else, so no spec
   * and no generated binding can ever mutate a connected account.
   */
  method: z.literal("GET").default("GET"),
  /** Appended to the connection's baseUrl. May contain `{{…}}` params. */
  path: z.string().min(1),
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
  maxPages: z.number().int().min(1).max(50).optional(),
  /** Path to the row array. Overrides the dialect. */
  rowsPath: z.string().optional(),
  /** Set false to skip the dialect's date filter on this one endpoint. */
  timeFiltered: z.boolean().optional(),
  /** Hash of the inferred response schema, for drift detection. */
  schemaHash: z.string().optional(),
});

export type OpDef = z.infer<typeof opDefSchema>;

/** A fully-resolved endpoint: what the adapter actually executes. */
export const opSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  method: z.literal("GET").default("GET"),
  path: z.string().min(1),
  /** Carried through resolution so the adapter and UI can ask what it needs. */
  params: z.array(paramDefSchema).max(60).default([]),
  query: z.record(z.string(), queryValueSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  pagination: paginationSchema.default({ kind: "none" }),
  /** Hard stop on pages fetched, whatever the strategy claims. */
  maxPages: z.number().int().min(1).max(50).default(5),
  rowsPath: z.string().optional(),
  schemaHash: z.string().optional(),
});

export type OpSpec = z.infer<typeof opSchema>;

export const connectionSchema = z.object({
  specVersion: z.literal(1).default(1),
  id: idSchema,
  title: z.string().min(1),
  kind: z.enum(["rest", "mcp", "inline"]),
  /** REST base URL or MCP server URL. Absent for `inline`. */
  baseUrl: z.string().url().optional(),
  auth: authSchema.default({ type: "none" }),
  /** How this vendor does things, stated once. */
  dialect: dialectSchema.optional(),
  /** Catalog entry this connection was created from, for provenance. */
  catalog: z.string().optional(),
  ops: z.array(opDefSchema).default([]),
  /** The nouns this API exposes, and how its endpoints relate. */
  resources: z.array(resourceSchema).max(200).default([]),
  /** Op fired to prove a key works, so onboarding fails fast and clearly. */
  validateOpId: idSchema.optional(),
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
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ConnectionSpec = z.infer<typeof connectionSchema>;

/**
 * Collapse archetype defaults, the dialect, and the op's own overrides into
 * one executable endpoint. Precedence is always the same and always narrow to
 * broad: the op wins, then the dialect, then the archetype.
 */
export const resolveOp = (connection: ConnectionSpec, def: OpDef): OpSpec => {
  const dialect = connection.dialect;
  const archetype = ARCHETYPES[def.archetype ?? "list"];

  const query: Record<string, string | number | boolean> = {
    ...(dialect?.query ?? {}),
    ...def.query,
  };

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

  const pagination = def.pagination ?? (archetype.paginates ? dialect?.pagination : undefined);

  return opSchema.parse({
    id: def.id,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    method: "GET",
    path: def.path,
    params: def.params,
    query,
    headers: { ...(dialect?.headers ?? {}), ...def.headers },
    pagination: pagination ?? { kind: "none" },
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
  const declared = op.params
    .filter((param) => {
      if (param.in === "path") return true;
      // A required query param the importer already seeded a value for is
      // satisfied — asking the caller for it again would be wrong.
      return param.required && !(param.name in op.query);
    })
    .map((param) => param.name);
  return [...new Set([...pathParamNames(op.path), ...declared])];
};

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
