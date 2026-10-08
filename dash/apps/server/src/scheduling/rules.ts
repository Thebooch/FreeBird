import { passes, type FieldRule, type RuleSet } from "@freebirdai/dash-spec";

/**
 * Who may book: a block's rules over a contact's facts.
 *
 * Three answers, not two. A rule over a field nobody knows yet is neither met
 * nor broken, it is **unknown**, and the block says what unknown means
 * (`whenUnknown`): left out, let in, or let in pending a person's approval.
 * The fields that were missing come back with the answer, so the booking
 * flow can ask for exactly those (`discover`).
 *
 * A rule marked `trusted` counts only a value from a matched record or a
 * member: what a person said about themselves is unknown to it. Values are
 * compared by their kind: text case-folded, phones by digits, addresses
 * normalized ("123 N. Main St." is "123 north main street").
 */

export const FACT_KINDS = ["text", "choice", "address", "email", "phone", "number", "date", "boolean"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Facts {
  /** `{ contact: {...fields, stats: {...}}, request: {...}, type: {...} }`. */
  readonly scope: Readonly<Record<string, unknown>>;
  /** Paths whose value came from a matched record or a member. A path counts when it or one above it is here. */
  readonly trusted: ReadonlySet<string>;
  /** Each field's kind, by path, from its definition. Absent: text. */
  readonly kinds?: ReadonlyMap<string, FactKind>;
}

export type Verdict = "eligible" | "ineligible" | "unknown";

export interface RuleResult {
  readonly verdict: Verdict;
  /** Fields that had no value. */
  readonly missing: readonly string[];
  /** Fields whose only value was one the person gave, where a rule wanted a trusted one. */
  readonly untrusted: readonly string[];
}

/** The value at a dotted path. */
export const valueAt = (scope: unknown, path: string): unknown => {
  let at: unknown = scope;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
};

const blank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);

const isTrusted = (facts: Facts, path: string): boolean => {
  const parts = path.split(".");
  for (let n = parts.length; n >= 2; n--) if (facts.trusted.has(parts.slice(0, n).join("."))) return true;
  return false;
};

/* ── normalizing ───────────────────────────────────────────────────────── */

