import { z } from "zod";
import { fnv1a, idSchema } from "./primitives.js";
import type { ConnectionSpec, OpDef } from "./connection.js";
import { resourceSchema, type ResourceSpec } from "./resource.js";

/**
 * What a connection turned out to be, written down.
 *
 * Enumeration is by far the most expensive thing this product does — dozens of
 * real requests against somebody else's API — and until now its result lived in
 * a five-minute in-memory map. A restart threw away the one artifact nobody can
 * cheaply recreate, and the only way to get it back was to spend the requests
 * again.
 *
 * So it becomes a file, on the same terms as every other spec here: JSON on
 * disk, diffable, reviewable, owned by the self-hoster.
 *
 * **Privacy invariant.** A report carries field *names* and detected formats,
 * never field *values*. Sampling sees real business data; `InferredShape.samples`
 * holds up to three examples per field and those stay in memory and die with the
 * process. The same rule the LLM review already follows applies to disk.
 */

/** Why a resource is still unknown, in a form the UI can act on. */
export const unknownResourceSchema = z.object({
  resource: idSchema,
  title: z.string().min(1).max(120),
  reason: z.enum(["empty", "unsampled", "needsParent", "needsInput", "requestFailed", "aborted"]),
  recheckOp: idSchema.optional(),
  needs: z.array(z.string().max(120)).max(20).optional(),
  detail: z.string().max(500).optional(),
});

export type UnknownResourceRecord = z.infer<typeof unknownResourceSchema>;

export const drillDownSchema = z.object({
  resource: idSchema,
  title: z.string().min(1).max(120),
  listOp: idSchema,
  detailOp: idSchema,
  idField: z.string().max(120),
  detailParam: z.string().max(120),
  labelField: z.string().max(120).optional(),
  sampled: z.boolean().default(false),
});

export const joinSchema = z.object({
  from: idSchema,
  to: idSchema,
  title: z.string().min(1).max(240),
  foreignField: z.string().max(120),
  targetField: z.string().max(120),
  filterParam: z.string().max(120).optional(),
  needsFanOut: z.boolean().default(false),
});

/**
 * How the pass ended.
 *
 * `complete` and `budget` are both successes — one saw everything, the other
 * stopped where it was told to. `rateLimited` and `authRejected` are the pass
 * giving up early on purpose, and they are worth distinguishing because they
 * lead to different next steps: wait, versus fix the credential.
 */
export const enumerationOutcomeSchema = z.enum([
  "complete",
  "budget",
  "rateLimited",
  "authRejected",
]);

export type EnumerationOutcome = z.infer<typeof enumerationOutcomeSchema>;

/**
 * A sampled field, with the values removed.
 *
 * This is the privacy boundary made structural. `FieldInfo` as sampling
 * produces it carries up to three real example values per field; that half has
 * no representation here, so a value cannot reach disk through this door even
 * by accident. Everything retained is a fact *about* the data — its name, its
 * types, its detected format, how many distinct values were seen — never the
 * data itself.
 */
export const persistedFieldSchema = z.object({
  name: z.string().max(200),
  kinds: z.array(z.enum(["string", "number", "boolean", "object", "array", "null"])).max(6),
  nullable: z.boolean().default(false),
  format: z
    .enum(["iso8601", "unix_seconds", "unix_millis", "email", "url", "minor_units"])
    .optional(),
  distinct: z.number().int().min(0).default(0),
});

export type PersistedField = z.infer<typeof persistedFieldSchema>;

export const persistedShapeSchema = z.object({
  rowsPath: z.string().max(200),
  rowCount: z.number().int().min(0).default(0),
  schemaHash: z.string().max(64).default(""),
  fields: z.array(persistedFieldSchema).max(200).default([]),
});

export type PersistedShape = z.infer<typeof persistedShapeSchema>;

export const CAPABILITY_REPORT_VERSION = 1;

