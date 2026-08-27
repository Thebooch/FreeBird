import { parseExpr, parsePath } from "@freebirdai/dash-expr";
import type { Coercion, SemanticType, WidgetSpec } from "@freebirdai/dash-spec";
import { hasTokens, parseAggregation } from "@freebirdai/dash-spec";
import type {
  CompiledHighlight,
  CompileError,
  CompileResult,
  CompiledExpression,
  CompiledStep,
} from "./types.js";

/**
 * What a coercion tells us about a column's meaning. This is why the runtime
 * rarely has to guess a semantic type: the spec already said whether a number
 * is money in cents or a Unix timestamp, and a human confirmed it.
 */
const COERCION_SEMANTICS: Partial<Record<Coercion, SemanticType>> = {
  "unix_s->datetime": "timestamp",
  "unix_ms->datetime": "timestamp",
  "iso->datetime": "timestamp",
  "auto->datetime": "timestamp",
  "money:cents->major": "currency",
  "money:major": "currency",
  "percent:fraction->percent": "percent",
  percent: "percent",
  "->number": "number",
  "->string": "text",
  lower: "text",
  upper: "text",
  trim: "text",
};

const compileExpression = (source: string): CompiledExpression => ({
  source,
  // Sources carrying params cannot be parsed until the params are known, so
  // they are parsed per run behind a small cache instead.
  ast: hasTokens(source) ? null : parseExpr(source),
});

/**
 * Turn a validated widget spec into an executable form, once.
 *
 * Everything expensive or fallible — parsing paths, parsing expressions,
 * resolving aggregations — happens here rather than on every render, and any
 * failure is reported as a list rather than the first error, so the authoring
 * agent's repair loop gets the whole picture in one pass.
 */
export const compileWidget = (spec: WidgetSpec): CompileResult => {
  const errors: CompileError[] = [];
  const steps: CompiledStep[] = [];
  const semanticHints: Record<string, SemanticType> = {};

  spec.pipeline.forEach((step, index) => {
    try {
      switch (step.op) {
        case "extract":
          steps.push({ op: "extract", path: parsePath(step.path) });
          break;

        case "coerce": {
          for (const [field, coercion] of Object.entries(step.fields)) {
            const semantic = COERCION_SEMANTICS[coercion];
            if (semantic) semanticHints[field] = semantic;
          }
          steps.push({ op: "coerce", step });
          break;
        }

        case "filter":
          steps.push({ op: "filter", where: compileExpression(step.where) });
          break;

        case "derive": {
          const fields = Object.entries(step.fields).map(
            ([name, source]) => [name, compileExpression(source)] as const,
          );
          steps.push({ op: "derive", fields });
          break;
        }

        case "group": {
          for (const key of step.by) {
            const name = key.as ?? key.field;
            if (key.bucket) semanticHints[name] = "timestamp";
            else if (semanticHints[key.field]) semanticHints[name] = semanticHints[key.field]!;
          }
          for (const [name, source] of Object.entries(step.agg)) {
            const parsed = parseAggregation(source);
            if (!parsed) {
              errors.push({ step: index, message: `"${source}" is not an aggregation` });
              continue;
            }
            // count() is always a count; every other aggregation carries the
            // meaning of the column it reduces.
            if (parsed.fn === "count" || parsed.fn === "countDistinct") {
              semanticHints[name] = "count";
            } else if (parsed.field && semanticHints[parsed.field]) {
              semanticHints[name] = semanticHints[parsed.field]!;
            }
          }
          steps.push({ op: "group", step });
          break;
        }

        case "rename": {
          for (const [from, to] of Object.entries(step.fields)) {
            if (semanticHints[from]) {
              semanticHints[to] = semanticHints[from]!;
              delete semanticHints[from];
            }
          }
          steps.push({ op: "rename", step });
          break;
        }

        case "annotate": {
          for (const [field, semantic] of Object.entries(step.fields)) {
            semanticHints[field] = semantic;
          }
          steps.push({ op: "annotate", step });
          break;
        }

        case "sort":
          steps.push({ op: "sort", step });
          break;
        case "limit":
          steps.push({ op: "limit", step });
          break;
        case "select":
          steps.push({ op: "select", step });
          break;
      }
    } catch (error) {
      errors.push({
        step: index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // An explicit format always outranks anything deduced.
  for (const [field, format] of Object.entries(spec.format)) {
    semanticHints[field] = format.semantic;
  }

  /*
   * Highlight predicates compile here rather than at render time, so a bad
   * expression is a compile error listed alongside a bad `filter` — and
   * reaches the authoring agent's repair loop unchanged.
   */
  const highlights: CompiledHighlight[] = [];
  spec.highlights.forEach((highlight, index) => {
    try {
      highlights.push({
        id: highlight.id,
        tone: highlight.tone,
        label: highlight.label,
        scope: highlight.scope,
        ...(highlight.field ? { field: highlight.field } : {}),
        when: compileExpression(highlight.when),
      });
    } catch (error) {
      errors.push({
        step: null,
        message: `highlight ${index} ("${highlight.label}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    widget: {
      id: spec.id,
      title: spec.title,
      component: spec.component,
      spec,
      steps,
      semanticHints,
      format: spec.format,
      highlights,
    },
  };
};
