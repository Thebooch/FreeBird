import { z } from "zod";
import type { ActionDefinition } from "../types.js";
import type {
  ActionPreviewContent,
  ActionPreviewRow,
} from "./types.js";

export type { ActionPreviewContent, ActionPreviewRow } from "./types.js";

export type ActionPreviewFn<TArgs = Record<string, unknown>> = (
  args: TArgs,
  ctx: { label?: string },
) => ActionPreviewContent | Promise<ActionPreviewContent>;

const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  let cur: z.ZodTypeAny = schema;
  for (let i = 0; i < 8; i += 1) {
    if (
      cur instanceof z.ZodOptional ||
      cur instanceof z.ZodNullable ||
      cur instanceof z.ZodDefault
    ) {
      cur = (cur._def as { innerType: z.ZodTypeAny }).innerType;
      continue;
    }
    if (cur instanceof z.ZodEffects) {
      cur = (cur._def as { schema: z.ZodTypeAny }).schema;
      continue;
    }
    break;
  }
  return cur;
};

const fieldLabel = (name: string, schema: z.ZodTypeAny): string => {
  const inner = unwrap(schema);
  const desc =
    (schema._def as { description?: string }).description ??
    (inner._def as { description?: string }).description;
  if (desc) return desc;
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
};

const formatValue = (v: unknown): string => {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v.length > 0 ? v : "—";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length > 0 ? v.map(formatValue).join(", ") : "—";
  if (typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      return s.length > 120 ? `${s.slice(0, 119)}…` : s;
    } catch {
      return "—";
    }
  }
  return String(v);
};

/**
 * Build default confirmation copy from an action's Zod schema + current args.
 * Hosts can override via {@link ActionDefinition.preview}.
 */
export const deriveActionPreview = (
  def: Pick<ActionDefinition, "id" | "description" | "schema" | "preview">,
  args: Record<string, unknown>,
  ctx: { componentId: string; label?: string },
): ActionPreviewContent => {
  if (def.preview) {
    return def.preview(args, { label: ctx.label });
  }

  const title =
    ctx.label?.trim() ||
    `${ctx.componentId}:${def.id}`.replace(/_/g, " ");

  const root = unwrap(def.schema as z.ZodTypeAny);
  const rows: ActionPreviewRow[] = [];
  if (root instanceof z.ZodObject) {
    const shape = root.shape as Record<string, z.ZodTypeAny>;
    for (const [name, field] of Object.entries(shape)) {
      if (!(name in args)) continue;
      const v = args[name];
      if (v === undefined || v === null || v === "") continue;
      rows.push({
        label: fieldLabel(name, field),
        value: formatValue(v),
        multiline: typeof v === "string" && v.includes("\n"),
      });
    }
  }

  const summary =
    rows.length > 0
      ? `This will update ${rows.length} field${rows.length === 1 ? "" : "s"}. Review below before applying.`
      : def.description.split("\n")[0]?.trim() ||
        "Review the details below before applying.";

  return { title, summary, rows };
};
