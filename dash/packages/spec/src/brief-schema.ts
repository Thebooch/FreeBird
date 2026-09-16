import { z } from "zod";
import { fieldPathSchema } from "./entity.js";
import { idSchema } from "./primitives.js";

/*
 * A brief's own shape, with no dependency on what it compiles into.
 *
 * Split from the compiler so a widget can carry the brief it was built from:
 * `widgetSchema` needs this schema, and `compileBrief` needs `parseWidget`, so
 * leaving them in one file would make the two modules import each other — a
 * cycle that zod resolves at load time by handing one of them `undefined`.
 * Nothing here knows about widgets, which is what makes that impossible rather
 * than merely avoided.
 */

/**
 * What somebody asked for, and the widget that answers it.
 *
 * The layer that replaces an endpoint hunt with a sentence. Everything a
 * widget needs used to be assembled per request from raw endpoint shapes —
 * which endpoint, which of its fields plays which role, what to group by —
 * and most of those questions have the same answer every time for a given
 * kind of record. A brief states only what is *particular* to this request;
 * the record type and its kind's recipe supply the rest.
 *
 * **Intent is stated, never inferred.** This is the whole of the fix for the
 * failure that started this: asked for "tasks with a filter by category", the
 * old path produced a bar chart of task counts per category, because "filter
 * by category" and "grouped by category" were the same thing to it — a
 * grouping was the only way to express either. Here they are different
 * intents. `records` is a list of records that a reader narrows with a filter
 * strip, and it cannot become a chart; `compare` is a chart, and it requires
 * something to group by. No wording can slide from one to the other.
 *
 * Deterministic and pure: the same brief over the same record type always
 * compiles to the same widget. A model's only job is to write the brief, which
 * is a handful of names it can be checked against — not a pipeline it could
 * get subtly wrong.
 */

export const WIDGET_INTENTS = ["records", "measure", "compare"] as const;

/**
 * What the widget is for.
 *
 * - `records`  the records themselves, narrowed by filter strips.
 * - `measure`  one number about them: how many, or how much.
 * - `compare`  that number broken down by something, as a chart.
 */
export type WidgetIntent = (typeof WIDGET_INTENTS)[number];

export const ALONGSIDE_MODES = ["join", "beside"] as const;

/**
 * How a second record type is brought in beside the first.
 *
 * - `join`   what else is true of this row: the other record's fields, on it.
 * - `beside` how these two compare: two measurements over one axis.
 *
 * They are not two spellings of one thing. A join matches rows against each
 * other and needs something to match *on*; a comparison matches nothing —
 * neither set of rows is an attribute of the other, and asked for listings per
 * month against applications per month, a join has nothing to work with. The
 * `combineSchema` comment draws the same line from the runtime's side.
 */
export type AlongsideMode = (typeof ALONGSIDE_MODES)[number];

/**
 * A brief, as a shape that can arrive over the wire.
 *
 * Needed because a brief is no longer only something a model writes: the
 * manual builder assembles one by hand, and both go through the same compiler
 * — which is what stops a hand-built widget and a described one disagreeing
 * about what the same request means.
 */
export const widgetBriefSchema = z.object({
  entity: idSchema,
  intent: z.enum(WIDGET_INTENTS),
  title: z.string().max(120).optional(),
  view: z.enum(["table", "cards", "list", "feed"]).optional(),
  columns: z.array(fieldPathSchema).max(12).optional(),
  filters: z
    .array(
      z.object({
        field: fieldPathSchema,
        values: z.array(z.string().max(120)).max(20).optional(),
      }),
    )
    .max(4)
    .optional(),
  linked: z
    .array(
      z.object({
        through: fieldPathSchema,
        field: fieldPathSchema,
        label: z.string().min(1).max(60).optional(),
      }),
    )
    .max(4)
    .optional(),
  sort: z.object({ field: fieldPathSchema, dir: z.enum(["asc", "desc"]).optional() }).optional(),
  groupBy: fieldPathSchema.optional(),
  measure: z
    .object({ agg: z.enum(["count", "sum"]), field: fieldPathSchema.optional() })
    .optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  alongside: z
    .object({ entity: idSchema, as: z.enum(ALONGSIDE_MODES).optional() })
    .optional(),
});

export interface WidgetBrief {
  /** The record type this is about. */
  readonly entity: string;
  readonly intent: WidgetIntent;
  /** What to call it. Defaults to the record type's own plural. */
  readonly title?: string | undefined;
  /**
   * How a list of records should read.
   *
   * Absent takes the record type's own kind — work reads as a table, a place
   * as cards — which is right often enough that almost nobody says. Present
   * when somebody did, and still refused rather than mangled: a card with
   * nothing to call it and a feed with no date cannot be bound, so a view that
   * will not bind falls back to a table and says so.
   */
  readonly view?: "table" | "cards" | "list" | "feed" | undefined;
  /** Fields to show. Absent takes the record type's own default view. */
  readonly columns?: readonly string[] | undefined;
  /**
   * Fields to offer as filter strips, and what to start them narrowed to.
   *
   * `values` is where a scope phrase lands. "Maintenance tasks" is a list of
   * tasks with the category strip already narrowed to maintenance — visible,
   * and one click from being widened — rather than a filter baked into the
   * pipeline where the reader can neither see it nor undo it.
   *
   * A value that matches nothing in the data is dropped by the strip itself,
   * so the widget shows everything rather than nothing. That is what makes an
   * approximate value safe to carry: the worst case is the unnarrowed list the
   * reader would otherwise have got.
   */
  readonly filters?: readonly { readonly field: string; readonly values?: readonly string[] }[];
  /**
   * Columns read *through* a reference — a task's vendor's phone number.
   *
   * `through` is a field on these records that holds another record's
   * identity; `field` is what to read on that record. The value lives on a
   * different record entirely, so no pipeline over this endpoint could produce
   * it — it is filled in from the record the reference already points at.
   */
  readonly linked?: readonly {
    readonly through: string;
    readonly field: string;
    readonly label?: string;
  }[];
  readonly sort?: { readonly field: string; readonly dir?: "asc" | "desc" } | undefined;
  /** What a comparison is broken down by. Required for `compare`. */
  readonly groupBy?: string | undefined;
  /** What is counted or totalled. Defaults to counting records. */
  readonly measure?: { readonly agg: "count" | "sum"; readonly field?: string } | undefined;
  readonly limit?: number | undefined;
  /**
   * A second record type, brought in beside this one.
   *
   * The one thing a brief could not say. A brief names a record type, so "my
   * vendors alongside their open work orders" fell through to a planner that
   * hunted endpoints — and everything the entity-first path had established
   * about which records those were went with it.
   *
   * The link itself is never stated here, because it is never a matter of
   * opinion: the record types already record which fields point at which, in
   * both directions, with what each one costs to reach. Naming the second
   * record type is the whole of what a request adds.
   */
  readonly alongside?: { readonly entity: string; readonly as?: AlongsideMode } | undefined;
}
