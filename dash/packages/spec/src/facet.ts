import { z } from "zod";
import type { BindingIssue, ColumnMeta } from "./contracts.js";
import { fieldNameSchema } from "./pipeline.js";
import { statusTone } from "./semantics.js";
import type { StatusTone } from "./semantics.js";

/**
 * A category a reader can filter one widget down to, with a count.
 *
 * The declaration only — which field carries the distinction and, optionally,
 * which of its values are worth a tile. Everything numeric happens over the
 * rows the pipeline already produced, in `@freebirdai/dash-components`; nothing
 * in this file touches data.
 *
 * Deliberately not a dashboard filter. Those are declared up front, apply to
 * every widget, reach the API through `{{param.x}}` and sit in the query cache
 * key, so changing one re-fetches. A facet is the opposite on every count: it
 * is derived from the rows in hand, belongs to one widget, never reaches the
 * API and is never part of a cache key. The two look similar on screen and
 * behave nothing alike, which is why this is separate vocabulary rather than a
 * flag on `FilterDecl`.
 *
 * The reason a facet cannot re-fetch is the counts. A tile says how many rows
 * are in a category, and the only rows whose categories are knowable are the
 * ones already fetched. An upstream filter would make every unselected tile a
 * count of data nobody fetched — unknowable, so not shown. Filtering upstream
 * is a real feature, and a narrowing already records `filterParam` for it, but
 * it cannot wear this shape.
 */

/** More than this and it is not a category, it is an identifier. */
export const FACET_MAX_VALUES = 24;

/** Three strips is already a lot of chrome above one widget. */
export const FACET_MAX_PER_WIDGET = 3;

/**
 * What a value is called when there is not one.
 *
 * The same character `bucketBy` has always used for an absent group, so a
 * board column and a facet tile over the same field agree about what an empty
 * value looks like.
 */
export const FACET_EMPTY_KEY = "—";

/**
 * The bucket a value falls in.
 *
 * One definition, exported, because the rule is applied to both sides of a
 * comparison — once to a row's value and once to a declared or selected one —
 * and two implementations that disagreed would produce a tile that filters to
 * nothing while showing a count above zero.
 *
 * Stringifying is what makes that safe rather than sloppy. `@freebirdai/dash-expr`
 * compares strictly on purpose, and a facet that matched `"1688"` against
 * `1688` by coercion would be the silent wrongness that rejects. Here neither
 * side is a value being compared against another value: both are put through
 * this one function first, so what is compared is two bucket names.
 */
export const facetKey = (value: unknown): string =>
  value === null || value === undefined || value === "" ? FACET_EMPTY_KEY : String(value);

/** Names that must never key a plain object used as a map. */
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

export const facetValueSchema = z.union([z.string().max(200), z.number(), z.boolean()]);
export type FacetValue = z.infer<typeof facetValueSchema>;

/** The same five the highlights use, so there is one vocabulary of state colours. */
export const facetToneSchema = z.enum(["good", "warning", "serious", "critical", "neutral"]);

export const facetOptionSchema = z.object({
  value: facetValueSchema,
  /** What the tile says. Defaults to the value itself. */
  label: z.string().min(1).max(60).optional(),
  /** Overrides the tone `statusTone` would infer from the value. */
  tone: facetToneSchema.optional(),
});

export type FacetOption = z.infer<typeof facetOptionSchema>;