export const capabilityReportSchema = z.object({
  /** Schema version of this document, not a revision counter. */
  schemaVersion: z.number().int().min(1).default(CAPABILITY_REPORT_VERSION),
  connection: idSchema,
  /** Bumped every time the report is rewritten. */
  revision: z.number().int().min(1).default(1),
  generatedAt: z.string().datetime(),
  /**
   * Fingerprint of the endpoints this was derived from.
   *
   * When it stops matching the connection, the report describes an API that no
   * longer exists in the shape we recorded — see {@link isStale}.
   */
  opsFingerprint: z.string().min(1).max(64),

  resources: z.array(resourceSchema).max(400).default([]),
  drillDowns: z.array(drillDownSchema).max(400).default([]),
  joins: z.array(joinSchema).max(400).default([]),
  unknowns: z.array(unknownResourceSchema).max(400).default([]),
  searchable: z.array(z.object({ op: idSchema, param: z.string().max(120) })).max(400).default([]),
  rangeFilterable: z
    .array(z.object({ op: idSchema, start: z.string().max(120), end: z.string().max(120).optional() }))
    .max(400)
    .default([]),

  /**
   * What sampling learned about each resource's rows, minus the rows.
   *
   * Rich enough that suggestions can be rebuilt from disk after a restart —
   * which is the point: without it, reopening the drawer would re-spend the
   * whole request budget, the exact thing this report exists to prevent.
   */
  shapes: z.record(persistedShapeSchema).default({}),

  outcome: enumerationOutcomeSchema.default("complete"),
  /** Real requests this pass cost, so "look deeper" can be priced honestly. */
  requestsSpent: z.number().int().min(0).default(0),
  /** Set when the pass stopped early; pairs with a `rateLimited` outcome. */
  retryAfter: z.string().max(40).optional(),
  notes: z.array(z.string().max(500)).max(100).default([]),
});

export type CapabilityReport = z.infer<typeof capabilityReportSchema>;

export const parseCapabilityReport = (
  input: unknown,
): { ok: true; value: CapabilityReport } | { ok: false; error: string } => {
  const parsed = capabilityReportSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.message };
};

/**
 * Fingerprint the endpoint set a report was built from.
 *
 * Id and path only. A title change is cosmetic and must not invalidate a report
 * that cost forty requests; a path change means we are looking at a different
 * endpoint and the recorded shape may be wrong.
 */
export const fingerprintOps = (ops: readonly OpDef[]): string =>
  fnv1a(
    [...ops]
      .map((op) => `${op.id}:${op.path}`)
      .sort()
      .join("\n"),
  );

/**
 * Does this report still describe this connection?
 *
 * Deliberately a question and not an action. A stale report is surfaced, never
 * silently refreshed — re-enumerating costs real requests, and spending them
 * without being asked is the whole thing the consent step exists to prevent.
 */
export const isStale = (report: CapabilityReport, connection: ConnectionSpec): boolean =>
  report.opsFingerprint !== fingerprintOps(connection.ops);

/* ── drift ────────────────────────────────────────────────────────────── */

export interface ReportDiff {
  readonly addedResources: readonly string[];
  readonly removedResources: readonly string[];
  /** Identity changed out from under us — bindings built on it are suspect. */
  readonly changedIdFields: ReadonlyArray<{ resource: string; from?: string; to?: string }>;
  readonly verifiedGained: readonly string[];
  readonly verifiedLost: readonly string[];
  readonly resolvedUnknowns: readonly string[];
  readonly newUnknowns: readonly string[];
  readonly changed: boolean;
}

const relationKey = (resource: string, relation: { id: string }): string =>
  `${resource}.${relation.id}`;

const verifiedRelations = (resources: readonly ResourceSpec[]): Set<string> => {
  const out = new Set<string>();
  for (const resource of resources) {
    for (const relation of resource.relations) {
      if (relation.verified) out.add(relationKey(resource.id, relation));
    }
  }
  return out;
};

/**
 * What changed between two readings of the same API.
 *
 * The point is that drift is visible rather than merely detected. An id field
 * that changed is the dangerous one — every drill-down and join was built on
 * it — so it is called out separately rather than folded into "resource
 * changed".
 */
