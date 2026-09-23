import { z } from "zod";
import { widgetBriefSchema } from "./brief-schema.js";
import { dashboardSchema } from "./dashboard.js";
import { idSchema } from "./primitives.js";

/**
 * What an API is for, how its records divide up, and where somebody should
 * start with each division.
 *
 * The answer to the question a new connection cannot answer for itself. An API
 * that has been mapped and described knows what each of its record types *is*
 * and says nothing about which of them belong together — so the first thing
 * anybody saw after connecting was an empty board and an invitation to think
 * of a widget. Leasing, maintenance and accounting are one API's own divisions
 * and no rule in this codebase could name them, because they are facts about
 * the domain rather than about the schema.
 *
 * Every field here describes the **API**, never an account, which is what puts
 * it in the catalog entry beside the map and the record types: one person pays
 * for the reading and everybody who connects afterwards inherits it. What the
 * *user* chose out of it lives on their connection instead — see
 * `onboardingSchema` in `connection.ts`, and `NarrowingStore` for the same
 * line drawn between the shareable and the personal.
 *
 * **A starter is a brief, not a widget.** The difference is load-bearing. A
 * compiled widget names endpoint ids, and a connection may hold only a subset
 * of an API's endpoints — so a shared artifact full of widget specs would
 * break on the second person to connect. A brief names a record type and what
 * the widget is *for*; `compileBrief` turns it into a validated widget against
 * whatever endpoints the connection in front of it actually carries.
 */

/** Bumped when the shape or the pass changes enough to make stored work stale. */
export const CATEGORY_VERSION = 1;

/**
 * What this API is, in a sentence, for somebody who has only seen its URL.
 *
 * Written once per API and shown while the categories are being chosen, so the
 * questions arrive with the context that makes them answerable — "these are
 * the parts of a property management system" rather than "these are eight
 * groups of endpoints".
 */
export const profileSchema = z.object({
  summary: z.string().min(1).max(400),
  /** Two or three words for the field this software serves. */
  domain: z.string().min(1).max(60).optional(),
});

export type ApiProfile = z.infer<typeof profileSchema>;

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

/** How many widgets one category is worth opening with. */
export const STARTERS_PER_CATEGORY_MAX = 8;

/**
 * Where a category's starter set stands.
 *
 * - `pending` — divided, not yet composed.
 * - `ready` — composed, with widgets.
 * - `empty` — composed, and nothing in it could be built from this API. Not
 *   paid for again until the API itself changes: asking the same question of
 *   the same record types gets the same refusals.
 * - `failed` — the call itself failed. Retried on the next run.
 *
 * Stored per category so a run resumes by reading the categories themselves
 * rather than a separate list of what was done, which could disagree with
 * them.
 */
export const categoryStatusSchema = z.enum(["pending", "ready", "empty", "failed"]);
export type CategoryStatus = z.infer<typeof categoryStatusSchema>;

export const categorySchema = z.preprocess(
  /*
   * Written before `status` existed: a category with a set is ready, and one
   * without has not been composed. Read that way rather than all as pending,
   * so an API somebody already paid for is not composed a second time.
   */
  (value) => {
    if (!value || typeof value !== "object" || "status" in value) return value;
    const starters = (value as { starters?: unknown }).starters;
    return {
      ...(value as Record<string, unknown>),
      status: Array.isArray(starters) && starters.length > 0 ? "ready" : "pending",
    };
  },
  z.object({
    id: idSchema,
    title: z.string().min(1).max(80),
    /**
     * What this part of the API covers, in the domain's own words.
     *
     * Read by somebody deciding whether they want it, so it says what is *in*
     * the category rather than restating its name — the same bar an entity's
     * own description is held to, and for the same reason.
     */
    description: z.string().max(400).optional(),
    /** The record types that belong here. Every one validated against the API. */
    entities: z.array(idSchema).min(1).max(60),
    /** The widget set this category opens with. Empty until the second pass runs. */
    starters: z.array(starterSchema).max(STARTERS_PER_CATEGORY_MAX).default([]),
    status: categoryStatusSchema.default("pending"),
    /** Why it is `empty` or `failed`, in a reader's words. */
    error: z.string().max(600).optional(),
  }),
);

export type CategorySpec = z.infer<typeof categorySchema>;

/** How many categories one API divides into before the choice stops being one. */
export const CATEGORIES_MAX = 20;

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
 * - `unchecked` — it could not be tried right now: the API asked us to wait,
 *   did not answer, or the check ran out of budget. Kept on the board: a rate
 *   limit is not a reason to design a widget away.
 * - `denied`, `unavailable`, `missingInput`, `schema` — it cannot work here,
 *   and is left off the board with the reason.
 */
export const widgetCheckStatusSchema = z.enum([
  "ready",
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
