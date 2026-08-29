import type { ConciergeContext } from "@freebirdai/dash-agent";
import type { CapabilityReport } from "@freebirdai/dash-spec";
import { widgetSources } from "@freebirdai/dash-spec";
import { z } from "zod";
import { resolveHandle, type WidgetHandle } from "./handles.js";

/**
 * The detail for one widget, on demand.
 *
 * Every widget in the workspace is registered so it can be named, cited and
 * opened — but only the open tab's carry full knowledge, because a workspace
 * of sixty widgets would otherwise put sixty endpoint-and-field descriptions
 * into every prompt and blow the budget on material almost every turn ignores.
 *
 * This is the other half of that trade, and it is the same one the endpoint
 * roster makes: names always on, detail on demand. It costs nothing until it
 * is called, reads only what is already on disk, and makes no request against
 * anybody's API — asking what a widget *is* must never spend money. Asking
 * what it currently *says* is `answer_from_data`, which does.
 */

export const lookUpWidgetSchema = z.object({
  widgetId: z
    .string()
    .min(1)
    .describe("Id of a widget from the WIDGETS list. Any tab."),
});

export const LOOK_UP_WIDGET_TOOL = {
  name: "look_up_widget",
  description:
    "Look up one widget in detail — which tab it is on, what endpoint it reads, what one " +
    "row is, and which fields it has. Call this for any widget not on the tab currently " +
    "open, rather than saying you cannot see it. Makes no request against the API.",
  schema: lookUpWidgetSchema,
} as const;

export interface LookUpWidgetInput {
  readonly handles: readonly WidgetHandle[];
  readonly context: ConciergeContext;
  readonly reports: readonly CapabilityReport[];
}

export const lookUpWidget = (
  input: LookUpWidgetInput,
  args: { readonly widgetId: string },
): Record<string, unknown> => {
  const found = resolveHandle(input.handles, args.widgetId);
  if (!found) {
    /*
     * A miss is reported as an answer, not as an invitation to keep guessing.
     * The roster in the prompt is complete, so "not found" here really does
     * mean it does not exist — and saying so is more useful than a suggestion
     * to try another spelling.
     */
    return {
      found: false,
      widgetId: args.widgetId,
      reason:
        `There is no widget with the id "${args.widgetId}". The WIDGETS list is complete, ` +
        "so it does not exist in this workspace.",
      available: input.handles.map((entry) => entry.handle).slice(0, 40),
    };
  }

  const sources = widgetSources(found.widget);
  const report = input.reports.find((candidate) =>
    sources.some((source) => source.connection === candidate.connection),
  );
  const resource = report?.resources.find((candidate) =>
    sources.some((source) => candidate.listOp === source.op || candidate.detailOp === source.op),
  );

  return {
    found: true,
    id: found.handle,
    title: found.widget.title,
    tab: found.dashboardTitle,
    onOpenTab: found.current,
    component: found.widget.component,
    reads: sources.map((source) => {
      const op = input.context.ops.find((candidate) => candidate.id === source.op);
      return {
        connection: source.connection,
        endpoint: source.op,
        ...(op?.title ? { endpointTitle: op.title } : {}),
        ...(op?.path ? { path: op.path } : {}),
        ...(op?.description ? { describes: op.description } : {}),
      };
    }),
    ...(resource ? { eachRowIs: resource.title } : {}),
    fields: sources.flatMap(
      (source) => input.context.shapes[source.op]?.fields.map((field) => field.name) ?? [],
    ),
    shows: Object.entries(found.widget.roles).map(([role, bound]) => ({
      role,
      field: Array.isArray(bound) ? bound.join(", ") : String(bound),
    })),
    /*
     * What it is, never what it currently holds — the same boundary the
     * capability report keeps on disk. Values come from `answer_from_data`,
     * which is priced and says how much it read.
     */
    note: "This describes the widget. To say what it currently shows, use answer_from_data.",
  };
};