export const diffReports = (prev: CapabilityReport, next: CapabilityReport): ReportDiff => {
  const before = new Map(prev.resources.map((resource) => [resource.id, resource]));
  const after = new Map(next.resources.map((resource) => [resource.id, resource]));

  const addedResources = [...after.keys()].filter((id) => !before.has(id));
  const removedResources = [...before.keys()].filter((id) => !after.has(id));

  const changedIdFields: Array<{ resource: string; from?: string; to?: string }> = [];
  for (const [id, resource] of after) {
    const was = before.get(id);
    if (!was) continue;
    if (was.idField !== resource.idField) {
      changedIdFields.push({
        resource: id,
        ...(was.idField ? { from: was.idField } : {}),
        ...(resource.idField ? { to: resource.idField } : {}),
      });
    }
  }

  const wasVerified = verifiedRelations(prev.resources);
  const nowVerified = verifiedRelations(next.resources);
  const verifiedGained = [...nowVerified].filter((key) => !wasVerified.has(key));
  const verifiedLost = [...wasVerified].filter((key) => !nowVerified.has(key));

  const wasUnknown = new Set(prev.unknowns.map((unknown) => unknown.resource));
  const nowUnknown = new Set(next.unknowns.map((unknown) => unknown.resource));
  const resolvedUnknowns = [...wasUnknown].filter((id) => !nowUnknown.has(id));
  const newUnknowns = [...nowUnknown].filter((id) => !wasUnknown.has(id));

  return {
    addedResources,
    removedResources,
    changedIdFields,
    verifiedGained,
    verifiedLost,
    resolvedUnknowns,
    newUnknowns,
    changed:
      addedResources.length > 0 ||
      removedResources.length > 0 ||
      changedIdFields.length > 0 ||
      verifiedGained.length > 0 ||
      verifiedLost.length > 0 ||
      resolvedUnknowns.length > 0 ||
      newUnknowns.length > 0,
  };
};

/* ── the allowlist ────────────────────────────────────────────────────── */

export interface AllowedOp {
  readonly id: string;
  readonly title: string;
  readonly resource?: string;
  /** Inputs the caller may supply, by name. Nothing else is accepted. */
  readonly params: readonly string[];
  /** Inputs with no default that must be supplied for the call to succeed. */
  readonly required: readonly string[];
  /** Requests one call costs, before pagination. */
  readonly cost: number;
}

export interface CapabilityAllowlist {
  readonly connection: string;
  readonly ops: readonly AllowedOp[];
  /**
   * Always true today. Connections are GET-only by construction, and the flag
   * exists so a future write path has to set it deliberately rather than
   * arriving by omission.
   */
  readonly readOnly: true;
}

/**
 * The capability surface an agent or chat turn is confined to.
 *
 * Deny-by-default falls out of the structure: a caller may only name an op that
 * appears here, with an input that appears on it. There is no badness
 * classifier to outwit, because nothing is being classified — an op is either
 * in the list or it does not exist as far as the caller is concerned.
 *
 * Built from the report rather than from the connection on purpose. The report
 * is what a real request proved; the connection is only what a specification
 * claimed.
 */
export const toAllowlist = (
  report: CapabilityReport,
  connection: ConnectionSpec,
): CapabilityAllowlist => {
  const resourceForOpId = new Map<string, string>();
  for (const resource of report.resources) {
    if (resource.listOp) resourceForOpId.set(resource.listOp, resource.id);
    if (resource.detailOp) resourceForOpId.set(resource.detailOp, resource.id);
  }

  const ops: AllowedOp[] = connection.ops.map((op) => {
    const resource = resourceForOpId.get(op.id);
    return {
      id: op.id,
      title: op.title,
      ...(resource ? { resource } : {}),
      params: op.params.map((param) => param.name),
      required: op.params
        .filter((param) => param.required && param.default === undefined)
        .map((param) => param.name),
      cost: 1,
    };
  });

  return { connection: report.connection, ops, readOnly: true };
};
