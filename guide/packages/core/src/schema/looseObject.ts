import { z } from "zod";

/**
 * OpenAI-friendly freeform JSON object. Prefer over `z.record(...)` for tool
 * schemas — `zod-to-json-schema` warns that OpenAI may reject record types.
 */
export const looseObjectSchema = (): z.ZodTypeAny =>
  z.object({}).passthrough();
