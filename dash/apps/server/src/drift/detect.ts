import { CHANGED } from "@freebirdai/dash-adapters";
import { inferShape } from "@freebirdai/dash-agent";
import { rowsOf } from "../integrate/read.js";

/**
 * Whether an endpoint still answers in the shape it was accepted in (plan,
 * track H).
 *
 * A hash of every field a read happened to hold changes whenever an optional
 * field is absent from a page, so it cries drift at ordinary data. What is
 * compared here is narrower, and each part is something a saved widget can be
 * wrong about without any error:
 *
 * - a field **every** record held when the endpoint was accepted, that **no**
 *   record holds now — removed, or renamed;
 * - a field that holds another kind of thing — a number where there was text,
 *   a list where there was a value;
 * - records that are no longer where the endpoint's row path says, while a
 *   list of records sits somewhere else in the answer.
 *
 * Shape only: names and kinds, never a value from the account.
 */

export interface ShapeField {
  readonly name: string;
  /** What it held, `null` aside: string, number, boolean, object, array. */
  readonly kinds: readonly string[];
  /** Whether every record read held it (null counts: the key was there). */
  readonly always: boolean;
}

export interface AcceptedShape {
  readonly rowsPath: string;
  /** How many records the shape was read from. */
  readonly rows: number;
  readonly fields: readonly ShapeField[];
  readonly at: string;
}

export interface Drift {
  /** Fields every record held, that none holds now. */
  readonly gone: readonly string[];
  readonly retyped: ReadonlyArray<{ readonly name: string; readonly was: readonly string[]; readonly now: readonly string[] }>;
  /** Where the records are now, when the endpoint's own path holds none. */
  readonly moved?: string;
  /** Fields every record holds now that none was accepted with: what a removed one may have become. */
  readonly appeared: ReadonlyArray<{ readonly name: string; readonly kinds: readonly string[] }>;
}

const MAX_ROWS = 200;
const MAX_FIELDS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const kindOf = (value: unknown): string =>
  value === null || value === undefined ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;

/** The shape of the records at a path: each field, one level of nesting down. */
export const shapeOf = (body: unknown, rowsPath: string | undefined, now: number): AcceptedShape => {
  const rows = rowsOf(body, rowsPath).filter(isRecord).slice(0, MAX_ROWS);
  const seen = new Map<string, { kinds: Set<string>; count: number }>();
  const note = (name: string, value: unknown): void => {
    let entry = seen.get(name);
    if (!entry) {
      if (seen.size >= MAX_FIELDS) return;
      entry = { kinds: new Set(), count: 0 };
      seen.set(name, entry);
    }
    entry.count++;
    const kind = kindOf(value);
    if (kind !== "null") entry.kinds.add(kind);
  };
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      note(key, value);
      if (isRecord(value)) for (const [inner, innerValue] of Object.entries(value)) note(`${key}.${inner}`, innerValue);
    }
  }
  return {
    rowsPath: rowsPath ?? "$",
    rows: rows.length,
    fields: [...seen].map(([name, entry]) => ({ name, kinds: [...entry.kinds].sort(), always: entry.count === rows.length })),
    at: new Date(now).toISOString(),
  };
};

/** A nested field whose parent is already listed says nothing more. */
const topmost = (names: readonly string[]): string[] => {
  const all = new Set(names);
  return names.filter((name) => !name.includes(".") || !all.has(name.slice(0, name.indexOf("."))));
};

/**
 * What changed between the shape an endpoint was accepted in and an answer
 * read now, or null when nothing a widget could be wrong about did.
 */
export const driftBetween = (accepted: AcceptedShape, body: unknown, rowsPath: string | undefined, now: number): Drift | null => {
  const fresh = shapeOf(body, rowsPath, now);
  if (accepted.rows === 0) return null;
  if (fresh.rows === 0) {
    /* No records at the path: an empty account, unless a list of records sits elsewhere in the answer. */
    const found = inferShape(body);
    const elsewhere = found.rowCount > 0 && found.rowsPath !== (rowsPath ?? "$") && found.rowsPath !== "$";
    const records = elsewhere ? rowsOf(body, found.rowsPath).filter(isRecord).length : 0;
    return records > 0 ? { gone: [], retyped: [], moved: found.rowsPath, appeared: [] } : null;
  }
  /* A page of one or two says too little about what every record holds, unless the endpoint only ever held as few. */
  if (fresh.rows < Math.min(3, accepted.rows)) return null;
  const now_ = new Map(fresh.fields.map((field) => [field.name, field]));
  const was = new Map(accepted.fields.map((field) => [field.name, field]));
  const gone = topmost(accepted.fields.filter((field) => field.always && !now_.has(field.name)).map((field) => field.name));
  const retyped = accepted.fields.flatMap((field) => {
    const current = now_.get(field.name);
    if (!current || field.kinds.length === 0 || current.kinds.length === 0) return [];
    return current.kinds.some((kind) => field.kinds.includes(kind)) ? [] : [{ name: field.name, was: field.kinds, now: current.kinds }];
  });
  if (gone.length === 0 && retyped.length === 0) return null;
  const appeared = topmost(fresh.fields.filter((field) => field.always && !was.has(field.name)).map((field) => field.name)).map((name) => ({
    name,
    kinds: now_.get(name)!.kinds,
  }));
  return { gone, retyped, appeared };
};

const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

/**
 * What a removed field may have become: a new field of the same kind that
 * shares a word with it, when exactly one does. A suggestion for a person to
 * read, never a change anything makes by itself.
 */
export const likelyRenames = (accepted: AcceptedShape, drift: Drift): ReadonlyArray<{ readonly from: string; readonly to: string }> => {
  const kinds = new Map(accepted.fields.map((field) => [field.name, field.kinds]));
  return drift.gone.flatMap((from) => {
    const words = new Set(wordsOf(from));
    const was = kinds.get(from) ?? [];
    const matches = drift.appeared.filter(
      (one) => one.kinds.some((kind) => was.length === 0 || was.includes(kind)) && wordsOf(one.name).some((word) => words.has(word)),
    );
    return matches.length === 1 ? [{ from, to: matches[0]!.name }] : [];
  });
};

const KIND_WORDS: Record<string, string> = {
  string: "text",
  number: "a number",
  boolean: "yes or no",
  object: "a record",
  array: "a list",
};

const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** A drift in words for a tile: what changed, and that what is built on it may be wrong. */
export const driftNote = (title: string, accepted: AcceptedShape, drift: Drift): string => {
  const parts: string[] = [];
  if (drift.moved) parts.push(`its records are no longer where they were (they are now at ${drift.moved})`);
  if (drift.gone.length > 0) {
    const renames = likelyRenames(accepted, drift);
    const hint = renames.length > 0 ? ` (${renames.map((one) => `“${one.to}” is new, and may be what “${one.from}” became`).join("; ")})` : "";
    parts.push(`its records no longer hold ${listed(drift.gone.slice(0, 6).map((name) => `“${name}”`))}${drift.gone.length > 6 ? " and others" : ""}${hint}`);
  }
  for (const one of drift.retyped.slice(0, 3))
    parts.push(`“${one.name}” now holds ${listed(one.now.map((kind) => KIND_WORDS[kind] ?? kind))} where it held ${listed(one.was.map((kind) => KIND_WORDS[kind] ?? kind))}`);
  return CHANGED.since(title, parts.join("; "));
};

/** Every field a drift touches, for asking whether anything saved reads one. */
export const driftFields = (drift: Drift): string[] => [...drift.gone, ...drift.retyped.map((one) => one.name)];
