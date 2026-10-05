import { z } from "zod";
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
 * `onboardingSchema` in Dash's `category.ts`, and `NarrowingStore` for the
 * same line drawn between the shareable and the personal.
 *
 * **A starter is a brief, not a widget.** The difference is load-bearing. A
 * compiled widget names endpoint ids, and a connection may hold only a subset
 * of an API's endpoints — so a shared artifact full of widget specs would
 * break on the second person to connect. A brief names a record type and what
 * the widget is *for*; `compileBrief` turns it into a validated widget against
 * whatever endpoints the connection in front of it actually carries.
 *
 * Starters belong to whoever builds widgets from them, so this package stores
 * them without reading them: `categorySchemaOf` takes the host's starter
 * schema, and the plain `categorySchema` keeps them as they came.
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

export const categorySchemaOf = <S extends z.ZodTypeAny>(starter: S) =>
  z.preprocess(
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
      starters: z.array(starter).max(STARTERS_PER_CATEGORY_MAX).default([]),
      status: categoryStatusSchema.default("pending"),
      /** Why it is `empty` or `failed`, in a reader's words. */
      error: z.string().max(600).optional(),
    }),
  );

/** A category as the engine sees it, with its starters left as they came. */
export const categorySchema = categorySchemaOf(z.unknown());

export type CategorySpec = z.infer<typeof categorySchema>;

/** How many categories one API divides into before the choice stops being one. */
export const CATEGORIES_MAX = 20;

/** The categories on a catalog entry, with the host's starter schema. */
export const categoriesSchemaOf = <S extends z.ZodTypeAny>(starter: S) =>
  z.array(categorySchemaOf(starter)).max(CATEGORIES_MAX).default([]);
