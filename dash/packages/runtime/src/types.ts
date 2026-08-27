import type { ExprAst, PathAst } from "@freebirdai/dash-expr";
import type {
  ColumnMeta,
  ComponentId,
  FormatSpec,
  PipelineStep,
  ResolvedParams,
  SemanticType,
  WidgetSpec,
} from "@freebirdai/dash-spec";

export type Row = Record<string, unknown>;

/**
 * Everything the runtime needs from the outside world. There is no
 * `Date.now()` anywhere in this package — the clock is injected so a pipeline
 * run is reproducible, which is what makes the golden fixtures meaningful.
 */
export interface RunContext {
  readonly now: number;
  readonly params: ResolvedParams;
  readonly timeZone?: string;
  /** Hard cap on rows carried between steps. Defaults to 50,000. */
  readonly maxRows?: number;
}

export interface StepTrace {
  /**
   * The step that ran. A plan qualifies it with the source it belongs to
   * (`leases.extract`) and adds `join`, so this is wider than a pipeline
   * step name — it is a label for the inspector, not a discriminant.
   */
  readonly op: PipelineStep["op"] | string;
  readonly rowsIn: number;
  readonly rowsOut: number;
  /** Human-readable detail, shown in the widget inspector. */
  readonly note?: string;
}

export interface RunMeta {
  /** Per-step row counts — the backbone of the provenance inspector. */
  readonly steps: readonly StepTrace[];
  readonly warnings: readonly string[];
  /** Values a coercion turned into null. Silent data loss, made visible. */
  readonly coercionFailures: number;
  readonly rowsIn: number;
  readonly rowsOut: number;
  /**
   * Rows matched, per highlight id.
   *
   * A rule matching zero rows is the interesting case: `evalPredicate` returns
   * false for a column that does not exist, so a typo fails silently. Counting
   * is what turns that into something visible.
   */
  readonly highlightCounts?: Readonly<Record<string, number>>;
}

/** One highlight that matched, ready to render. */
export interface RowHighlight {
  readonly id: string;
  readonly tone: "good" | "warning" | "serious" | "critical" | "neutral";
  readonly label: string;
  /** Present when the highlight marks one field rather than the row. */
  readonly field?: string;
}

export interface RunResult {
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  readonly meta: RunMeta;
  /**
   * Index-parallel to `rows`, and absent when a widget declares none.
   *
   * Deliberately not a reserved column on the row. Anything that lives on a
   * row becomes a real column: it flows into `inferColumns`, gets counted by
   * `validateBinding`, shows up in the inspector, and — decisively — a table
   * with no bound `columns` role renders every column it can find, so a
   * reserved name would appear as a literal header.
   */
  readonly highlights?: readonly (readonly RowHighlight[])[];
}

export interface CompileError {
  readonly step: number | null;
  readonly message: string;
}

/** An expression that may carry `{{…}}` params, parsed when it cannot vary. */
export interface CompiledExpression {
  readonly source: string;
  /** Pre-parsed when the source has no params. */
  readonly ast: ExprAst | null;
}

export type CompiledStep =
  | { readonly op: "extract"; readonly path: PathAst }
  | { readonly op: "coerce"; readonly step: Extract<PipelineStep, { op: "coerce" }> }
  | { readonly op: "filter"; readonly where: CompiledExpression }
  | {
      readonly op: "derive";
      readonly fields: ReadonlyArray<readonly [string, CompiledExpression]>;
    }
  | { readonly op: "group"; readonly step: Extract<PipelineStep, { op: "group" }> }
  | { readonly op: "sort"; readonly step: Extract<PipelineStep, { op: "sort" }> }
  | { readonly op: "limit"; readonly step: Extract<PipelineStep, { op: "limit" }> }
  | { readonly op: "rename"; readonly step: Extract<PipelineStep, { op: "rename" }> }
  | { readonly op: "select"; readonly step: Extract<PipelineStep, { op: "select" }> }
  | { readonly op: "annotate"; readonly step: Extract<PipelineStep, { op: "annotate" }> };

export interface CompiledWidget {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentId;
  readonly spec: WidgetSpec;
  readonly steps: readonly CompiledStep[];
  /** Semantic types deduced from coercions, aggregations and annotations. */
  readonly semanticHints: Readonly<Record<string, SemanticType>>;
  readonly format: Readonly<Record<string, FormatSpec>>;
  readonly highlights: readonly CompiledHighlight[];
}

export interface CompiledHighlight {
  readonly id: string;
  readonly tone: RowHighlight["tone"];
  readonly label: string;
  readonly scope: "row" | "field";
  readonly field?: string;
  readonly when: CompiledExpression;
}

export type CompileResult =
  | { readonly ok: true; readonly widget: CompiledWidget }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

export type { ColumnMeta };
