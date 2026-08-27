import { z } from "zod";

/**
 * Shared by connections and dialects. Kept in its own module so the dependency
 * order stays a straight line: primitives → dialect → connection.
 */

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]");

/**
 * How a connection proves who it is. The secret itself never appears in a
 * spec file — `keyRef` names an entry in the encrypted vault, and the public
 * API only ever reports whether that entry exists.
 */
export const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), keyRef: idSchema }),
  z.object({
    type: z.literal("header"),
    header: z.string().min(1),
    keyRef: idSchema,
    /** e.g. "Token {{key}}" — `{{key}}` is the only token allowed here. */
    template: z.string().optional(),
  }),
  z.object({ type: z.literal("query"), param: z.string().min(1), keyRef: idSchema }),
  z.object({ type: z.literal("basic"), username: z.string().min(1), keyRef: idSchema }),
  /**
   * Two or more secret headers sent together.
   *
   * Client-id + client-secret pairs are common enough to need first-class
   * support — Buildium sends `x-buildium-client-id` and
   * `x-buildium-client-secret`, and neither alone authenticates anything.
   * Modelling that as a single `header` forces the user to smuggle both
   * values into one field, which cannot work.
   *
   * Each part has its own `keyRef`, so the two secrets are encrypted and
   * rotated independently rather than being concatenated into one blob.
   */
  z.object({
    type: z.literal("headers"),
    parts: z
      .array(
        z.object({
          header: z.string().min(1),
          keyRef: idSchema,
          /** What to call this field in the UI, e.g. "Client ID". */
          label: z.string().optional(),
          /** e.g. "Token {{key}}" — `{{key}}` is the only token allowed. */
          template: z.string().optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
]);

export type AuthSpec = z.infer<typeof authSchema>;

/**
 * Every secret this auth style needs, in UI order.
 *
 * Callers must go through this rather than reading `auth.keyRef`: that field
 * does not exist on every variant, and code that assumes one secret per
 * connection silently mishandles the multi-header case.
 */
export const authKeyRefs = (auth: AuthSpec): string[] => {
  switch (auth.type) {
    case "none":
      return [];
    case "headers":
      return auth.parts.map((part) => part.keyRef);
    default:
      return [auth.keyRef];
  }
};

/**
 * Pagination is declared, never inferred.
 *
 * A wrong guess here does not produce an error — it produces the first page
 * and a chart that is quietly incomplete, which is the worst failure mode
 * this product has. The agent may propose a strategy, but it is surfaced for
 * confirmation rather than applied silently.
 */
export const paginationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("cursor"),
    /**
     * Path to the next cursor. Supports `$.data[last].id` for the very common
     * case where the cursor is simply the last record's id.
     */
    cursorPath: z.string().min(1),
    param: z.string().min(1),
    hasMorePath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("offset"),
    param: z.string().min(1),
    limitParam: z.string().min(1),
    pageSize: z.number().int().min(1).max(1000),
  }),
  z.object({
    kind: z.literal("page"),
    param: z.string().min(1),
    startsAt: z.number().int().min(0).default(1),
    limitParam: z.string().optional(),
    pageSize: z.number().int().min(1).max(1000).optional(),
  }),
  z.object({ kind: z.literal("link-header") }),
]);

export type PaginationSpec = z.infer<typeof paginationSchema>;

export const queryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * What an endpoint accepts, and — more usefully — what each input *does*.
 *
 * `role` is the load-bearing field. Every vendor spells the same idea
 * differently: `q` / `search` / `filter`, `since` / `start_date` / `created[gte]`.
 * Recording the role once means the rest of the product can offer "search this
 * endpoint" or "narrow this to a date range" without any caller knowing the
 * vendor's vocabulary. It is the same abstraction `pagination.kind` and
 * `dialect.timeFilter` already apply connection-wide, pushed down to one op.
 *
 * `in` is limited to path and query on purpose: a secret belongs in the auth
 * config, not in a per-op header the UI would invite someone to fill in.
 */
export const paramDefSchema = z.object({
  name: z.string().min(1).max(120),
  in: z.enum(["path", "query"]),
  type: z.enum(["string", "number", "boolean", "date"]).default("string"),
  required: z.boolean().default(false),
  /** Human label for the field. Falls back to `name`. */
  label: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  /** A closed set of accepted values, so the UI can offer a picker. */
  enum: z.array(queryValueSchema).max(50).optional(),
  default: queryValueSchema.optional(),
  example: queryValueSchema.optional(),
  role: z.enum(["id", "search", "rangeStart", "rangeEnd", "sort", "filter"]).optional(),
});

export type ParamDef = z.infer<typeof paramDefSchema>;

/**
 * Every `{{param.x}}` token in a path, in the order it appears.
 *
 * Lives here rather than with the connection schema because reading a path's
 * shape is what tells `resource.ts` a collection from a record — and
 * `connection.ts` imports `resource.ts`, so the other direction is a cycle.
 */
export const pathParamNames = (path: string): string[] => [
  ...new Set(
    [...path.matchAll(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g)].map((match) => match[1]!),
  ),
];

/**
 * FNV-1a. A fingerprint for drift detection, not a security hash.
 *
 * Lives here so the one implementation serves both a response's field set
 * (`inferShape`) and a connection's endpoint set (`opsFingerprint`). Two hashes
 * that drift apart would make "did this change?" answerable two different ways.
 */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
