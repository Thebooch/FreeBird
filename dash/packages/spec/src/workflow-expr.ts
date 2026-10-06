import { ExprEvalError, ExprParseError, evalExpr, parseExpr, truthy, type ExprAst } from "@freebirdai/expr";

/**
 * The two kinds of expression a workflow holds, both `@freebirdai/expr` (no
 * `eval`, hostile-input limits, own properties only):
 *
 * - a **predicate** — `criteria` and a step's `when` — written bare:
 *   `status == "open" && cost >= 500`;
 * - a **template** — a step's text — where `{{ … }}` holds an expression:
 *   `Inspect {{ unit.name }}`. A template that is one expression and nothing
 *   else keeps the value's own type.
 *
 * The row a step sees is the record, with the run's inputs under `input`.
 */

const TOKEN = /\{\{([\s\S]*?)\}\}/g;
const WHOLE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;

const astCache = new Map<string, ExprAst>();
const parsed = (source: string): ExprAst => {
  const held = astCache.get(source);
  if (held) return held;
  const ast = parseExpr(source);
  if (astCache.size >= 500) astCache.clear();
  astCache.set(source, ast);
  return ast;
};

const messageOf = (error: unknown): string =>
  error instanceof ExprParseError || error instanceof ExprEvalError || error instanceof Error ? error.message : String(error);

/** What is wrong with a predicate, or null. */
export const predicateProblem = (source: string | undefined): string | null => {
  if (source === undefined || source.trim() === "") return null;
  try {
    parsed(source);
    return null;
  } catch (error) {
    return messageOf(error);
  }
};

/** What is wrong with a template's expressions, or null. */
export const templateProblem = (source: string | undefined): string | null => {
  if (source === undefined) return null;
  for (const match of source.matchAll(TOKEN)) {
    const inner = match[1] ?? "";
    if (inner.trim() === "") return "An empty {{ }} has nothing to read.";
    try {
      parsed(inner);
    } catch (error) {
      return `${messageOf(error)} in {{${inner}}}`;
    }
  }
  return null;
};

/** Whether a row passes a predicate. Absent passes; one that cannot be read does not. */
export const passes = (source: string | undefined, row: unknown, now: number): boolean => {
  if (source === undefined || source.trim() === "") return true;
  try {
    return truthy(evalExpr(parsed(source), row, { now }));
  } catch {
    return false;
  }
};

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

/** A template's value: the expression's own value for `{{ x }}` alone, text otherwise. */
export const renderValue = (source: string, row: unknown, now: number): unknown => {
  const whole = WHOLE.exec(source);
  if (whole && !(whole[1] ?? "").includes("}}")) return evalExpr(parsed(whole[1] ?? ""), row, { now });
  return source.replace(TOKEN, (_all, inner: string) => asText(evalExpr(parsed(inner), row, { now })));
};

/** A template as text. */
export const renderText = (source: string, row: unknown, now: number): string => asText(renderValue(source, row, now));

/** The row a step sees: the record, and the run's inputs as `input`. */
export const stepRow = (row: unknown, inputs: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> => ({
  ...(row !== null && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : { value: row }),
  input: inputs ?? {},
});
