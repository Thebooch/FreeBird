import { z } from "zod";
import { gridHintsSchema, ticketTypeSchema } from "@freebirdai/core";

/**
 * The Registration Manifest is FreeBird's declarative description of a site's
 * components. It is the interchange format between everything that *discovers*
 * components and everything that *serves* them:
 *
 * Producers                          Consumers
 * ─────────────────────────────      ─────────────────────────────────────────
 * `@freebirdai/embed` DOM scanner  →   `compileServerRegistry()` (managed backend)
 * WP plugin content push         →   `@freebirdai/codegen` (real registry files)
 * Studio analysis pipeline       →
 *
 * Unlike a `ComponentDefinition`, a manifest entry is pure data — no render
 * functions, no handlers. Server behavior for manifest-declared actions is
 * limited to a fixed allowlist (local DOM directives, ticket filing, named
 * webhooks) so that a manifest scanned from an untrusted page can never
 * introduce arbitrary code execution.
 */

export const manifestComponentKindSchema = z.enum([
  "framework-component",
  "dom-region",
  "wp-content",
]);

export const manifestSourceSchema = z.object({
  /** Repo-relative path to the defining file (framework-component). */
  file: z.string().min(1).optional(),
  /** Named export within `file`, when not the default export. */
  exportName: z.string().min(1).optional(),
  /** CSS selector locating the region on the live page (dom-region). */
  selector: z.string().min(1).optional(),
  /** WordPress content type, e.g. "page" | "post" | "product" (wp-content). */
  wpType: z.string().min(1).optional(),
  /** WordPress content id within `wpType`. */
  wpId: z.union([z.string().min(1), z.number().int()]).optional(),
  /**
   * Path this component's selector lives on (dom-region), e.g. "/contact".
   * Absent means "wherever it was scanned from" / the current page — the
   * embed only navigates when this is set and differs from where the
   * visitor already is.
   */
  page: z.string().min(1).optional(),
});

export const manifestFieldSchema = z.object({
  /** Stable field name referenced by fill-form args and descriptions. */
  name: z.string().min(1),
  /** CSS selector relative to the component's root (dom-region only). */
  selector: z.string().min(1).optional(),
  /** What this field holds — fed to the LLM. */
  description: z.string().min(1).optional(),
});

/**
 * Directives the embed executes in the visitor's browser. These are the only
 * "manipulate the page" primitives a manifest can grant — each is visible to
 * the visitor and confined to the component's registered region.
 */
export const localDomDirectiveSchema = z.enum([
  "highlight",
  "scroll-to",
  "show-in-chat",
  "fill-form",
  "click",
]);

/**
 * Flat typed argument declaration, compiled to a zod object schema at
 * registration time. Deliberately not full JSON Schema: the allowlisted
 * action kinds only need primitive fields, and keeping it flat means no
 * schema-conversion dependency in browsers or the managed backend.
 */
export const manifestActionArgSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "arg names must be [a-zA-Z0-9_-]"),
  type: z.enum(["string", "number", "boolean"]),
  /** Fed to the LLM as the zod `.describe()` — the key extraction input. */
  description: z.string().min(1),
  required: z.boolean().optional(),
});

/** Allowlisted server-side behaviors for manifest-declared actions. */
export const manifestServerBehaviorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file-ticket"),
    /** Ticket type to file. Defaults to "feature". */
    ticketType: ticketTypeSchema.optional(),
    /** Extra tags stamped onto the filed ticket. */
    tags: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal("webhook"),
    /**
     * Symbolic webhook name resolved by the host via
     * `CompileManifestHooks.resolveWebhook`. URLs never live in the manifest,
     * so a scanned page cannot point actions at attacker-chosen endpoints.
     */
    webhook: z.string().min(1),
  }),
]);

export const manifestActionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "action ids must be [a-zA-Z0-9_-]"),
    /** One-sentence description fed to the LLM. */
    description: z.string().min(1),
    kind: z.enum(["local-dom", "server"]),
    /** Required when kind is "local-dom". */
    directive: localDomDirectiveSchema.optional(),
    /** Required when kind is "server". */
    server: manifestServerBehaviorSchema.optional(),
    args: z.array(manifestActionArgSchema).optional(),
    requiresConfirmation: z.enum(["none", "preview", "strict"]).optional(),
  })
  .refine((a) => a.kind !== "local-dom" || a.directive !== undefined, {
    message: 'local-dom actions must set "directive"',
    path: ["directive"],
  })
  .refine((a) => a.kind !== "local-dom" || a.server === undefined, {
    message: 'local-dom actions must not set "server"',
    path: ["server"],
  })
  .refine((a) => a.kind !== "server" || a.server !== undefined, {
    message: 'server actions must set "server"',
    path: ["server"],
  })
  .refine((a) => a.kind !== "server" || a.directive === undefined, {
    message: 'server actions must not set "directive"',
    path: ["directive"],
  })
  .refine(
    (a) => {
      const names = (a.args ?? []).map((f) => f.name);
      return new Set(names).size === names.length;
    },
    { message: "arg names must be unique within an action", path: ["args"] },
  );

