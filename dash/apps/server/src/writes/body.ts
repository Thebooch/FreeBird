import type { WriteDiffRow, WriteField, WriteFieldError, WriteTarget } from "@freebirdai/dash-spec";
import { humanLabel, readField, setField } from "@freebirdai/dash-spec";

/**
 * The body a change sends, built from what a person asked for and what the
 * record already holds.
 *
 * Pure, and the only place that knows the difference between the three ways
 * an API takes a change:
 *
 * - **replace** (`PUT`): the body *is* the record. Every value the API should
 *   keep has to be sent, so the body starts as the current record — read
 *   through each field's `readFrom` — with the changes laid over it. A body
 *   built from the changes alone would clear everything else.
 * - **merge** (`PATCH`): only what changed is sent. Nothing else is touched.
 * - **create**: only what was given, and every required value must be.
 *
 * Values arrive typed from a form and as text from the assistant; both are
 * brought to the type the request declares before anything is checked.
 */

export type Values = Readonly<Record<string, unknown>>;

export type FieldError = WriteFieldError;
export type DiffRow = WriteDiffRow;

export const labelOf = (field: WriteField): string =>
  field.label ?? humanLabel(field.path.replace(/\[\]/g, "").split(".").slice(-2).join(" "));

const isArrayItem = (field: WriteField): boolean => field.path.includes("[]");
const arrayOwner = (field: WriteField): string => field.path.slice(0, field.path.indexOf("[]"));

/** Fields a person can set: not hidden, not a container of other fields. */
export const settable = (fields: readonly WriteField[]): WriteField[] =>
  fields.filter((field) => {
    if (field.hidden) return false;
    if (field.type !== "object") return true;
    // An object with no fields of its own listed is set whole.
    return !fields.some((other) => other.path.startsWith(`${field.path}.`));
  });

const emptyText = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * A value in the type the request declares, or an error saying why not.
 *
 * `undefined` means "not given"; `null` means "cleared".
 */
export const coerceValue = (
  field: WriteField,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || (typeof raw === "string" && raw.trim() === "" && field.type !== "string")) {
    return { ok: true, value: null };
  }
  switch (field.type) {
    case "string": {
      const text = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
      if (text === undefined) return { ok: false, message: "must be text" };
      if (field.format === "date" && text !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
        const parsed = Date.parse(text);
        if (Number.isNaN(parsed)) return { ok: false, message: "must be a date (YYYY-MM-DD)" };
        return { ok: true, value: new Date(parsed).toISOString().slice(0, 10) };
      }
      if (field.format === "date-time" && text !== "" && Number.isNaN(Date.parse(text))) {
        return { ok: false, message: "must be a date and time" };
      }
      return { ok: true, value: field.format === "date" ? text.trim() : text };
    }
    case "integer":
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,\s$€£]/g, "")) : NaN;
      if (!Number.isFinite(n)) return { ok: false, message: "must be a number" };
      if (field.type === "integer" && !Number.isInteger(n)) return { ok: false, message: "must be a whole number" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const text = String(raw).trim().toLowerCase();
      if (["true", "yes", "1", "on"].includes(text)) return { ok: true, value: true };
      if (["false", "no", "0", "off"].includes(text)) return { ok: true, value: false };
      return { ok: false, message: "must be yes or no" };
    }
    case "array": {
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",").map((part) => part.trim()).filter((part) => part !== "")
          : [raw];
      if (!field.items) return { ok: true, value: list };
      const items: unknown[] = [];
      for (const item of list) {
        const one = coerceValue({ ...field, type: field.items, path: field.path } as WriteField, item);
        if (!one.ok) return { ok: false, message: `each value ${one.message}` };
        items.push(one.value);
      }
      return { ok: true, value: items };
    }
    case "object":
      return raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: "must be a group of values" };
  }
};

const checkBounds = (field: WriteField, value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (field.enum && typeof value !== "object" && !field.enum.includes(String(value))) {
    return `must be one of: ${field.enum.slice(0, 12).join(", ")}${field.enum.length > 12 ? ", …" : ""}`;
  }
  if (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength) {
    return `must be at most ${field.maxLength} characters`;
  }
  if (typeof value === "number") {
    if (field.minimum !== undefined && value < field.minimum) return `must be at least ${field.minimum}`;
    if (field.maximum !== undefined && value > field.maximum) return `must be at most ${field.maximum}`;
  }
  return undefined;
};

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The same values, keyed by the request's own field paths.
 *
 * A form always uses the exact path. The assistant speaks as people do —
 * "year built" for `YearBuilt`, "postal code" for `Address.PostalCode` — so a
 * name that is not a path is matched, in order, against the path spelled
 * without its punctuation and case, then the field's label, then the last
 * segment of its path. Only a match that is unique counts; anything else is
 * left as it was and refused below, with the names it could have been.
 */
export const resolveValueKeys = (
  fields: readonly WriteField[],
  values: Values,
): Record<string, unknown> => {
  const known = new Set(fields.map((field) => field.path));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (known.has(key)) {
      out[key] = value;
      continue;
    }
    const wanted = squash(key);
    const candidates = [
      (field: WriteField) => squash(field.path) === wanted,
      (field: WriteField) => squash(labelOf(field)) === wanted,
      (field: WriteField) => squash(field.path.split(".").pop() ?? field.path) === wanted,
    ];
    let matched: string | undefined;
    for (const test of candidates) {
      const hits = fields.filter((field) => !field.hidden && field.type !== "object" && test(field));
      if (hits.length === 1) {
        matched = hits[0]!.path;
        break;
      }
      if (hits.length > 1) break;
    }
    out[matched ?? key] = value;
  }
  return out;
};

