import { z } from "zod";
import { fieldFormatSchema } from "./coercion.js";
import { entitySchema } from "./entity.js";
import { CATEGORIES_MAX, categorySchema, profileSchema } from "./category.js";
import { authSchema, paginationSchema, paramDefSchema, queryValueSchema } from "./primitives.js";
import { resourceSchema } from "./resource.js";

/**
 * A dialect is "how this vendor does things", declared once per API.
 *
 * The observation it encodes: endpoints on the same API almost never differ in
 * auth, pagination, envelope shape or date convention — they differ in a path
 * and a set of field names. Repeating the hard parts per endpoint is where
 * mistakes come from, so they are stated once and inherited.
 *
 * Everything here is optional, and an individual op may override any of it.
 * Real APIs are inconsistent (GitHub takes `since` on some endpoints and
 * `created` on others), so this is inheritance, not a straitjacket.
 */

export const timeFormatSchema = z.enum(["unix", "unix_ms", "iso", "date"]);

export type TimeFormat = z.infer<typeof timeFormatSchema>;

export const timeFilterSchema = z.object({
  /** Query param carrying the start of the range, e.g. `created[gte]`. */
  param: z.string().min(1),
  /** Optional param carrying the end. Omit for open-ended "since" filters. */
  endParam: z.string().optional(),
  format: timeFormatSchema.default("iso"),
});

export type TimeFilterSpec = z.infer<typeof timeFilterSchema>;

export const dialectSchema = z.object({
  auth: authSchema.optional(),
  pagination: paginationSchema.optional(),
  /** Where the row list lives in a response, e.g. `$.data`. */
  rowsPath: z.string().optional(),
  /**
   * How this API filters by date. Declared once here, the range token is then
   * injected into every time-filtered op automatically — users never hand-write
   * `{{range.start | unix}}`.
   */
  timeFilter: timeFilterSchema.optional(),
  /** Sent on every request, e.g. an API version header. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Merged into every request's query, e.g. a fixed page size. */
  query: z.record(z.string(), queryValueSchema).default({}),
  maxPages: z.number().int().min(1).max(50).optional(),
});

export type DialectSpec = z.infer<typeof dialectSchema>;

/**
 * The handful of shapes endpoints actually come in. These are code, shared by
 * every API — the part that never needs storing.
 */
export const archetypeSchema = z.enum(["list", "summary", "timeseries"]);

export type Archetype = z.infer<typeof archetypeSchema>;

export interface ArchetypeDef {
  readonly id: Archetype;
  readonly title: string;
  readonly description: string;
  /** Whether the dialect's pagination applies. */
  readonly paginates: boolean;
  /** Whether the dialect's time filter is injected. */
  readonly timeFiltered: boolean;
  /**
   * Whether this endpoint returns a collection.
   *
   * A dialect's `rowsPath` is inherently a statement about *list* envelopes
   * ("rows live at `$.data`"), so it must not be inherited by an endpoint that
   * is not a collection — `/v1/balance` has no `$.data` to find.
   */
  readonly collection: boolean;
  /** Used when nothing applicable is inherited. */
  readonly defaultRowsPath: string | undefined;
  readonly defaultMaxPages: number;
}

