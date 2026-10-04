import { fnv1a, getOp, readField, type ConnectionSpec, type OpSpec, type ParamDef } from "@freebirdai/dash-spec";
import { INCOMPLETE } from "./incomplete.js";
import { rowsAt, withRows } from "./paginate.js";
import { AdapterError, type FetchContext, type FetchMeta, type FetchResult, type SourceAdapter } from "./types.js";

/**
 * A read whose input comes from another endpoint's records.
 *
 * An organisation's projects need its id; the organisations list gives it.
 * Where the check settled on one organisation, its id is the parameter's
 * default and this only puts it in place — a path's id included, which a
 * default alone never reached. Where the question is about the whole account
 * (`valueFrom.each`), the source is read, the endpoint is read once for each
 * of its records, and the answers are put together — every record tagged
 * with the value it was read under, so a board can still tell them apart.
 *
 * Nothing here claims more than its parts: the whole is read to its end only
 * when the source was, every part was, and no source record was left out.
 */

/** The most records a whole-account read asks about, one request each. */
export const DEPENDENT_MAX = 50;
/** Sources whose own input comes from another: as deep as this, and no deeper. */
const MAX_DEPTH = 2;

type Value = string | number | boolean;

const given = (name: string, overrides: Readonly<Record<string, Value>>, ctx: FetchContext): boolean => {
  const value = overrides[name] ?? ctx.params.filters[name];
  return value !== undefined && value !== "";
};

/** A dependent parameter nobody gave a value for. */
const pending = (op: OpSpec, overrides: Readonly<Record<string, Value>>, ctx: FetchContext): ParamDef[] =>
  op.params.filter((param) => param.valueFrom && !given(param.name, overrides, ctx));

/** The value for the parameter, where it goes: a path's id among the filters, anything else beside the widget's own. */
const withValue = (
  param: ParamDef,
  value: Value,
  overrides: Readonly<Record<string, Value>>,
  ctx: FetchContext,
): { overrides: Readonly<Record<string, Value>>; ctx: FetchContext } =>
  param.in === "path"
    ? { overrides, ctx: { ...ctx, params: { ...ctx.params, filters: { ...ctx.params.filters, [param.name]: value } } } }
    : { overrides: { ...overrides, [param.name]: value }, ctx };

/** A failure about the one record a part was read for, not about the read: the API answered, and refused that record. */
const onePartOnly = (error: unknown): boolean =>
  error instanceof AdapterError && [400, 403, 404, 410, 422].includes(error.upstreamStatus ?? 0);

export class DependentAdapter implements SourceAdapter {
  readonly kind: SourceAdapter["kind"];
  readonly transport: SourceAdapter["transport"];

  constructor(private readonly inner: SourceAdapter) {
    this.kind = inner.kind;
    this.transport = inner.transport;
  }

  fetch(connection: ConnectionSpec, op: OpSpec, overrides: Readonly<Record<string, Value>>, ctx: FetchContext): Promise<FetchResult> {
    return this.read(connection, op, overrides, ctx, 0);
  }