const SUFFIXES: Readonly<Record<string, string>> = {
  st: "street", str: "street", ave: "avenue", av: "avenue", rd: "road", blvd: "boulevard", dr: "drive", ln: "lane", ct: "court",
  pl: "place", sq: "square", ter: "terrace", pkwy: "parkway", hwy: "highway", cir: "circle", trl: "trail", ste: "suite", apt: "unit",
  "#": "unit", n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest", mt: "mount",
};

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/#/g, " # ")
    .replace(/[.,;:()'"/\\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** An address line in one canonical form: lower case, no punctuation, common abbreviations written out. */
export const normalizeAddress = (value: string): string =>
  words(value)
    .map((word) => SUFFIXES[word] ?? word)
    .join(" ");

/**
 * The forms an address can be matched by. An address may be a line of text
 * or `{ line1, line2, city, region, postalCode }`: "123 Main St" matches it,
 * and so does "123 Main St, 78701".
 */
export const addressForms = (value: unknown): string[] => {
  if (typeof value === "string") return [normalizeAddress(value)].filter(Boolean);
  if (!value || typeof value !== "object") return [];
  const one = value as Record<string, unknown>;
  const text = (key: string) => (typeof one[key] === "string" || typeof one[key] === "number" ? String(one[key]) : "");
  const line = normalizeAddress([text("line1"), text("line2")].filter(Boolean).join(" "));
  const postal = normalizeAddress(text("postalCode"));
  const city = normalizeAddress(text("city"));
  const region = normalizeAddress(text("region"));
  const forms = [line, `${line} ${postal}`, `${line} ${city}`, `${line} ${city} ${region}`, `${line} ${city} ${region} ${postal}`, `${line} ${city} ${postal}`];
  return [...new Set(forms.map((form) => form.replace(/\s+/g, " ").trim()).filter(Boolean))];
};

const phone = (value: unknown): string => String(value).replace(/[^\d+]/g, "").replace(/^00/, "+");

/** A fact as one comparable string, by its kind: what consolidation and stacking compare. */
export const normalizeFact = (value: unknown, kind: FactKind = "text"): string | undefined => {
  if (blank(value)) return undefined;
  switch (kind) {
    case "address":
      return addressForms(value).at(-1);
    case "phone":
      return phone(value);
    case "email":
      return String(value).trim().toLowerCase();
    case "number":
      return Number.isFinite(Number(value)) ? String(Number(value)) : undefined;
    case "boolean":
      return String(value === true || value === "true" || value === "yes");
    default:
      return typeof value === "object" ? JSON.stringify(value) : words(String(value)).join(" ");
  }
};

/** A fact at a path, normalized by its kind, or nothing when it is not known. */
export const factString = (facts: Facts, path: string): string | undefined => normalizeFact(valueAt(facts.scope, path), facts.kinds?.get(path) ?? kindFromParent(facts, path));

const kindFromParent = (facts: Facts, path: string): FactKind | undefined => {
  const parent = path.slice(0, path.lastIndexOf("."));
  return facts.kinds?.get(parent) === "address" ? "text" : undefined;
};

/* ── one rule ──────────────────────────────────────────────────────────── */

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const asDate = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(asDate)) return asDate;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** One rule: true, false, or null when its field is not known (or not trusted). */
const ruleHolds = (rule: FieldRule, facts: Facts): boolean | null => {
  const value = valueAt(facts.scope, rule.field);
  if (rule.op === "missing") return blank(value);
  if (rule.op === "exists") return blank(value) ? null : true;
  if (blank(value)) return null;

  const kind = facts.kinds?.get(rule.field) ?? "text";
  const values = rule.values;
  const forms: string[] =
    kind === "address" ? addressForms(value) : Array.isArray(value) ? value.map((one) => normalizeFact(one, kind) ?? "") : [normalizeFact(value, kind) ?? ""];
  const wanted = values.map((one) => (kind === "address" ? normalizeAddress(String(one)) : (normalizeFact(one, kind) ?? "")));

  switch (rule.op) {
    case "in":
    case "equals":
      return forms.some((form) => wanted.includes(form));
    case "not_in":
    case "not_equals":
      return !forms.some((form) => wanted.includes(form));
    case "starts_with":
      return forms.some((form) => wanted.some((prefix) => prefix !== "" && form.startsWith(prefix)));
    case "contains":
      return forms.some((form) => wanted.some((part) => part !== "" && form.includes(part)));
    case "gte":
    case "lte":
    case "between": {
      const n = asNumber(value);
      const bounds = values.map(asNumber);
      if (n === null || bounds.some((bound) => bound === null)) return false;
      if (rule.op === "gte") return n >= bounds[0]!;
      if (rule.op === "lte") return n <= bounds[0]!;
      return n >= bounds[0]! && n <= (bounds[1] ?? bounds[0]!);
    }
  }
};

/* ── a rule set ────────────────────────────────────────────────────────── */

/**
 * A block's rules over the facts: `all` must each hold, at least one of
 * `any` must (when there are any), and the expression must pass. Unknown
 * spreads as it should: a false anywhere in `all` is false whatever else is
 * unknown; one true in `any` is enough.
 */
export const evaluateRules = (rules: RuleSet | undefined, facts: Facts, now: number): RuleResult => {
  if (!rules) return { verdict: "eligible", missing: [], untrusted: [] };
  const missing = new Set<string>();
  const untrusted = new Set<string>();
  const check = (rule: FieldRule): boolean | null => {
    if (rule.trusted && rule.op !== "missing" && !blank(valueAt(facts.scope, rule.field)) && !isTrusted(facts, rule.field)) {
      untrusted.add(rule.field);
      return null;
    }
    const held = ruleHolds(rule, facts);
    if (held === null) missing.add(rule.field);
    return held;
  };

  const all = rules.all.map(check);
  const allVerdict: boolean | null = all.includes(false) ? false : all.includes(null) ? null : true;
  const any = rules.any.map(check);
  const anyVerdict: boolean | null = any.length === 0 ? true : any.includes(true) ? true : any.includes(null) ? null : false;
  let expression: boolean | null = true;
  if (rules.expression?.trim()) {
    try {
      expression = passes(rules.expression, facts.scope, now);
    } catch {
      expression = false;
    }
  }
  const parts = [allVerdict, anyVerdict, expression];
  const verdict: Verdict = parts.includes(false) ? "ineligible" : parts.includes(null) ? "unknown" : "eligible";
  return { verdict, missing: verdict === "unknown" ? [...missing] : [], untrusted: verdict === "unknown" ? [...untrusted] : [] };
};

/** The paths a rule set reads, for discovery and for the rule builder. */
export const pathsOf = (rules: RuleSet | undefined): string[] => (rules ? [...new Set([...rules.all, ...rules.any].map((rule) => rule.field))] : []);
