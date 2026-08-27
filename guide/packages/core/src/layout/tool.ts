import { z } from "zod";
import { looseObjectSchema } from "../schema/looseObject.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { LlmTool } from "../adapters/llm.js";
import type { LayoutIntent } from "../types.js";
import { orientationSchema } from "../components/schema.js";

/**
 * Build the `plan_layout` tool schema the LLM uses to pick components.
 *
 * The schema restricts `componentId` to the ids currently registered so the
 * LLM physically can't hallucinate an unknown component — the provider's
 * tool-call validation will reject it before we even run the solver.
 */
export const buildPlanLayoutTool = (
  registry: ComponentRegistry<any, any>,
): LlmTool<LayoutIntent> => {
  const ids = registry.list().map((c) => c.id);
  const componentIdSchema =
    ids.length > 0
      ? z.enum(ids as [string, ...string[]])
      : z.string().min(1); // fallback if registry is empty (e.g. in early tests)

  const schema: z.ZodType<LayoutIntent> = z.object({
    items: z
      .array(
        z.object({
          componentId: componentIdSchema,
          props: looseObjectSchema().optional(),
          importance: z.number().int().min(1).max(5).optional(),
          orientationHint: orientationSchema.optional(),
        }),
      )
      .min(0)
      .max(24),
  });

  const summary = registry
    .describeForLLM()
    .map((c) => {
      const sizeSummary =
        c.sizes && c.sizes.length > 0
          ? ` [sizes: ${c.sizes.map((s) => `${s.name}(${s.w}×${s.h})`).join(", ")}${c.preferredSize ? `; preferred: ${c.preferredSize}` : ""}]`
          : "";
      return `- ${c.id}: ${c.title} — ${c.description} (tags: ${c.tags.join(", ") || "none"})${sizeSummary}`;
    })
    .join("\n");

  return {
    name: "plan_layout",
    description:
      "Choose which registered components to show the user next, and how important each one is. " +
      "The layout engine automatically picks the best size for each component based on how many " +
      "you request — a solo component expands to fill space, while crowded layouts use compact " +
      "variants. Focus on which components are relevant; the engine handles sizing. " +
      "Only use componentIds from this list.\n" +
      summary,
    schema,
  };
};
