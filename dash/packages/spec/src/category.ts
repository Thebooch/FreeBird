import { z } from "zod";
import {
  CATEGORIES_MAX,
  catalogEntrySchema as apiCatalogEntrySchema,
  categoriesSchemaOf,
  categorySchemaOf,
  connectionSchema as apiConnectionSchema,
  idSchema,
} from "@freebirdai/connect-spec";
import { widgetBriefSchema } from "./brief-schema.js";
import { dashboardSchema } from "./dashboard.js";

/**
 * Dash's half of an API's categories: the starter widgets each one opens
 * with, and one connection's onboarding.
 *
 * The categories themselves, the profile and the catalog entry they sit on
 * describe the API and live in `@freebirdai/connect-spec`. That package
 * stores a category's starters and a connection's onboarding without reading
 * them; the schemas here are the same records with Dash's own parts typed, so
 * everything Dash reads and writes is validated exactly as it was before the
 * split.
 */

/**
 * How large a starter wants to be, named rather than measured.
 *
 * A variant name from the component's **own** `grid.sizes` — `sm`, `md`, `lg`
 * as each contract declares them. Deliberately not a rectangle: a stored
 * `w`/`h` would be a claim about a grid this artifact has never seen, and a
 * model-written one that overlaps or runs past the last column is refused by
 * `dashboardSchema` outright, which costs the whole board rather than the one
 * widget. A name the component does not declare is ignored by the packer, so
 * the worst case is the size it would have chosen anyway.
 */
export const starterSizeSchema = z.string().min(1).max(32);

export const starterSchema = z.object({
  brief: widgetBriefSchema,
  /**
   * How much of the board this deserves. 1–5, higher lands earlier and larger.
   *
   * The only thing the model says about layout, and all it needs to say: the
   * packer reads it to order placement, and ordering is what separates "the
   * headline number, then the chart, then the table" from four tiles of equal
   * billing in whatever order a list happened to be written.
   */
  importance: z.number().int().min(1).max(5).default(3),
  size: starterSizeSchema.optional(),
});

export type StarterSpec = z.infer<typeof starterSchema>;

export const categorySchema = categorySchemaOf(starterSchema);
export type CategorySpec = z.infer<typeof categorySchema>;

/* ── the personal half: one connection's setup ───────────────────────── */

/** One tab, or a tab per category. */
export const boardLayoutSchema = z.enum(["single", "per-category"]);
export type BoardLayout = z.infer<typeof boardLayoutSchema>;

/** What somebody picked. Saved, so coming back picks up where they were. */
export const onboardingChoicesSchema = z.object({
  /** Category ids, in the order they were offered. */
  categories: z.array(idSchema).min(1).max(CATEGORIES_MAX),
  layout: boardLayoutSchema.default("per-category"),
});
export type OnboardingChoices = z.infer<typeof onboardingChoicesSchema>;

/**
 * How one widget fared when it was tried against this account.
 *
 * - `ready` — it answered, and its fields were there.
 * - `partial` — it answered and works, but the read stopped before the end
 *   (a page cap, a page that repeated), so its totals may exclude records.
 *   Kept on the board, and said.
 * - `unchecked` — it could not be tried right now: the API asked us to wait,
 *   did not answer, or the check ran out of budget. Kept on the board: a rate
 *   limit is not a reason to design a widget away.
 * - `denied`, `unavailable`, `missingInput`, `schema` — it cannot work here,
 *   and is left off the board with the reason.
 */
export const widgetCheckStatusSchema = z.enum([
  "ready",
  "partial",
  "unchecked",
  "denied",
  "unavailable",
  "missingInput",
  "schema",
]);
export type WidgetCheckStatus = z.infer<typeof widgetCheckStatusSchema>;

export const widgetCheckSchema = z.object({
  category: idSchema,
  /** The widget's id on the previewed board. */
  widget: idSchema,
  title: z.string().max(200),
  status: widgetCheckStatusSchema,
  message: z.string().max(600),
});
export type WidgetCheck = z.infer<typeof widgetCheckSchema>;

