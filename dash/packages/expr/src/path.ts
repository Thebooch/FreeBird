import { ExprParseError } from "./errors.js";
import { LIMITS, assertSafeKey, readProp } from "./limits.js";

/**
 * A deliberately tiny JSONPath subset:
 *
 *   $.data[*].amount
 *   $.results[0].id
 *   $["odd key"].value
 *
 * That is the whole grammar. No filters, no scripts, no recursive descent,
 * no subexpressions — the things that turn a path library into a code
 * execution surface.
 */
export type PathSegment =
  | { readonly kind: "key"; readonly key: string }
  /** Negative counts from the end, so `-1` is the last element. */
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "wildcard" };

export interface PathAst {
  readonly segments: readonly PathSegment[];
  readonly source: string;
}

const isIdentStart = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";

const isIdentChar = (ch: string): boolean => isIdentStart(ch) || (ch >= "0" && ch <= "9") || ch === "-";

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

export const parsePath = (source: string): PathAst => {
  if (source.length > LIMITS.maxSourceChars) {
    throw new ExprParseError("path is too long", -1);
  }
  const src = source.trim();
  const at = (i: number): string => src[i] ?? "";

  if (at(0) !== "$") throw new ExprParseError('a path must start with "$"', 0);

  const segments: PathSegment[] = [];
  let i = 1;

  while (i < src.length) {
    if (segments.length >= LIMITS.maxPathSegments) {
      throw new ExprParseError("path has too many segments", i);
    }
    const ch = at(i);

    if (ch === ".") {
      i++;
      if (at(i) === "*") {
        segments.push({ kind: "wildcard" });
        i++;
        continue;
      }
      const start = i;
      if (!isIdentStart(at(i))) {
        throw new ExprParseError('expected a property name after "."', start);
      }
      while (i < src.length && isIdentChar(at(i))) i++;
      const key = src.slice(start, i);
      assertSafeKey(key, start);
      segments.push({ kind: "key", key });
      continue;
    }

    if (ch === "[") {
      i++;
      if (at(i) === "*") {
        if (at(i + 1) !== "]") throw new ExprParseError('expected "]" after "*"', i + 1);
        segments.push({ kind: "wildcard" });
        i += 2;
        continue;
      }
      if (at(i) === '"' || at(i) === "'") {
        const quote = at(i);
        i++;
        const start = i;
        let key = "";
        while (i < src.length && at(i) !== quote) {
          if (at(i) === "\\" && i + 1 < src.length) {
            key += at(i + 1);
            i += 2;
            continue;
          }
          key += at(i);
          i++;
        }
        if (i >= src.length) throw new ExprParseError("unterminated quoted key in path", start);
        assertSafeKey(key, start);
        i++; // closing quote
        if (at(i) !== "]") throw new ExprParseError('expected "]" after a quoted key', i);
        i++;
        segments.push({ kind: "key", key });
        continue;
      }
      // `[last]` is sugar for `[-1]`. Cursor-paginated APIs routinely use the
      // last item's id as the next cursor (Stripe's `starting_after`), which
      // is unreachable with non-negative indices alone.
      if (src.startsWith("last]", i)) {
        segments.push({ kind: "index", index: -1 });
        i += 5;
        continue;
      }
      if (src.startsWith("first]", i)) {
        segments.push({ kind: "index", index: 0 });
        i += 6;
        continue;
      }

      const start = i;
      if (at(i) === "-") i++;
      const digitsFrom = i;
      while (i < src.length && isDigit(at(i))) i++;
      if (i === digitsFrom) {
        throw new ExprParseError('expected an array index, "*", "last", or a quoted key', start);
      }
      const index = Number(src.slice(start, i));
      if (at(i) !== "]") throw new ExprParseError('expected "]" after an array index', i);
      i++;
      segments.push({ kind: "index", index });
      continue;
    }

    throw new ExprParseError(`unexpected character "${ch}" in path`, i);
  }

  return { segments, source: src };
};

/**
 * Evaluate a path against a payload, returning every match.
 *
 * A wildcard over an array spreads its elements; over an object it spreads
 * its own values, since plenty of APIs return keyed maps rather than lists.
 * Missing keys simply drop out of the match set — a path that matches
 * nothing yields `[]` rather than throwing.
 */
export const evalPath = (ast: PathAst, root: unknown): unknown[] => {
  let current: unknown[] = [root];

  for (const segment of ast.segments) {
    const next: unknown[] = [];
    for (const value of current) {
      switch (segment.kind) {
        case "key": {
          const found = readProp(value, segment.key);
          if (found !== undefined) next.push(found);
          break;
        }
        case "index": {
          if (!Array.isArray(value)) break;
          const at = segment.index < 0 ? value.length + segment.index : segment.index;
          if (at >= 0 && at < value.length) next.push(value[at]);
          break;
        }
        case "wildcard": {
          if (Array.isArray(value)) {
            for (const element of value) next.push(element);
          } else if (value !== null && typeof value === "object") {
            for (const key of Object.keys(value)) next.push(readProp(value, key));
          }
          break;
        }
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  return current;
};

/**
 * Resolve a path to a row set.
 *
 * `$.data[*]` yields the elements directly. `$.data` yields a single match
 * that happens to be an array — which callers mean as "these are the rows",
 * so it is unwrapped. Anything else becomes a one-row set.
 */
export const extractRows = (ast: PathAst, root: unknown): unknown[] => {
  const matches = evalPath(ast, root);
  if (matches.length === 1 && Array.isArray(matches[0])) return matches[0];
  return matches;
};