export const facetSchema = z
  .object({
    /** A column the pipeline produces. */
    field: fieldNameSchema,
    /** The strip's heading. Defaults to the column's own label. */
    label: z.string().min(1).max(60).optional(),
    /**
     * Whether two categories can be shown at once.
     *
     * Multi by default, and that is what makes the counts coherent: every
     * tile's number is computed with its own facet's selection ignored, so
     * "Open 12" still reads 12 after Overdue is also picked. Single-select is
     * the narrower behaviour and has to be asked for.
     */
    mode: z.enum(["single", "multi"]).default("multi"),
    /**
     * The tiles to draw, in this order. Omit to take them from the data.
     *
     * Declaring them buys two things worth having: an order that does not
     * depend on which rows happened to arrive, and a tile that stays visible
     * at zero — "Overdue 0" is a useful thing to be able to see, and a derived
     * strip cannot show it, because nothing in the rows says the category
     * exists.
     */
    values: z.array(facetOptionSchema).min(1).max(FACET_MAX_VALUES).optional(),
    /**
     * What to do with rows matching none of the declared values.
     *
     * Shown by default, so the tiles account for every row. A strip whose
     * numbers do not add up to the row count under it invites the reader to
     * work out which records are missing, and that is never time well spent.
     */
    other: z.enum(["show", "hide"]).default("show"),
    /** Selected when the widget first draws. Empty means everything. */
    default: z.array(facetValueSchema).max(FACET_MAX_VALUES).default([]),
  })
  .superRefine((facet, ctx) => {
    /*
     * A selection is held in a plain object keyed by field name, and
     * `fieldNameSchema` happily accepts `__proto__` — underscore, letters. The
     * same rule the presentation schema applies: refuse the name once, here,
     * rather than defending every read of the selection downstream.
     */
    if (RESERVED_FIELDS.has(facet.field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${facet.field}" is a reserved name and cannot be faceted`,
        path: ["field"],
      });
    }

    if (facet.mode === "single" && facet.default.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a single-select facet takes at most one default, got ${facet.default.length}`,
        path: ["default"],
      });
    }

    /*
     * Duplicates are checked on the bucket key rather than the raw value,
     * because that is what the strip keys its tiles by: 1688 and "1688" are
     * two entries here and one tile on screen.
     */
    const seen = new Set<string>();
    facet.values?.forEach((option, index) => {
      const key = facetKey(option.value);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${key}" is listed twice`,
          path: ["values", index, "value"],
        });
      }
      seen.add(key);
    });

    /*
     * A default naming something no tile can show would open the widget
     * filtered to nothing, with no lit tile saying why. Only checkable when
     * the values are declared — a derived strip does not know its own tiles
     * until it has rows, so the model drops an unrepresentable selection at
     * read time instead.
     */
    if (facet.values) {
      facet.default.forEach((value, index) => {
        if (!seen.has(facetKey(value))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${facetKey(value)}" is selected by default but is not one of this facet's values`,
            path: ["default", index],
          });
        }
      });
    }
  });

export type FacetSpec = z.infer<typeof facetSchema>;

export const facetsSchema = z
  .array(facetSchema)
  .max(FACET_MAX_PER_WIDGET)
  .default([])
  .superRefine((facets, ctx) => {
    const seen = new Set<string>();
    facets.forEach((facet, index) => {
      if (seen.has(facet.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${facet.field}" already has a facet — two strips over one field would each filter the other`,
          path: [index, "field"],
        });
      }
      seen.add(facet.field);
    });
  });

/** The tone a tile wears: what the author said, or what the value suggests. */
export const facetTone = (option: FacetOption | undefined, value: unknown): StatusTone =>
  option?.tone ?? statusTone(value);

/**
 * What is wrong with a widget's facets, given the columns it produces.
 *
 * Every issue is a warning and never an error, which is the load-bearing
 * decision in this file. A facet is chrome above a widget that renders
 * perfectly well without it, so a strip that cannot be drawn must cost the
 * strip and nothing else. Adding a facet can therefore never break a working
 * widget — the worst it can do is fail to appear.
 */
export const validateFacets = (
  facets: readonly FacetSpec[],
  columns: readonly ColumnMeta[],
): readonly BindingIssue[] => {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const issues: BindingIssue[] = [];

  for (const facet of facets) {
    const role = `facet:${facet.field}`;
    const column = byName.get(facet.field);

    if (!column) {
      issues.push({
        role,
        message: `"${facet.field}" is faceted but the pipeline does not produce it, so no filter is shown`,
      });
      continue;
    }

    /*
     * Numbers and dates are ranges, not categories. Tiling every distinct
     * amount gives one tile per row, and the question the reader actually has
     * ("over £500", "this week") is a control this does not implement — so it
     * says so rather than drawing a hundred useless tiles.
     */
    if (column.valueType === "numeric" || column.valueType === "temporal") {
      issues.push({
        role,
        message: `"${facet.field}" is ${column.valueType}, which tiles badly — a facet wants a category`,
      });
      continue;
    }

    // Only the derived strip is capped. Declared values are the author saying
    // which handful matter, and that answer holds however many exist.
    if (
      !facet.values &&
      column.distinctCount !== undefined &&
      column.distinctCount > FACET_MAX_VALUES
    ) {
      issues.push({
        role,
        message: `"${facet.field}" has ${column.distinctCount} distinct values; a filter strip reads well up to ${FACET_MAX_VALUES}, so none is shown`,
      });
    }
  }

  return issues;
};
