import { z } from "zod";

/** A saved query, not unrestricted HTTP POST access. Validated against SDL before execution. */
export const graphqlReadSchema = z.object({
  document: z.string().min(1).max(100000),
  operationName: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
  maxDepth: z.number().int().min(1).max(20).default(8),
  maxFields: z.number().int().min(1).max(2000).default(500),
}).strict();
export type GraphqlRead = z.infer<typeof graphqlReadSchema>;