/**
 * The boards as they would be created, checked against this account.
 *
 * Stored so a reload shows the same thing and so `commit` creates exactly
 * what was looked at. `fingerprint` pins it: a connection whose key, endpoints
 * or catalog reading changed since is not the one this preview checked.
 */
export const onboardingPreviewSchema = z.object({
  id: z.string().min(1).max(80),
  fingerprint: z.string().min(1),
  boards: z
    .array(
      z.object({
        /** Absent on a single combined board, which belongs to no one category. */
        category: idSchema.optional(),
        board: dashboardSchema,
      }),
    )
    .max(CATEGORIES_MAX),
  checks: z.array(widgetCheckSchema).max(400).default([]),
  /** Where the boards differ from what was designed, in a reader's words. */
  notes: z.array(z.string().max(400)).max(60).default([]),
});
export type OnboardingPreview = z.infer<typeof onboardingPreviewSchema>;

export const onboardingStatusSchema = z.enum([
  "pending",
  "choosing",
  "preview",
  "creating",
  "complete",
  "skipped",
]);
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

/**
 * Where one connection's setup stands.
 *
 * On the connection rather than the catalog because it is a fact about one
 * person's account: which parts of the API they wanted, whether they wanted
 * them together, and which boards came of it. Recorded so the question is
 * asked once and so every step can be resumed — a wizard that re-interrogates
 * somebody every time they open it is the thing this feature exists to
 * remove, not to relocate.
 *
 * `pending → choosing → preview → creating → complete`, or `skipped` from
 * anywhere before `creating`. `creating` is written *before* any board is,
 * with the ids it is about to use, so a create that dies half way finishes
 * the same boards rather than making a second set.
 */
export const onboardingSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ("status" in record) return value;
    /*
     * The first version: `{ chose, layout, boards, at, notes }`, written only
     * once boards existed. Read as a finished setup.
     */
    if (typeof record.at === "string") {
      const boards = Array.isArray(record.boards)
        ? (record.boards as { dashboard?: unknown }[])
            .map((board) => board.dashboard)
            .filter((id): id is string => typeof id === "string")
        : [];
      const chose = Array.isArray(record.chose) ? (record.chose as string[]) : [];
      return {
        status: "complete",
        ...(chose.length > 0
          ? { choices: { categories: chose, layout: record.layout ?? "per-category" } }
          : {}),
        dashboards: boards,
        at: record.at,
        notes: Array.isArray(record.notes) ? record.notes : [],
      };
    }
    /*
     * Something else stored under the same key — another experiment's record.
     * Every field has a default, so it would parse cleanly into a setup that
     * says "done" over no boards. Read as not started instead.
     */
    return { status: "pending" };
  },
  z.object({
    status: onboardingStatusSchema,
    choices: onboardingChoicesSchema.optional(),
    preview: onboardingPreviewSchema.optional(),
    /** The boards the latest set made, or is about to make while `creating`. */
    dashboards: z.array(idSchema).max(CATEGORIES_MAX).default([]),
    /** When the latest set was finished. */
    at: z.string().optional(),
    /**
     * Where a starter could not be built, in a reader's words.
     *
     * Kept because the alternative is a board that is quietly shorter than
     * the one that was designed, with nothing saying which widget is missing
     * or why.
     */
    notes: z.array(z.string().max(400)).max(60).default([]),
  }),
);

export type OnboardingSpec = z.infer<typeof onboardingSchema>;


/** A catalog entry, with its categories' starters typed as Dash briefs. */
export const catalogEntrySchema = apiCatalogEntrySchema.extend({
  categories: categoriesSchemaOf(starterSchema),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** A saved connection, with its onboarding typed as Dash's setup record. */
export const connectionSchema = apiConnectionSchema.extend({
  onboarding: onboardingSchema.optional(),
});
export type ConnectionSpec = z.infer<typeof connectionSchema>;
