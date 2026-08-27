import { z } from "zod";
import {
  createComponentRegistry,
  ticketDraftSchema,
  type ActionContext,
  type ActionDefinition,
  type AuthContext,
  type ComponentRegistry,
  type DataSourceContext,
  type GridHints,
  type SupportSinkResult,
  type TicketDraft,
} from "@freebirdai/core";
import {
  registrationManifestSchema,
  type ManifestAction,
  type ManifestComponent,
  type ManifestKnowledgeItem,
  type RegistrationManifest,
} from "./schema.js";
import { buildLocalActionResult } from "./local-action.js";

/**
 * Grid applied when a manifest entry declares none. Content regions scanned
 * off a page rarely know their ideal footprint, so we give the solver a
 * standard small/medium/large ladder.
 */
export const DEFAULT_MANIFEST_GRID: GridHints = {
  sizes: [
    { name: "compact", w: 4, h: 2, aspect: "wide" },
    { name: "half", w: 6, h: 3, aspect: "wide" },
    { name: "full", w: 12, h: 4, aspect: "wide" },
  ],
  preferredSize: "half",
  minSize: "compact",
};

/** A webhook destination resolved by the host — never stored in a manifest. */
export interface ResolvedWebhook {
  url: string;
  /** When set, requests carry an `x-freebird-signature` HMAC-SHA256 header. */
  secret?: string;
  headers?: Record<string, string>;
}

export interface CompileManifestHooks<TAuth = AuthContext> {
  /**
   * Data source for every compiled component. The managed backend cannot call
   * into a visitor's browser, so this typically reads the latest stored
   * snapshot (embed-posted DOM extraction or WP-pushed content digest).
   */
  getSnapshot: (
    componentId: string,
    ctx: DataSourceContext<TAuth>,
  ) => Promise<unknown> | unknown;
  /** Required if the manifest declares any `file-ticket` server actions. */
  fileTicket?: (
    draft: TicketDraft,
    meta: { componentId: string; actionId: string; args: Record<string, unknown> },
    ctx: ActionContext<TAuth>,
  ) => Promise<SupportSinkResult | void> | SupportSinkResult | void;
  /**
   * Resolves a symbolic webhook name to a destination. Returning null/undefined
   * rejects the action — the allowlist lives here, not in the manifest.
   * Required if the manifest declares any `webhook` server actions.
   */
  resolveWebhook?: (
    name: string,
    meta: { componentId: string; actionId: string },
  ) =>
    | ResolvedWebhook
    | null
    | undefined
    | Promise<ResolvedWebhook | null | undefined>;
  /** Injectable fetch for webhook delivery (tests, custom agents). */
  fetchImpl?: typeof fetch;
  /** Webhook delivery timeout in ms. @default 10_000 */
  webhookTimeoutMs?: number;
  /** Append into an existing registry instead of creating a fresh one. */
  registry?: ComponentRegistry<unknown, TAuth>;
}

/**
 * Compile a validated Registration Manifest into a live server-side
 * ComponentRegistry.
 *
 * Idempotent: entries are `upsert`ed, so re-compiling after a manifest change
 * (embed re-scan, WP content push) refreshes components in place.
 *
 * Manifest-declared actions are restricted to the fixed allowlist:
 * - `local-dom` → handler returns a {@link buildLocalActionResult} payload the
 *   embed executes in the visitor's browser.
 * - `file-ticket` → routed to `hooks.fileTicket`.
 * - `webhook` → resolved via `hooks.resolveWebhook`, delivered as signed JSON.
 * No path executes code from the manifest itself.
 */
export const compileServerRegistry = <TAuth = AuthContext>(
  manifest: RegistrationManifest,
  hooks: CompileManifestHooks<TAuth>,
): ComponentRegistry<unknown, TAuth> => {
  const parsed = registrationManifestSchema.parse(manifest);
  assertHooksCoverManifest(parsed, hooks);
  const registry =
    hooks.registry ?? createComponentRegistry<unknown, TAuth>();

  for (const component of parsed.components) {
    registry.upsert({
      id: component.id,
      title: component.title,
      description: component.description,
      tags: component.tags ?? [],
      knowledge: buildKnowledge(component),
      grid: component.grid ?? DEFAULT_MANIFEST_GRID,
      dataSource: (ctx: DataSourceContext<TAuth>) =>
        hooks.getSnapshot(component.id, ctx),
      actions: (component.actions ?? []).map((action) =>
        compileAction(component, action, hooks),
      ),
      ...(component.source.selector !== undefined
        ? {
            domAnchor: {
              selector: component.source.selector,
              ...(component.source.page !== undefined ? { page: component.source.page } : {}),
            },
          }
        : {}),
    });
  }
  registry.setKnowledge((parsed.knowledge ?? []).map(normalizeKnowledgeItem));
  return registry;
};

/**
 * Manifest knowledge entry → core KnowledgeItem. Strings are the plain
 * shorthand; the object form passes through minus `origin` (Studio
 * provenance the runtime doesn't need).
 */
export const normalizeKnowledgeItem = (item: ManifestKnowledgeItem) => {
  if (typeof item === "string") return { text: item };
  const { origin: _origin, ...rest } = item;
  return rest;
};

