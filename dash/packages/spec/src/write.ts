import { z } from "zod";
import { authSchema, idSchema, paramDefSchema, queryValueSchema } from "./primitives.js";

/**
 * What an API accepts, as opposed to what it returns.
 *
 * Reads are GET by construction — `opDefSchema.method` is a literal — and
 * that guarantee stays exactly as it was: every widget, keeper target, brief
 * and query names an op from `ops`, and none of them can name one of these.
 * An endpoint that changes something lives here instead, in its own list on
 * the catalog entry, and the only code that can send one is the write
 * service, which never sends anything a person has not reviewed.
 *
 * Kept apart rather than widening `method` for a structural reason as much as
 * a safety one: everything that derives the resource graph walks `ops` and
 * assumes one endpoint per path. `POST /leases` beside `GET /leases` would be
 * read as a second collection of leases.
 */

export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export const writeMethodSchema = z.enum(WRITE_METHODS);
export type WriteMethod = z.infer<typeof writeMethodSchema>;

/**
 * Bumped when the importer's reading of write endpoints changes shape. Only
 * an explicit "read write endpoints" refreshes an entry — never discovery on
 * its own — so this marks what is outdated rather than triggering anything.
 */
export const WRITES_VERSION = 1;

/**
 * One value the request body takes.
 *
 * Declared by the API, so it travels with the catalog entry. `readFrom` is
 * the one fact about it that is not in the specification: where the record's
 * *current* value lives on the read side. The two shapes are not the same —
 * Buildium sends `PropertyManagerId` and returns `RentalManager.Id` — and an
 * update that replaces the whole record has to send every value it means to
 * keep, so this mapping is what stops an edit to one field from clearing
 * another.
 */
export const writeFieldSchema = z.object({
  /** Dotted into the body; array items as `Units[].UnitNumber`, one level only. */
  path: z.string().min(1).max(200),
  label: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
  /** As the spec wrote it: `date`, `date-time`, `int32`, `email`… */
  format: z.string().max(40).optional(),
  required: z.boolean().default(false),
  nullable: z.boolean().optional(),
  /** The closed set of accepted values. Kept whole — a picker needs all of them. */
  enum: z.array(z.string().max(200)).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  maxLength: z.number().int().optional(),
  /** Scalars inside an array: `RentalOwnerIds: [1, 2]`. */
  items: z.enum(["string", "number", "integer", "boolean"]).optional(),
  /**
   * The read-side path holding this field's current value, `null` when it has
   * been looked for and is not there, absent when nobody has looked.
   */
  readFrom: z.string().max(200).nullable().optional(),
  mappedBy: z.enum(["name", "model", "person"]).optional(),
  /** The record type an id here names, which is what makes it a picker. */
  reference: z
    .object({ entity: idSchema, holds: z.enum(["scalar", "array"]).default("scalar") })
    .optional(),
  /** Server-managed, or not something a person sets. Never shown in a form. */
  hidden: z.boolean().optional(),
});

export type WriteField = z.infer<typeof writeFieldSchema>;

export const writeBodySchema = z.object({
  contentType: z.string().max(120).default("application/json"),
  fields: z.array(writeFieldSchema).default([]),
  /**
   * Why this body cannot be built from a form — `multipart/form-data`, a
   * body that is a bare array. The endpoint is kept, so it is known about,
   * and never offered.
   */
  unsupported: z.string().max(200).optional(),
});

export type WriteBody = z.infer<typeof writeBodySchema>;

