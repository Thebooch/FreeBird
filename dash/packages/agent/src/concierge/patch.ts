import { z } from "zod";
import { coercionSchema, formatSchema, widgetShapeSchema } from "@freebirdai/dash-spec";
import { choiceDraftSchema } from "./draft.js";

const partPatchSchema = z
  .object({
    inputs: z.record(z.string().max(500)).optional(),
    coercions: z.record(coercionSchema).optional(),
    format: z.record(formatSchema).optional(),
    choiceBetween: choiceDraftSchema.optional(),
    narrowWith: z
      .object({
        field: z.string().max(200),
        values: z.array(z.union([z.string(), z.number()])).max(100),
        phrase: z.string().max(500).optional(),
        filterParam: z.string().max(120).optional(),
      })
      .optional(),
    compareWith: z
      .object({
        endpoint: z.string().max(120),
        leftTimeField: z.string().max(200),
        rightTimeField: z.string().max(200),
        leftLabel: z.string().max(120),
        rightLabel: z.string().max(120),
      })
      .optional(),
    connection: z.string().max(120).optional(),
    endpoint: z.string().max(120).optional(),
    join: z.string().max(200).optional(),
    component: z.string().max(64).optional(),
    /*
     * What the widget counts, and what it is broken up by.
     *
     * Declared here or silently dropped: zod strips unknown keys, so a patch
     * carrying a field this schema has not heard of arrives as a no-op that
     * reports success. That exact trap swallowed `joinWith` once already.
     */
    measure: z.string().max(200).optional(),
    groupBy: z.string().max(200).optional(),
    /** Whether to take a measurement that costs requests: include or skip. */
    offer: z.enum(["include", "skip"]).optional(),
    /** Which of two readings of the request was meant, as an endpoint id. */
    choice: z.string().max(200).optional(),
    roles: z.record(z.string().max(64), z.array(z.string().max(200)).max(40)).optional(),
    controls: z.array(z.string().max(64)).max(20).optional(),
    drilldown: z.string().max(120).optional(),
    drilldownFields: z.array(z.string().max(200)).max(40).optional(),
    extras: z.array(z.string().max(200)).max(40).optional(),
    highlights: z.array(z.string().max(120)).max(8).optional(),
    title: z.string().max(120).optional(),
    /*
     * The other widgets this setup builds, and how they are shown together.
     *
     * Declared for the reason stated above, which is not hypothetical: zod
     * strips what it has not heard of, so a two-widget proposal arriving here
     * without these would apply its first widget, drop the second without a
     * word, and report success.
     */
    group: z
      .object({
        title: z.string().min(1).max(120),
        display: z.enum(["tabs", "row", "stack"]).optional(),
      })
      .optional(),
    /** Stack the parts into one badged list rather than building each on its own. */
    interleave: z.boolean().optional(),
    /** Which model proposed this, recorded on the widget it builds. */
    model: z.string().max(120).optional(),
    /**
     * The whole measurement at once, and the sides drawn beside it.
     *
     * All three declared here or silently dropped — the same trap that swallowed
     * `joinWith` and made it look like a no-op that reported success. A schema
     * that has not heard of a field discards it and says nothing.
     */
    shape: widgetShapeSchema.optional(),
    seriesWith: z
      .array(
        z.object({
          coercions: z.record(coercionSchema).optional(),
          format: z.record(formatSchema).optional(),
          inputs: z.record(z.string()).optional(),
          endpoint: z.string().max(120),
          label: z.string().max(80),
          shape: widgetShapeSchema,
          fanOut: z
            .object({
              from: z.string().max(120),
              field: z.string().max(200),
              as: z.string().max(120).optional(),
              maxRows: z.number().int().min(1).max(100).optional(),
            })
            .optional(),
        }),
      )
      .max(3)
      .optional(),
    offerSeries: z
      .object({
        coercions: z.record(coercionSchema).optional(),
        format: z.record(formatSchema).optional(),
        inputs: z.record(z.string()).optional(),
        endpoint: z.string().max(120),
        label: z.string().max(80),
        shape: widgetShapeSchema,
        fanOut: z.object({
          from: z.string().max(120),
          field: z.string().max(200),
          as: z.string().max(120).optional(),
          maxRows: z.number().int().min(1).max(100).optional(),
        }),
      })
      .optional(),
    /** A join the caller worked out, rather than one the report found. */
    joinWith: z
      .object({
        endpoint: z.string().max(120),
        leftField: z.string().max(200),
        rightField: z.string().max(200),
        kind: z.enum(["inner", "left"]).optional(),
      })
      .optional(),
    skip: z.array(z.string().max(64)).max(20).optional(),
  })
  .strict();

export const draftPatchSchema = partPatchSchema
  .extend({
    parts: z
      .array(partPatchSchema.omit({ group: true, interleave: true }))
      .max(3)
      .optional(),
  })
  .strict();
