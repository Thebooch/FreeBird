import type { BindingValidation, WidgetSpec } from "@freebirdai/dash-spec";
import { contractFor, validateBinding } from "@freebirdai/dash-spec";
import { compileWidget } from "./compile.js";
import { compilePlan, runPlan } from "./plan.js";
import { runPipeline } from "./run.js";
import type { ColumnMeta, RowHighlight, RunContext, RunMeta, RunResult, Row } from "./types.js";

export interface ExecuteResult {
  /** True only when the pipeline compiled *and* the binding is valid. */
  readonly ok: boolean;
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  readonly meta: RunMeta | null;
  readonly binding: BindingValidation | null;
  /** Compile failures. Binding failures live on `binding.errors`. */
  readonly errors: readonly string[];
  /** Index-parallel to `rows`. Absent when the widget declares none. */
  readonly highlights?: readonly (readonly RowHighlight[])[];
}

/**
 * A widget naming a component nothing supplies.
 *
 * Reachable now that ids are open: the data was fetched and shaped fine, there
 * is simply nothing to draw it with. Reported as a binding problem naming the
 * id, rather than crashing on an undefined contract.
 */
const unknownComponent = (
  id: string,
  result: { rows: readonly Row[]; columns: readonly ColumnMeta[]; meta: RunMeta },
): ExecuteResult => ({
  ok: false,
  rows: result.rows,
  columns: result.columns,
  meta: result.meta,
  binding: null,
  errors: [`no component named "${id}" is available`],
});

const EMPTY_META: RunMeta = {
  steps: [],
  warnings: [],
  coercionFailures: 0,
  rowsIn: 0,
  rowsOut: 0,
};

/**
 * Compile, run, and check the binding in one call.
 *
 * This is what the React layer, the server and the agent's preview all use,
 * so a widget behaves identically wherever it is evaluated — the same code
 * path in the browser and on the server is the whole point of keeping this
 * package pure.
 */
export const executeWidget = (
  spec: WidgetSpec,
  body: unknown,
  ctx: RunContext,
): ExecuteResult => {
  /*
   * One entry point for both shapes.
   *
   * A multi-source widget is handed a map of bodies keyed by source name
   * instead of a single body. Routing here rather than at every call site
   * means the React layer, the server and the agent preview all keep calling
   * one function and behave identically — which is the reason this package is
   * pure in the first place.
   */
  if (spec.sources.length > 0) {
    return executePlan(spec, (body ?? {}) as Record<string, unknown>, ctx);
  }

  const compiled = compileWidget(spec);
  if (!compiled.ok) {
    return {
      ok: false,
      rows: [],
      columns: [],
      meta: EMPTY_META,
      binding: null,
      errors: compiled.errors.map((error) =>
        error.step === null ? error.message : `step ${error.step}: ${error.message}`,
      ),
    };
  }

  const result = runPipeline(compiled.widget, body, ctx);
  const contract = contractFor(spec.component);
  if (!contract) return unknownComponent(spec.component, result);
  return finish(result, validateBinding(contract, spec.roles, result.columns));
};

/**
 * The shared tail of both paths.
 *
 * Single-source and multi-source widgets end identically, and they have to:
 * anything assembled twice is something that can be got right once and wrong
 * once.
 */
const finish = (result: RunResult, binding: BindingValidation): ExecuteResult => ({
  ok: binding.ok,
  rows: result.rows,
  columns: result.columns,
  meta: result.meta,
  binding,
  errors: [],
  ...(result.highlights ? { highlights: result.highlights } : {}),
});

/** The multi-source path: compile every pipeline, join, then validate roles. */
export const executePlan = (
  spec: WidgetSpec,
  bodies: Readonly<Record<string, unknown>>,
  ctx: RunContext,
): ExecuteResult => {
  const compiled = compilePlan(spec);
  if (!compiled.ok) {
    return {
      ok: false,
      rows: [],
      columns: [],
      meta: EMPTY_META,
      binding: null,
      errors: compiled.errors.map((error) =>
        error.step === null ? error.message : `step ${error.step}: ${error.message}`,
      ),
    };
  }

  const result = runPlan(compiled.plan, bodies, ctx);
  const contract = contractFor(spec.component);
  if (!contract) return unknownComponent(spec.component, result);
  // Roles are checked against the *joined* columns — the only point at which
  // the widget's real shape exists.
  return finish(result, validateBinding(contract, spec.roles, result.columns));
};
