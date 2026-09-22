import { z } from "zod";
import { widgetBriefSchema } from "./brief-schema.js";
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

export const categorySchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(80),
  /**
   * What this part of the API covers, in the domain's own words.
   *
   * Read by somebody deciding whether they want it, so it says what is *in*
   * the category rather than restating its name — the same bar an entity's own
   * description is held to, and for the same reason.
   */
  description: z.string().max(400).optional(),
  /** The record types that belong here. Every one validated against the API. */
  entities: z.array(idSchema).min(1).max(60),
  /** The widget set this category opens with. Empty until the second pass runs. */
  starters: z.array(starterSchema).max(STARTERS_PER_CATEGORY_MAX).default([]),
});

export type CategorySpec = z.infer<typeof categorySchema>;

/** How many categories one API divides into before the choice stops being one. */
export const CATEGORIES_MAX = 20;

/**
 * The boards a connection was set up with, and what was chosen to get them.
 *
 * On the connection rather than the catalog because it is a fact about one
 * person's account: which parts of the API they wanted and whether they wanted
 * them together. Recorded so the question is asked once — a wizard that
 * re-interrogates somebody every time they open it is the thing this feature
 * exists to remove, not to relocate.
 */
export const onboardingSchema = z.object({
  /** The category ids that were picked, in the order they were offered. */
  chose: z.array(idSchema).max(CATEGORIES_MAX).default([]),
  /** One board holding everything, or a board — a tab — per category. */
  layout: z.enum(["single", "per-category"]).default("per-category"),
  boards: z
    .array(
      z.object({
        /** Absent on a single combined board, which belongs to no one category. */
        category: idSchema.optional(),
        dashboard: idSchema,
      }),
    )
    .max(CATEGORIES_MAX)
    .default([]),
  at: z.string().optional(),
  /**
   * Where a starter could not be built, in a reader's words.
   *
   * Kept because the alternative is a board that is quietly shorter than the
   * one that was designed, with nothing saying which widget is missing or why.
   * The compiler's own sentences, which are the only ones that know.
   */
  notes: z.array(z.string().max(300)).max(40).default([]),
});

export type OnboardingSpec = z.infer<typeof onboardingSchema>;
