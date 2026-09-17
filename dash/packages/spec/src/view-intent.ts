import { z } from "zod";
import { widgetShapeSchema, type WidgetShape } from "./shape.js";

export const viewPurposeSchema = z.enum(["browse", "inspect", "summarize", "compare", "trend"]);
export type ViewPurpose = z.infer<typeof viewPurposeSchema>;

/** Canonical intent shared by conversational and manual authoring. Fields use
 * source handles/paths, never the incidental aliases produced by a renderer.
 */
export const viewIntentSchema = z
  .object({
    version: z.literal(1).default(1),
    purpose: viewPurposeSchema,
    fields: z.array(z.string().min(1).max(300)).max(100).default([]),
    availableFilters: z.array(z.string().min(1).max(300)).max(3).default([]),
    measurement: widgetShapeSchema.optional(),
    relationships: z
      .array(
        z
          .object({
            relationship: z.string().min(1),
            direction: z.enum(["forward", "reverse"]),
            field: z.string().optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    navigation: z.enum(["record", "filtered-records", "none"]).default("record"),
    decisions: z
      .array(
        z
          .object({
            key: z.string().min(1),
            value: z.string(),
            source: z.enum(["user", "default"]),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    questions: z
      .array(
        z
          .object({
            key: z.string().min(1),
            question: z.string().min(1),
            options: z.array(z.string()).max(5),
            material: z.boolean().default(true),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();
export type ViewIntent = z.infer<typeof viewIntentSchema>;

const recordComponents = new Set([
  "table",
  "list",
  "record",
  "recordHeader",
  "cards",
  "board",
  "timeline",
  "feed",
  "calendar",
  "statusGrid",
]);
export const isRecordComponent = (component: string) => recordComponents.has(component);

/** Explicit edits replace defaults through the same contract in chat and controls. */
export const intentAfterViewEdit = (
  intent: ViewIntent,
  component: string,
  measurement?: WidgetShape,
): ViewIntent => {
  const aggregated = Boolean(measurement?.measures.length || measurement?.groupBy.length);
  return {
    ...intent,
    purpose:
      component === "timeseries"
        ? "trend"
        : aggregated || !isRecordComponent(component)
          ? "summarize"
          : "browse",
    availableFilters: aggregated || !isRecordComponent(component) ? [] : intent.availableFilters,
    measurement,
    navigation: aggregated ? "filtered-records" : "record",
  };
};

/** No text heuristics: the declared purpose is checked against the actual plan. */
export const viewIntentProblems = (
  intent: ViewIntent,
  component: string,
  shape?: WidgetShape,
): string[] => {
  const errors: string[] = [];
  const aggregated = Boolean(shape?.measures.length || shape?.groupBy.length);
  if (intent.purpose === "browse" || intent.purpose === "inspect") {
    if (!isRecordComponent(component) || aggregated)
      errors.push(
        "This request is for individual records. Use a record view and keep filtering separate from grouping or counting.",
      );
  }
  if (aggregated && intent.navigation === "record")
    errors.push(
      "An aggregate represents several records. Its navigation must open filtered records, not a single record identity.",
    );
  return errors;
};
