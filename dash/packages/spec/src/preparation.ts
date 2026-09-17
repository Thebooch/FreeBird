import { z } from "zod";

export const preparationEstimateSchema = z
  .object({
    maxModelUsd: z.number().finite().nonnegative(),
    maxApiRequests: z.number().int().nonnegative(),
    expectedSeconds: z.number().int().nonnegative(),
    contractFingerprint: z.string().min(1),
  })
  .strict();

export const preparationJobSchema = z
  .object({
    id: z.string().uuid(),
    integration: z.string().min(1),
    revision: z.number().int().positive(),
    state: z.enum(["awaiting-approval", "queued", "running", "paused", "complete", "failed"]),
    createdAt: z.number().int().nonnegative().default(0),
    estimate: preparationEstimateSchema,
    approvedAt: z.number().int().nonnegative().optional(),
    reservedModelUsd: z.number().nonnegative().default(0),
    reservedApiRequests: z.number().int().nonnegative().default(0),
    completed: z.array(z.string()).default([]),
    target: z
      .object({
        connection: z.string().min(1),
        version: z.string().min(1),
        bindingRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    resultVersion: z.string().optional(),
    notBefore: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PreparationJob = z.infer<typeof preparationJobSchema>;

export interface PreparationStatus {
  available: boolean;
  jobs: PreparationJob[];
}
export interface IntegrationActivationReview {
  connection: string;
  currentVersion: string;
  targetVersion: string;
  bindingRevision: number;
  fingerprint: string;
  alreadyActive: boolean;
  compatible: boolean;
  blockers: string[];
  relationships: {
    title: string;
    direction: "forward" | "reverse";
    before: "unverified" | "verified" | "contradicted";
    after: "unverified" | "verified" | "contradicted";
  }[];
}
