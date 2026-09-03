import { extractRows, parsePath } from "@freebirdai/dash-expr";
import type { CatalogEntry, ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";

/**
 * What earns a catalog entry its `verified` badge.
 *
 * The rule was already written down — `dash/catalog/README.md` says the flag
 * "flips to true only when a real request against a real key returns usable
 * rows" — and nothing enforced it, so in practice it read `false` forever and
 * meant nothing. This is the enforcement.
 *
 * The oracle is the validate step, for the reason the discovery route already
 * states: documentation lies and a live 200 does not. A dialect written from
 * docs is a hypothesis about `rowsPath`, `pagination` and `timeFilter`; the
 * only thing that settles it is asking the real API and finding rows where the
 * dialect claimed they would be.
 *
 * Note what is deliberately *not* enough. A 403 is treated as a passing
 * validation elsewhere — correctly, because it proves the credential works —
 * but it says nothing about the envelope, so it must never verify a dialect.
 * Neither may an empty result: `rowsPath` resolving to `[]` is indistinguishable
 * from resolving to nothing at all, and under-claiming is the only safe
 * direction for a flag whose whole job is to say "this has been proven".
 */

/**
 * Did this body actually contain data?
 *
 * One empty object is not a row. A `summary` endpoint legitimately returns a
 * single object rather than a list, so a lone object counts — but only when it
 * carries at least one field, or the check would pass on `{}`.
 */
export const usableRows = (rows: readonly unknown[]): boolean => {
  if (rows.length === 0) return false;
  if (rows.length > 1) return true;
  const only = rows[0];
  if (only === null || only === undefined) return false;
  if (Array.isArray(only)) return only.length > 0;
  if (typeof only === "object") return Object.keys(only as object).length > 0;
  return true;
};

/**
 * Read the rows a validated response returned, the way the runtime would.
 *
 * Uses the op's own `rowsPath` so this proves the *dialect's* claim rather
 * than some independent guess about where rows live. A malformed path is a
 * failure to verify, never a throw: validation succeeded for the user either
 * way, and the badge is the only thing at stake.
 */
export const rowsFromBody = (body: unknown, rowsPath: string | undefined): unknown[] => {
  if (!rowsPath) return Array.isArray(body) ? body : [body];
  try {
    return extractRows(parsePath(rowsPath), body);
  } catch {
    return [];
  }
};

/**
 * Should this successful validation flip the entry the connection came from?
 *
 * Returns the entry id to verify, or null. Null covers every ordinary case:
 * a connection nobody built from a catalog entry, an entry already verified,
 * and a response that came back empty.
 */
export const catalogEntryToVerify = (input: {
  connection: ConnectionSpec;
  op: Pick<OpSpec, "rowsPath"> | undefined;
  body: unknown;
  entry: CatalogEntry | null;
}): string | null => {
  const { connection, op, body, entry } = input;
  // Only ever verifies the entry this connection was actually created from.
  if (!connection.catalog) return null;
  if (!entry || entry.id !== connection.catalog) return null;
  // Only ever false → true. Nothing here can un-verify a proven dialect.
  if (entry.verified) return null;
  return usableRows(rowsFromBody(body, op?.rowsPath)) ? entry.id : null;
};