export const writeOpDefSchema = z.object({
  /** Unique among writes. A separate namespace from `ops`. */
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(400).optional(),
  method: writeMethodSchema,
  /** Appended to the connection's baseUrl, `{{param.x}}` for path inputs. */
  path: z.string().min(1),
  params: z.array(paramDefSchema).max(60).default([]),
  query: z.record(z.string(), queryValueSchema).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  auth: authSchema.optional(),
  authRequired: z.boolean().optional(),
  body: writeBodySchema.optional(),
  /** What a success answers with: the record, nothing, or the spec did not say. */
  returns: z.enum(["record", "none", "unknown"]).default("unknown"),
  /**
   * `declared` when the API's specification stated it; `inferred` when it was
   * read out of prose documentation. Both are offered — every change is shown
   * as a review before anything is sent, and an inferred one says so there.
   * `confirmed: false` switches an endpoint off, for one that turned out wrong.
   */
  confidence: z.enum(["declared", "inferred"]).default("declared"),
  confirmed: z.boolean().optional(),
  /** True once a real request through this endpoint succeeded. */
  verified: z.boolean().default(false),
});

export type WriteOpDef = z.infer<typeof writeOpDefSchema>;

/**
 * A list of writes that never fails as a whole.
 *
 * A catalog entry that fails its schema is dropped from the catalog without a
 * word (`CatalogStore` skips it), so one malformed write endpoint must cost
 * that endpoint and nothing else — least of all the two hundred read
 * endpoints and every record type described beside it.
 */
export const writesListSchema = z
  .array(z.unknown())
  .default([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = writeOpDefSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/** A path's shape with its parameter names removed, so two spellings compare. */
export const pathShape = (path: string): string =>
  path.replace(/\{\{\s*param\.[^}]*\}\}/g, "{}").replace(/\/+$/, "");

/* ── what travels between the server and a browser ─────────────────── */

/** One value, before and after, as a review shows it. */
export interface WriteDiffRow {
  readonly field: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
}

/** The change a person is about to say yes to. */
export interface WriteReviewView {
  readonly pendingId: string;
  readonly digest: string;
  readonly connection: string;
  readonly connectionTitle: string;
  readonly entity: string;
  readonly entityName: string;
  readonly kind: "create" | "update" | "delete" | "action";
  /** create, replace, merge, delete, action — or `upsert:create` / `upsert:update`. */
  readonly mode: string;
  readonly title: string;
  /** One sentence: what is about to happen, to which record, on which account. */
  readonly summary: string;
  /** The record's name as it is now, where it has one. */
  readonly record?: string | undefined;
  readonly rows: readonly WriteDiffRow[];
  readonly warnings: readonly string[];
  /** Cannot be undone through this API. */
  readonly danger: boolean;
  readonly unverified: boolean;
  readonly inferred: boolean;
  readonly expiresAt: string;
}

/** One value a form asks for. */
export interface WriteFormField {
  readonly field: string;
  readonly label: string;
  readonly type: WriteField["type"];
  readonly required: boolean;
  readonly format?: string | undefined;
  readonly options?: readonly string[] | undefined;
  /** The record type an id here names — what makes it a picker. */
  readonly references?: string | undefined;
  /** Where its current value is read from; `null` when it could not be found. */
  readonly readFrom?: string | null | undefined;
}

/** A form, and the values it opens with. */
export interface WriteFormView {
  readonly kind: WriteReviewView["kind"];
  readonly mode: string;
  readonly title: string;
  /** For something that exists at most once under its parent: whether it does yet. */
  readonly exists: boolean;
  readonly confirmed: boolean;
  readonly verified: boolean;
  readonly confidence: "declared" | "inferred";
  readonly action?: { readonly id: string; readonly danger: boolean; readonly pairedWith?: string } | undefined;
  readonly fields: readonly WriteFormField[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** Something wrong with one value, said so a person can fix it. */
export interface WriteFieldError {
  readonly field: string;
  readonly label: string;
  readonly message: string;
}

/** What a sent change came back with. */
export interface WriteCommitView {
  readonly status: "succeeded";
  readonly connection: string;
  readonly entity: string;
  readonly kind: WriteReviewView["kind"];
  readonly key?: { readonly id?: string; readonly parents?: Readonly<Record<string, string>> } | undefined;
  readonly record?: unknown;
  readonly changed: readonly string[];
  readonly invalidated: { readonly connection: string; readonly ops: readonly string[] };
  readonly title: string;
}