export const ARCHETYPES: Readonly<Record<Archetype, ArchetypeDef>> = {
  list: {
    id: "list",
    title: "List of records",
    description: "A paginated collection — charges, issues, orders. By far the most common shape.",
    paginates: true,
    timeFiltered: true,
    collection: true,
    defaultRowsPath: undefined,
    defaultMaxPages: 5,
  },
  summary: {
    id: "summary",
    title: "Summary object",
    description:
      "One object of scalars — totals and metrics. Where current-vs-previous comparisons come from.",
    paginates: false,
    timeFiltered: true,
    collection: false,
    defaultRowsPath: "$",
    defaultMaxPages: 1,
  },
  timeseries: {
    id: "timeseries",
    title: "Pre-bucketed series",
    description: "The API already grouped by day or hour, so the pipeline does not have to.",
    paginates: true,
    timeFiltered: true,
    collection: true,
    defaultRowsPath: undefined,
    defaultMaxPages: 3,
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as Archetype[];

/**
 * One field an endpoint is *declared* to return.
 *
 * Deliberately not `persistedFieldSchema`, which comes from the report and
 * carries `distinct` — a count of values actually seen. Nothing here has been
 * seen. A spec is a description, not a proof, and a shape that could not
 * express "I know the name and type but have never looked at a value" would
 * quietly turn one into the other.
 */
export const mappedFieldSchema = z.object({
  /** Dotted for one level of nesting, matching what `inferShape` produces. */
  name: z.string().min(1).max(200),
  /** JSON kinds, in the same vocabulary the shape inferrer uses. */
  kinds: z.array(z.enum(["string", "number", "boolean", "object", "array", "null"])).max(6),
  nullable: z.boolean().default(false),
  format: fieldFormatSchema.optional(),
  /** Whatever the spec said this field is, when it said anything. */
  description: z.string().max(300).optional(),
  /**
   * The closed set of values the spec says this field can hold.
   *
   * A fact about the API, so it travels with the map: "Status is one of New,
   * InProgress, Completed" is true for everybody who connects it, and knowing
   * it before a single row is read is what lets a filter strip offer a value
   * an account happens to have none of. Which values an account *uses* is a
   * different question and belongs to that install, never here.
   *
   * Capped, because past a couple of dozen it is an identifier rather than a
   * category and listing it teaches nothing.
   *
   * Optional rather than defaulted: this is stored once per field per
   * endpoint — 1,508 of them on a real API — and an always-present empty array
   * is bytes spent to say nothing.
   */
  values: z.array(z.string().max(120)).max(50).optional(),
  /*
   * No `label` here, deliberately.
   *
   * There was one, and nothing ever wrote it — an extension point kept for the
   * case where one endpoint's field means something other than the same name
   * elsewhere on the API. What arrived instead was the record type's own field
   * dictionary, where `EntityField.label` is written, read, and is what every
   * screen actually renders. Two places to look for a label is one too many,
   * and the empty one wins arguments it should lose.
   */
});

export type MappedField = z.infer<typeof mappedFieldSchema>;

/** Bumped when the mapping pass changes shape enough to need re-running. */
export const MAP_VERSION = 1;

/** A dialect plus the metadata needed to publish it in a catalog. */
export const catalogEntrySchema = z.object({
  specVersion: z.literal(1).default(1),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "catalog ids must be lowercase [a-z0-9-]"),
  title: z.string().min(1),
  baseUrl: z.string().url(),
  dialect: dialectSchema,
  /** Unconfirmed import hint. Never executed until explicitly declared. */
  paginationProposal: paginationSchema.optional(),
  /** Suggested endpoints, so a new connection starts useful rather than empty. */
  ops: z
    .array(
      z.object({
        id: z.string().min(1),
        auth: authSchema.optional(),
        authRequired: z.boolean().optional(),
        title: z.string().min(1),
        path: z.string().min(1),
        archetype: archetypeSchema.default("list"),
        rowsPath: z.string().optional(),
        pagination: paginationSchema.optional(),
        maxPages: z.number().int().min(1).max(100).optional(),
        headers: z.record(z.string()).optional(),
        /** Mirrors `opDefSchema.params` — see primitives.ts. */
        params: z.array(paramDefSchema).max(60).default([]),
        query: z.record(z.string(), queryValueSchema).default({}),
        /**
         * What this endpoint is for, in a sentence.
         *
         * The API author's own words where the spec supplied them, and the
         * mapping pass's where it did not. On an API where two hundred
         * endpoints are all titled "Retrieve all X", this is the only thing
         * that tells them apart — and choosing between them is the first
         * decision made when a widget is built.
         */
        description: z.string().max(400).optional(),
        /**
         * The fields this endpoint declares it returns.
         *
         * Read from the response schema, so it costs nothing and covers the
         * endpoints that cannot be called without an id — which is most of
         * them on a real API. Absent means the spec described no response;
         * empty means it described one with no fields.
         */
        fields: z.array(mappedFieldSchema).max(300).optional(),
      }),
    )
    .default([]),
  /** Derived relationships between those ops. */
  resources: z.array(resourceSchema).max(200).default([]),
  /**
   * The record types this API exposes, described for the people using them.
   *
   * The layer that makes an integration worth sharing. `resources` is the
   * structure read out of the URLs — which endpoint lists a thing and which
   * returns one — and says nothing about what the thing *is*. An entity says
   * that: what it is called, which field identifies it, how to say its name,
   * what each field means, which of its fields point at other records, and
   * what a list and a page of them should look like.
   *
   * Every part of it is a fact about the API rather than about an account, so
   * it travels with this entry exactly as the relations and the labels do —
   * and the second person to connect this API starts where the first finished.
   */
  entities: z.array(entitySchema).max(300).default([]),
  /** When the entity pass last ran, and against which version of it. */
  entitiesAt: z.string().optional(),
  entityVersion: z.number().int().min(1).optional(),
  entityProgress: z
    .object({ version: z.number().int(), batches: z.array(z.string()).max(2000) })
    .optional(),
  /**
   * Which batches of the view pass have already run.
   *
   * No version beside it, unlike the map and the entity passes. Those two
   * produce the artifact everything else is built on, so a change to either
   * has to be able to mark existing work stale. A view is the topmost layer
   * and every slot in it falls back to a working default, so a better pass is
   * worth re-running when somebody wants it and never worth nagging about.
   */
  viewProgress: z.object({ batches: z.array(z.string()).max(2000) }).optional(),

  /**
   * What this API is for, in a sentence.
   *
   * Shown while somebody is deciding which parts of it they want, because the
   * questions only read as questions with it: "these are the parts of a
   * property management system" is answerable and "these are eight groups of
   * endpoints" is not.
   */
  profile: profileSchema.optional(),
  /**
   * How this API's records divide up, and where to start with each division.
   *
   * The layer that makes a new connection open with something rather than
   * nothing. Leasing, maintenance and accounting are one API's own divisions;
   * no rule here could name them, because they are facts about the domain
   * rather than about the schema — and they are facts about the *API* rather
   * than about an account, which is what puts them in this entry alongside the
   * relations and the record types. Each carries the widget set it opens with,
   * as briefs rather than widgets. See `category.ts` for why that distinction
   * is load-bearing.
   */
  categories: z.array(categorySchema).max(CATEGORIES_MAX).default([]),
  /** When the categorising pass last ran, and against which version of it. */
  categoriesAt: z.string().optional(),
  categoryVersion: z.number().int().min(1).optional(),
  /**
   * Which starter sets have already been written.
   *
   * One batch per category, so a run that lost a call keeps the categories it
   * finished and picks up the rest — the same bargain the map and entity
   * passes strike, and for the same reason: re-running costs what the first
   * run cost.
   */
  categoryProgress: z
    .object({ version: z.number().int(), batches: z.array(z.string()).max(2000) })
    .optional(),
  /**
   * When the descriptions were last checked against a live account.
   *
   * Distinct from `verified` above, which is about the dialect: that says rows
   * came back where the dialect claimed they would, this says a real response
   * carried the field a record type calls its identity and that its links
   * resolved. The per-entity flags hold what was actually settled; this only
   * says when somebody last spent the quota to ask.
   */
  entitiesVerifiedAt: z.string().optional(),
  /**
   * When the mapping pass last ran, and against which version of it.
   *
   * Absent means this entry was imported but never mapped — which is what the
   * "this integration does not exist yet" prompt is asking about. An older
   * `mapVersion` means the pass has changed shape since and is worth re-running.
   */
  mappedAt: z.string().optional(),
  mapVersion: z.number().int().min(1).optional(),
  mapProgress: z
    .object({ version: z.number().int(), batches: z.array(z.string()).max(2000) })
    .optional(),
  validateOpId: z.string().optional(),
  docsUrl: z.string().url().optional(),
  /**
   * Where the machine-readable description of this API was read from.
   *
   * Recorded so the field schemas can be re-read later without the map going
   * with them. Field lists come from the import and the relations come from
   * the mapping pass, and until this existed the only way to refresh the first
   * was to replace the whole entry — which discarded the second. An entry that
   * cannot say where it came from cannot be corrected, only rebuilt.
   */
  specUrl: z.string().url().optional(),
  /**
   * How this API does relationships, in prose, for the next reader.
   *
   * The API-level companion to a relation's own `notes`. Some conventions are
   * not properties of any single link: that a parent is addressed by two
   * parameters together, that ids are strings on one module and numbers on
   * another, that a collection has to be filtered before it returns anything
   * useful. Nothing in a schema states those, and everyone who connects this
   * API has to work them out again.
   *
   * Written by whoever mapped it — a person or the mapping pass — and shipped
   * with the entry, because the whole point of the catalog is that the second
   * person to use an API starts where the first one finished.
   */
  notes: z.string().max(2000).optional(),
  /** Where to get a key and which scopes to tick. Shown during onboarding. */
  keyHelp: z.string().optional(),
  /**
   * The API needs a key, but the description never said how it is sent.
   *
   * Distinct from `dialect.auth.type === "none"`, which asserts that no key is
   * needed at all. Plenty of specs omit `securitySchemes` while every endpoint
   * still requires credentials. Guessing a scheme would be inventing fact, so
   * this records only what is known: a key is required, and the user has to
   * say where it goes.
   */
  authRequired: z.boolean().default(false),
  /** How this entry came to exist — shown so a guess is never mistaken for fact. */
  origin: z.enum(["repo", "openapi", "docs", "manual"]).default("manual"),
  /** True once a real request against this dialect returned usable rows. */
  verified: z.boolean().default(false),
  updatedAt: z.string().optional(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Render a range bound in whatever format this API expects. */
export const formatRangeToken = (bound: "start" | "end", format: TimeFormat): string =>
  `{{range.${bound} | ${format}}}`;
