import type { OpSpec } from "@freebirdai/dash-spec";
import { pathParamNames } from "@freebirdai/dash-spec";

/**
 * Which channel each supplied value belongs in.
 *
 * A caller sends one flat bag and should not have to know that a path segment
 * is filled by a `{{param.x}}` token read from `filters`, while everything
 * else is a query-string override. The op declares which of its parameters
 * live in the path, so the split is made here — the only place with both the
 * values and the endpoint's contract.
 *
 * Extracted because the chat's context harness reads the same endpoints as
 * `POST /api/query` and must produce the same cache key for the same request.
 * Two implementations that disagreed would let one widget be served another's
 * rows, silently and only for some parameter shapes.
 */
export const splitOpInputs = (
  op: OpSpec,
  params: Readonly<Record<string, string | number | boolean>>,
  filters: Readonly<Record<string, string | number | boolean>> = {},
): {
  /** Query-string overrides. Part of the cache key. */
  readonly overrides: Record<string, string | number | boolean>;
  /** Path-token inputs, resolved through `params.filters`. */
  readonly inputs: Record<string, string | number | boolean>;
} => {
  const pathBound = new Set([
    ...pathParamNames(op.path),
    ...op.params.filter((param) => param.in === "path").map((param) => param.name),
  ]);

  const overrides: Record<string, string | number | boolean> = {};
  const inputs: Record<string, string | number | boolean> = { ...filters };
  for (const [name, value] of Object.entries(params)) {
    if (pathBound.has(name)) inputs[name] = value;
    else overrides[name] = value;
  }
  return { overrides, inputs };
};
