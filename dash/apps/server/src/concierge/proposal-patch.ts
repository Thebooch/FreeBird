import type { DraftPatch, ProposalResult } from "@freebirdai/dash-agent";
import { isEmptyShape, rolesForShape } from "@freebirdai/dash-spec";
import { renameExprFields } from "@freebirdai/dash-expr";

/** Both primary and additional widgets cross the same lossless boundary. */
export const proposalPatch = (proposal: ProposalResult): DraftPatch => {
  const widget = proposal.widget;
  if (!widget) return {};
  const sources: Record<string, string> = {};
  for (const step of widget.pipeline) if (step.op === "derive") Object.assign(sources, step.fields);
  const source = (name: string) => sources[name] ?? name;
  const decided = rolesForShape(proposal.measurement ?? undefined);
  const coercions = Object.fromEntries(
    widget.pipeline.flatMap((step) =>
      step.op === "coerce"
        ? Object.entries(step.fields).map(([name, value]) => [source(name), value])
        : [],
    ),
  );
  return {
    component: widget.component,
    title: widget.title,
    roles: Object.fromEntries(
      Object.entries(widget.roles)
        .filter(([role]) => decided[role] === undefined)
        .map(([role, bound]) => [
          role,
          (Array.isArray(bound) ? bound : [bound]).map((name) => source(String(name))),
        ]),
    ),
    coercions,
    format: Object.fromEntries(
      Object.entries(widget.format).map(([name, value]) => [source(name), value]),
    ),
    ...(proposal.measurement && !isEmptyShape(proposal.measurement)
      ? {
          shape: {
            ...proposal.measurement,
            ...(proposal.measurement.filter
              ? { filter: renameExprFields(proposal.measurement.filter, sources) }
              : {}),
            groupBy: proposal.measurement.groupBy.map((key) => ({
              ...key,
              field: source(key.field),
            })),
            measures: proposal.measurement.measures.map((measure) =>
              measure.field ? { ...measure, field: source(measure.field) } : measure,
            ),
          },
        }
      : {}),
  };
};