const assertHooksCoverManifest = <TAuth>(
  manifest: RegistrationManifest,
  hooks: CompileManifestHooks<TAuth>,
): void => {
  for (const component of manifest.components) {
    for (const action of component.actions ?? []) {
      if (action.server?.type === "file-ticket" && !hooks.fileTicket) {
        throw new Error(
          `FreeBird manifest: "${component.id}.${action.id}" files tickets but no fileTicket hook was provided.`,
        );
      }
      if (action.server?.type === "webhook" && !hooks.resolveWebhook) {
        throw new Error(
          `FreeBird manifest: "${component.id}.${action.id}" calls a webhook but no resolveWebhook hook was provided.`,
        );
      }
    }
  }
};

const buildKnowledge = (component: ManifestComponent) => {
  const items = (component.knowledge ?? []).map(normalizeKnowledgeItem);
  const fieldNotes = (component.fields ?? [])
    .filter((f) => f.description)
    .map((f) => ({ text: `Field "${f.name}": ${f.description}`, category: "Fields" }));
  return [...items, ...fieldNotes];
};

/**
 * Local directives that only draw the visitor's attention run without
 * confirmation; ones that change page state (form values, clicks) preview
 * first. Server actions always preview. Manifest overrides win.
 */
const defaultConfirmation = (action: ManifestAction): "none" | "preview" | "strict" => {
  if (action.requiresConfirmation) return action.requiresConfirmation;
  if (action.kind === "local-dom") {
    return action.directive === "fill-form" || action.directive === "click"
      ? "preview"
      : "none";
  }
  return "preview";
};

const argsToZod = (action: ManifestAction): z.ZodType<Record<string, unknown>> => {
  const declared = action.args ?? [];
  if (declared.length === 0) {
    // fill-form without declared args still needs somewhere to put values.
    if (action.kind === "local-dom" && action.directive === "fill-form") {
      return z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .describe("Form field values keyed by field name");
    }
    return z.object({});
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of declared) {
    let field: z.ZodTypeAny =
      arg.type === "string"
        ? z.string()
        : arg.type === "number"
          ? z.number()
          : z.boolean();
    field = field.describe(arg.description);
    if (!arg.required) field = field.optional();
    shape[arg.name] = field;
  }
  return z.object(shape) as z.ZodType<Record<string, unknown>>;
};

const compileAction = <TAuth>(
  component: ManifestComponent,
  action: ManifestAction,
  hooks: CompileManifestHooks<TAuth>,
): ActionDefinition<Record<string, unknown>, unknown, TAuth> => ({
  id: action.id,
  description: action.description,
  schema: argsToZod(action),
  requiresConfirmation: defaultConfirmation(action),
  previewStrategy: "text",
  handler: (args, ctx) => runAllowlisted(component, action, args, ctx, hooks),
});

const runAllowlisted = async <TAuth>(
  component: ManifestComponent,
  action: ManifestAction,
  args: Record<string, unknown>,
  ctx: ActionContext<TAuth>,
  hooks: CompileManifestHooks<TAuth>,
): Promise<unknown> => {
  if (action.kind === "local-dom") {
    return buildLocalActionResult({
      directive: action.directive!,
      componentId: component.id,
      ...(component.source.selector !== undefined
        ? { selector: component.source.selector }
        : {}),
      ...(component.source.page !== undefined ? { page: component.source.page } : {}),
      args,
    });
  }
  const behavior = action.server!;
  if (behavior.type === "file-ticket") {
    const draft: TicketDraft = ticketDraftSchema.parse({
      type: behavior.ticketType ?? "feature",
      severity: "medium",
      title: `${component.title}: ${action.description}`.slice(0, 200),
      summary: [
        `Visitor request via the "${action.id}" action on component "${component.id}".`,
        Object.keys(args).length > 0
          ? `Submitted values:\n${JSON.stringify(args, null, 2)}`
          : "No additional values submitted.",
      ].join("\n\n"),
      relatedComponentIds: [component.id],
      tags: [...(behavior.tags ?? []), ...(component.tags ?? [])],
    });
    const result = await hooks.fileTicket!(
      draft,
      { componentId: component.id, actionId: action.id, args },
      ctx,
    );
    return result ?? { filed: true };
  }
  // webhook
  const resolved = await hooks.resolveWebhook!(behavior.webhook, {
    componentId: component.id,
    actionId: action.id,
  });
  if (!resolved) {
    throw new Error(
      `FreeBird manifest: webhook "${behavior.webhook}" is not configured for this site.`,
    );
  }
  return deliverWebhook(resolved, {
    componentId: component.id,
    actionId: action.id,
    args,
    firedAt: new Date().toISOString(),
  }, hooks);
};

const deliverWebhook = async <TAuth>(
  destination: ResolvedWebhook,
  payload: Record<string, unknown>,
  hooks: CompileManifestHooks<TAuth>,
): Promise<unknown> => {
  const fetchImpl = hooks.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("FreeBird manifest: no fetch implementation available for webhook delivery.");
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...destination.headers,
  };
  if (destination.secret) {
    headers["x-freebird-signature"] = await hmacSha256Hex(destination.secret, body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    hooks.webhookTimeoutMs ?? 10_000,
  );
  try {
    const res = await fetchImpl(destination.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`FreeBird manifest: webhook responded ${res.status}.`);
    }
    return { delivered: true, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
};

export const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