export interface BuiltBody {
  readonly body: Record<string, unknown> | undefined;
  readonly errors: FieldError[];
  /** Fields a replace sends without a value it knows — the API may clear them. */
  readonly notSent: string[];
  readonly rows: DiffRow[];
}

const display = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  }
  return String(value);
};

/** The record's current value for one field of the request, where it is known. */
export const currentValue = (field: WriteField, before: unknown): unknown =>
  field.readFrom ? readField(before, field.readFrom) : undefined;

/**
 * The body to send, and everything wrong with it.
 *
 * `before` is the record as it is now — `null` for a create, or for an
 * upsert whose record does not exist yet — and is only read, never sent
 * back as it is: only fields the request declares are copied, so nothing the
 * API returns but does not accept can sneak into a change.
 */
export const buildBody = (input: {
  readonly target: WriteTarget;
  readonly values: Values;
  readonly before: unknown;
  /** The mode this body is built for: an upsert is a create or a replace by now. */
  readonly mode: "create" | "replace" | "merge";
}): BuiltBody => {
  const { target, before, mode } = input;
  const values = resolveValueKeys(target.fields, input.values);
  const fields = target.fields;
  const errors: FieldError[] = [];
  const known = new Map(fields.map((field) => [field.path, field]));

  // Nothing may be set that the request does not declare, or that is not a person's to set.
  for (const path of Object.keys(values)) {
    const field = known.get(path);
    if (!field) {
      const owner = fields.find((one) => isArrayItem(one) && arrayOwner(one) === path);
      if (!owner) {
        const accepted = settable(fields)
          .filter((one) => !one.path.includes("[]"))
          .slice(0, 30)
          .map((one) => `${one.path} (${labelOf(one)})`)
          .join(", ");
        errors.push({
          field: path,
          label: path,
          message: `is not something this change accepts — it takes: ${accepted}`,
        });
      }
    } else if (field.hidden) {
      errors.push({ field: path, label: labelOf(field), message: "is set by the API, not by a person" });
    }
  }

  // A list of records is set through its items, never as a plain value.
  const owners = new Set(fields.filter(isArrayItem).map(arrayOwner));
  const given = new Map<string, unknown>();
  for (const field of settable(fields)) {
    if (isArrayItem(field) || owners.has(field.path)) continue;
    const coerced = coerceValue(field, values[field.path]);
    if (!coerced.ok) {
      errors.push({ field: field.path, label: labelOf(field), message: coerced.message });
      continue;
    }
    if (coerced.value !== undefined) {
      const bound = checkBounds(field, coerced.value);
      if (bound) errors.push({ field: field.path, label: labelOf(field), message: bound });
      given.set(field.path, coerced.value);
    }
  }

  // Lists of records — `Units: [{UnitNumber}]` — arrive whole, and are checked item by item.
  for (const owner of owners) {
    const raw = values[owner];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      errors.push({ field: owner, label: humanLabel(owner), message: "must be a list" });
      continue;
    }
    const itemFields = fields.filter((field) => isArrayItem(field) && arrayOwner(field) === owner);
    const items = raw.map((item, index) => {
      let built: Record<string, unknown> = {};
      for (const field of itemFields) {
        const sub = field.path.slice(owner.length + 3);
        if (sub === "" || fields.some((other) => other.path.startsWith(`${field.path}.`))) continue;
        const coerced = coerceValue(field, readField(item, sub));
        const where = `${labelOf(field)} (item ${index + 1})`;
        if (!coerced.ok) {
          errors.push({ field: field.path, label: where, message: coerced.message });
        } else if (coerced.value === undefined || coerced.value === null) {
          if (field.required) errors.push({ field: field.path, label: where, message: "is required" });
        } else {
          const bound = checkBounds(field, coerced.value);
          if (bound) errors.push({ field: field.path, label: where, message: bound });
          built = setField(built, sub, coerced.value);
        }
      }
      return built;
    });
    given.set(owner, items);
  }

  if (target.kind === "delete" || (target.kind === "action" && fields.length === 0)) {
    return { body: undefined, errors, notSent: [], rows: [] };
  }

  let body: Record<string, unknown> = {};
  const notSent: string[] = [];
  const rows: DiffRow[] = [];

  for (const field of settable(fields)) {
    if (isArrayItem(field) || owners.has(field.path)) continue;
    const current = before === null || before === undefined ? undefined : currentValue(field, before);
    const change = given.get(field.path);
    const has = given.has(field.path);
    let value: unknown;
    if (has) value = change;
    else if (mode === "replace" && current !== undefined && current !== null) value = current;
    else if (mode === "replace" && current === null && field.nullable) value = null;

    const missing = value === undefined || emptyText(value);
    if (field.required && missing && mode !== "merge") {
      errors.push({
        field: field.path,
        label: labelOf(field),
        message:
          mode === "replace" && field.readFrom === null
            ? "is required, and its current value could not be read — enter it"
            : "is required",
      });
    }
    if (mode === "replace" && !has && field.readFrom === null && !field.required) {
      notSent.push(labelOf(field));
    }
    if (value !== undefined) body = setField(body, field.path, value);

    const beforeText = display(current);
    const afterText = display(value);
    if (has || (mode !== "create" && value !== undefined)) {
      rows.push({
        field: field.path,
        label: labelOf(field),
        before: mode === "create" ? null : beforeText,
        after: afterText,
        changed: mode === "create" ? afterText !== null : has && beforeText !== afterText,
      });
    }
  }
  for (const owner of owners) {
    if (!given.has(owner)) continue;
    body = setField(body, owner, given.get(owner));
    const items = given.get(owner) as unknown[];
    rows.push({
      field: owner,
      label: humanLabel(owner),
      before: null,
      after: `${items.length} item${items.length === 1 ? "" : "s"}`,
      changed: items.length > 0,
    });
  }

  return { body, errors, notSent, rows };
};
