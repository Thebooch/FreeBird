/**
 * One value off a row, by a field path that may nest.
 *
 * Record types name their fields the way the API spells them, so a field can
 * be `Id` on one API and `property.propertyID` on the next — Rentvine wraps
 * every record in an object named after its type. A row that reached a reader
 * may carry that value three ways: under the dotted name itself, under the
 * column a `derive` step flattened it to (`property_propertyID`), or only
 * nested, as the API sent it. `derive` keeps the original keys, so the nested
 * copy is always there even when no column was made for it.
 *
 * Reading `row[path]` alone finds the first spelling and nothing else. It works
 * on every API whose identity is a top-level `Id` and silently fails on every
 * API whose identity nests — a row that looks clickable, a click that does
 * nothing, and no error anywhere to say why. One reader, shared by everything
 * that looks a field up by its path, so the nested case cannot be right in one
 * place and wrong in the next.
 */
export const readField = (row: unknown, path: string): unknown => {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Readonly<Record<string, unknown>>;

  const direct = record[path];
  if (direct !== undefined) return direct;
  if (!path.includes(".")) return undefined;

  const flattened = record[path.replace(/\./g, "_")];
  if (flattened !== undefined) return flattened;

  let current: unknown = record;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

/**
 * The inverse of {@link readField}: one value placed at a dotted path, with
 * every object on the way made if it is missing.
 *
 * Used to build request bodies, where the API's nesting is the only spelling
 * it accepts — `Address.PostalCode` has to arrive as `{ Address: {
 * PostalCode } }`, never as a flattened key. Returns a new object; the input
 * is left alone, because it is usually a record somebody is still looking at.
 */
export const setField = (
  target: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Record<string, unknown> => {
  const parts = path.split(".");
  const root: Record<string, unknown> = { ...target };
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return root;
    if (index === parts.length - 1) {
      current[part] = value;
      break;
    }
    const next = current[part];
    const copy =
      next && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    current[part] = copy;
    current = copy;
  }
  return root;
};