  private async read(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, Value>>,
    ctx: FetchContext,
    depth: number,
  ): Promise<FetchResult> {
    const open = pending(op, overrides, ctx);
    if (open.length === 0) return this.inner.fetch(connection, op, overrides, ctx);
    const param = open[0]!;
    const from = param.valueFrom!;

    /* One value, settled by the check: put in place, wherever the parameter goes. */
    if (!from.each && param.default !== undefined) {
      const placed = withValue(param, param.default, overrides, ctx);
      return this.read(connection, op, placed.overrides, placed.ctx, depth);
    }

    const source = getOp(connection, from.op);
    if (!source || depth >= MAX_DEPTH)
      throw new AdapterError(`no source for ${param.name}`, {
        status: 400,
        userMessage: `"${op.title}" needs ${param.name}, and the endpoint that lists it could not be read.`,
      });
    /* A continuation is the endpoint's own read's, never its source's or one record's. */
    const { continueFrom: _continueFrom, ...fresh } = ctx;
    const read = await this.read(connection, source, {}, fresh, depth + 1);
    const values = [
      ...new Set(
        (rowsAt(read.body, source.rowsPath) ?? [])
          .map((row) => readField(row, from.field))
          .filter((value): value is Value => (typeof value === "string" && value !== "") || typeof value === "number"),
      ),
    ];
    if (!from.each) {
      if (values.length === 1) {
        const placed = withValue(param, values[0]!, overrides, ctx);
        return this.read(connection, op, placed.overrides, placed.ctx, depth);
      }
      throw new AdapterError(`${values.length} values for ${param.name}`, {
        status: 400,
        userMessage: `"${op.title}" needs one ${param.name}, and ${source.title} lists ${values.length}. Say which one the board is for.`,
      });
    }

    /*
     * The whole account: once for each record the source holds, put together.
     * One record the API will not answer for — an archived organisation's
     * 404, a project this key may not see — leaves that record's part out
     * and says so, rather than every other part with it. A failure that is
     * the whole read's (a key refused, a rate limit, a budget spent) still
     * ends it, as does every part failing.
     */
    const asked = values.slice(0, DEPENDENT_MAX);
    const parts: FetchResult[] = [];
    const readUnder: Value[] = [];
    const failed: unknown[] = [];
    for (const value of asked) {
      const placed = withValue(param, value, overrides, fresh);
      try {
        parts.push(await this.read(connection, op, placed.overrides, placed.ctx, depth));
        readUnder.push(value);
      } catch (error) {
        if (!onePartOnly(error)) throw error;
        failed.push(error);
      }
    }
    if (parts.length === 0 && failed.length > 0) throw failed[0];
    const rows: unknown[] = [];
    parts.forEach((part, index) => {
      for (const row of rowsAt(part.body, op.rowsPath) ?? [])
        rows.push(
          row !== null && typeof row === "object" && !Array.isArray(row) && !(param.name in row)
            ? { ...(row as Record<string, unknown>), [param.name]: readUnder[index] }
            : row,
        );
    });
    const left = values.length - asked.length;
    const short = left > 0 || failed.length > 0 || read.meta.truncated || parts.some((part) => part.meta.truncated);
    const unsure = read.meta.completion?.state === "unknown" || parts.some((part) => part.meta.completion?.state === "unknown");
    const warnings = [
      ...new Set([
        ...read.meta.warnings,
        ...parts.flatMap((part) => part.meta.warnings),
        ...(left > 0 ? [INCOMPLETE.dependentCap(asked.length, values.length, source.title)] : []),
        ...(failed.length > 0 ? [INCOMPLETE.dependentFailed(failed.length, asked.length, source.title)] : []),
      ]),
    ];
    const meta: FetchMeta = {
      url: parts[0]?.meta.url ?? read.meta.url,
      status: parts.at(-1)?.meta.status ?? read.meta.status,
      fetchedAt: ctx.now,
      durationMs: read.meta.durationMs + parts.reduce((sum, part) => sum + part.meta.durationMs, 0),
      pages: read.meta.pages + parts.reduce((sum, part) => sum + part.meta.pages, 0),
      requests:
        (read.meta.requests ?? read.meta.pages) + parts.reduce((sum, part) => sum + (part.meta.requests ?? part.meta.pages), 0),
      truncated: short,
      warnings,
      completion: short
        ? { state: "partial", reason: failed.length > 0 && left === 0 ? "each-failed" : "each-capped" }
        : unsure
          ? { state: "unknown", reason: "each-unsure" }
          : { state: "traversed", reason: "each-read" },
      scope: fnv1a(JSON.stringify([read.meta.scope ?? "", ...parts.map((part) => part.meta.scope ?? "")])),
    };
    return { body: withRows(parts[0]?.body ?? [], op.rowsPath, rows), meta };
  }
}
