import { z } from "zod";

export const orientationSchema = z.enum(["wide", "tall", "square", "auto"]);

export const sizeVariantSchema = z.object({
  name: z.string().min(1),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  aspect: orientationSchema.optional(),
});

export const gridHintsSchema = z
  .object({
    // Explicit multi-size API
    sizes: z.array(sizeVariantSchema).min(1).optional(),
    preferredSize: z.string().min(1).optional(),
    minSize: z.string().min(1).optional(),

    // Simple single-range API
    minW: z.number().int().min(1).max(12).optional(),
    minH: z.number().int().min(1).max(24).optional(),
    maxW: z.number().int().min(1).max(12).optional(),
    maxH: z.number().int().min(1).max(24).optional(),
    defaultAspect: orientationSchema.optional(),
  })
  // At least one of the two APIs must be used
  .refine((v) => v.sizes !== undefined || (v.minW !== undefined && v.minH !== undefined), {
    message: "provide either sizes[] or both minW and minH",
  })
  // Range consistency
  .refine((v) => v.maxW === undefined || v.minW === undefined || v.maxW >= v.minW, {
    message: "maxW must be >= minW",
    path: ["maxW"],
  })
  .refine((v) => v.maxH === undefined || v.minH === undefined || v.maxH >= v.minH, {
    message: "maxH must be >= minH",
    path: ["maxH"],
  })
  // preferredSize must name a variant that exists in sizes
  .refine(
    (v) =>
      v.preferredSize === undefined ||
      v.sizes === undefined ||
      v.sizes.some((s) => s.name === v.preferredSize),
    { message: "preferredSize must be the name of a variant in sizes[]", path: ["preferredSize"] },
  )
  // minSize must name a variant that exists in sizes
  .refine(
    (v) =>
      v.minSize === undefined ||
      v.sizes === undefined ||
      v.sizes.some((s) => s.name === v.minSize),
    { message: "minSize must be the name of a variant in sizes[]", path: ["minSize"] },
  );

export const knowledgeSourceSchema = z.object({
  page: z.string().min(1),
  selector: z.string().min(1).optional(),
  heading: z.string().min(1).optional(),
});

export const knowledgeItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "knowledge ids must be [a-zA-Z0-9_-]")
    .optional(),
  title: z.string().min(1).optional(),
  text: z.string().min(1),
  category: z.string().min(1).optional(),
  source: knowledgeSourceSchema.optional(),
});

export const confirmationPolicySchema = z.enum(["none", "preview", "strict"]);

export const previewStrategySchema = z.union([
  z.literal("text"),
  z.literal("component"),
  z.object({ component: z.string().min(1) }),
]);

/**
 * Metadata-only schema for actions — intentionally omits `schema`,
 * `handler`, and `readCurrent` since those are runtime-only values.
 */
export const actionMetadataSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "action ids must be [a-zA-Z0-9_-]"),
  description: z.string().min(1),
  requiresConfirmation: confirmationPolicySchema.optional(),
  previewStrategy: previewStrategySchema.optional(),
});

/**
 * Metadata-only schema — intentionally omits `render` and `dataSource`
 * since those are runtime-only functions.
 */
export const componentMetadataSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]"),
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  knowledge: z.array(knowledgeItemSchema).optional(),
  grid: gridHintsSchema,
  actions: z
    .array(actionMetadataSchema)
    .optional()
    .refine(
      (arr) => {
        if (!arr) return true;
        const ids = arr.map((a) => a.id);
        return new Set(ids).size === ids.length;
      },
      { message: "action ids must be unique within a component" },
    ),
});

export type ComponentMetadata = z.infer<typeof componentMetadataSchema>;
export type ActionMetadata = z.infer<typeof actionMetadataSchema>;