/** Where a knowledge item was extracted from — manifest form of core's KnowledgeSource. */
export const manifestKnowledgeSourceSchema = z.object({
  /** Site-relative path of the page the knowledge lives on, e.g. "/about". */
  page: z.string().min(1),
  /** CSS selector locating the section — usually an id fragment like "#pricing". */
  selector: z.string().min(1).optional(),
  /** Section heading text — human label, citation chip fallback title. */
  heading: z.string().min(1).optional(),
});

/**
 * One knowledge entry. The plain-string shorthand (`knowledge: string[]`)
 * is the quickest form; the object form adds a stable id (required for
 * `[[cite:id]]` citability), a source location for citation deep-links,
 * and Studio provenance.
 */
export const manifestKnowledgeItemSchema = z.union([
  z.string().min(1),
  z.object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "knowledge ids must be [a-zA-Z0-9_-]")
      .optional(),
    title: z.string().min(1).max(160).optional(),
    text: z.string().min(1),
    category: z.string().min(1).optional(),
    source: manifestKnowledgeSourceSchema.optional(),
    /**
     * Studio provenance: "ingested" items may be replaced by a re-ingest of
     * their source page; "manual" items (user-created or user-edited) are
     * only ever removed by direct user action. Core compilation ignores it.
     */
    origin: z.enum(["ingested", "manual"]).optional(),
  }),
]);

export const manifestComponentSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]"),
    title: z.string().min(1),
    /** Short description — the single most important LLM prompt input. */
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    kind: manifestComponentKindSchema,
    source: manifestSourceSchema,
    /** Optional — compilers fall back to DEFAULT_MANIFEST_GRID. */
    grid: gridHintsSchema.optional(),
    /** Knowledge items (manifest form of core's KnowledgeItem). */
    knowledge: z.array(manifestKnowledgeItemSchema).optional(),
    fields: z.array(manifestFieldSchema).optional(),
    actions: z
      .array(manifestActionSchema)
      .optional()
      .refine(
        (arr) => {
          const ids = (arr ?? []).map((a) => a.id);
          return new Set(ids).size === ids.length;
        },
        { message: "action ids must be unique within a component" },
      ),
  })
  .refine((c) => c.kind !== "dom-region" || c.source.selector !== undefined, {
    message: 'dom-region components must set "source.selector"',
    path: ["source", "selector"],
  })
  .refine((c) => c.kind !== "framework-component" || c.source.file !== undefined, {
    message: 'framework-component components must set "source.file"',
    path: ["source", "file"],
  })
  .refine((c) => c.kind !== "wp-content" || c.source.wpType !== undefined, {
    message: 'wp-content components must set "source.wpType"',
    path: ["source", "wpType"],
  });

export const registrationManifestSchema = z
  .object({
    version: z.literal(1),
    /** Studio/managed-backend site id (e.g. "fb_..."), absent for local dev. */
    siteId: z.string().min(1).optional(),
    components: z.array(manifestComponentSchema),
    /**
     * Site-wide knowledge not attached to any component — e.g. facts
     * ingested from the site's pages. Compiled into the registry's
     * site-knowledge collection (`ComponentRegistry.setKnowledge`).
     */
    knowledge: z.array(manifestKnowledgeItemSchema).optional(),
  })
  .refine(
    (m) => {
      const ids = m.components.map((c) => c.id);
      return new Set(ids).size === ids.length;
    },
    { message: "component ids must be unique within a manifest", path: ["components"] },
  )
  .refine(
    (m) => {
      const ids = (m.knowledge ?? [])
        .filter((k): k is Exclude<typeof k, string> => typeof k !== "string")
        .map((k) => k.id)
        .filter((id): id is string => id !== undefined);
      return new Set(ids).size === ids.length;
    },
    { message: "knowledge ids must be unique within a manifest", path: ["knowledge"] },
  )
  .refine(
    (m) => {
      const componentIds = new Set(m.components.map((c) => c.id));
      return (m.knowledge ?? []).every(
        (k) => typeof k === "string" || k.id === undefined || !componentIds.has(k.id),
      );
    },
    { message: "knowledge ids must not collide with component ids", path: ["knowledge"] },
  );

export type ManifestComponentKind = z.infer<typeof manifestComponentKindSchema>;
export type ManifestSource = z.infer<typeof manifestSourceSchema>;
export type ManifestKnowledgeSource = z.infer<typeof manifestKnowledgeSourceSchema>;
export type ManifestKnowledgeItem = z.infer<typeof manifestKnowledgeItemSchema>;
export type ManifestField = z.infer<typeof manifestFieldSchema>;
export type LocalDomDirective = z.infer<typeof localDomDirectiveSchema>;
export type ManifestActionArg = z.infer<typeof manifestActionArgSchema>;
export type ManifestServerBehavior = z.infer<typeof manifestServerBehaviorSchema>;
export type ManifestAction = z.infer<typeof manifestActionSchema>;
export type ManifestComponent = z.infer<typeof manifestComponentSchema>;
export type RegistrationManifest = z.infer<typeof registrationManifestSchema>;

/** Parse unknown JSON into a validated manifest. Throws ZodError on failure. */
export const parseManifest = (value: unknown): RegistrationManifest =>
  registrationManifestSchema.parse(value);

/** Non-throwing variant of {@link parseManifest}. */
export const safeParseManifest = (value: unknown) =>
  registrationManifestSchema.safeParse(value);
