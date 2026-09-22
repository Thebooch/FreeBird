import { z } from "zod";
import { dashboardSchema, layoutSchema, widgetSchema } from "./dashboard.js";
import { widgetBriefSchema } from "./brief-schema.js";
import { idSchema } from "./primitives.js";
import { entitySchema } from "./entity.js";

export const ONBOARDING_VERSION = 1;
/** Replaced structurally when a template is instantiated for an account. */
export const ONBOARDING_CONNECTION = "onboarding-source";

export const onboardingCategorySchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  opIds: z.array(idSchema).min(1).max(500),
  resourceIds: z.array(idSchema).default([]),
  status: z.enum(["pending", "ready", "failed"]).default("pending"),
  error: z.string().max(2000).optional(),
  recipes: z.array(widgetBriefSchema).max(12).default([]),
  widgets: z.array(widgetSchema).max(12).default([]),
  layout: layoutSchema.default({ gridCols: 12, cells: [] }),
});
export const integrationOnboardingSchema = z.object({
  version: z.literal(ONBOARDING_VERSION),
  fingerprint: z.string().min(1),
  revision: idSchema,
  purpose: z.string().min(1).max(800),
  categoryQuestion: z.string().min(1).max(300),
  organizationQuestion: z.string().min(1).max(300),
  categories: z.array(onboardingCategorySchema).min(1).max(30),
});
export const onboardingChoicesSchema = z.object({
  categoryIds: z.array(idSchema).min(1).max(30),
  organization: z.enum(["combined", "separate"]),
});
export const onboardingVerificationSchema = z.object({
  categoryId: idSchema,
  widgetId: idSchema,
  title: z.string(),
  status: z.enum([
    "ready",
    "denied",
    "credentials",
    "missingInput",
    "unavailable",
    "schema",
    "transient",
  ]),
  message: z.string().max(2000),
});
export const onboardingPreviewSchema = z.object({
  id: idSchema,
  fingerprint: z.string(),
  dashboards: z.array(dashboardSchema),
  verification: z.array(onboardingVerificationSchema),
});
export const connectionOnboardingSchema = z.object({
  status: z.enum(["pending", "choosing", "preview", "creating", "complete", "skipped"]),
  templateRevision: idSchema.optional(),
  choices: onboardingChoicesSchema.optional(),
  preview: onboardingPreviewSchema.optional(),
  dashboardIds: z.array(idSchema).default([]),
  /** Local-only integration for a manually defined connection. */
  template: integrationOnboardingSchema.optional(),
  localEntities: z.array(entitySchema).optional(),
});
export type OnboardingCategory = z.infer<typeof onboardingCategorySchema>;
export type IntegrationOnboarding = z.infer<typeof integrationOnboardingSchema>;
export type OnboardingChoices = z.infer<typeof onboardingChoicesSchema>;
export type OnboardingVerification = z.infer<typeof onboardingVerificationSchema>;
export type OnboardingPreview = z.infer<typeof onboardingPreviewSchema>;
export type ConnectionOnboarding = z.infer<typeof connectionOnboardingSchema>;
export interface OnboardingStatus {
  template: IntegrationOnboarding | null;
  state: ConnectionOnboarding | null;
  stale: boolean;
  canPrepare: boolean;
  reason?: string;
}
