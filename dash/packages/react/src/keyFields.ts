import type { SemanticType, ValueType } from "@freebirdai/dash-spec";

/**
 * Which fields of a record a person reads first.
 *
 * Used where nothing says: a record type whose fields were never marked
 * primary, and the list behind a number, which has only the columns its rows
 * carry. The record type's own choice always wins where it made one; this is
 * the fallback that keeps the top of a record from being either empty or
 * every field the API sends.
 *
 * Ranked in tiers, page order kept within each:
 * 0. what names the record — its title, its status, its facts;
 * 1. readable values — names, dates, money, statuses, contact details;
 * 2. everything else that is not plumbing;
 * 3. plumbing — ids, flags, codes, and who-changed-it-when.
 */
export interface FieldCandidate {
  /** What the caller calls it: a field path or a column name. */
  readonly key: string;
  readonly semantic?: SemanticType | undefined;
  readonly valueType?: ValueType | undefined;
}

export interface KeyFieldHints {
  /** The fields that name the record, in order. */
  readonly title?: readonly string[];
  readonly status?: string | undefined;
  readonly facts?: readonly string[];
  /** The record's own id. Never a key field: nobody reads it. */
  readonly identity?: string | undefined;
}

/** About as many as fit above the fold of a drawer. */
export const KEY_FIELD_CAP = 10;

/** The last level of a path, which is what its name says about it. */
const leaf = (key: string): string => key.split(/[._]/).filter(Boolean).pop() ?? key;

/** `CreatedAt`, `ModifiedBy`, `updated_on`, `LastModifiedDate`, `created_by_user_id`. */
const AUDIT = /(^|[._])(created|modified|updated|last_?modified|deleted)(_?(at|by|on|date|time|date_?time|user(_?id)?|by_?user(_?id)?))?$/i;
const AUDIT_CAMEL = /(Created|Modified|Updated|Deleted)(At|By|On|Date|Time|DateTime|User|UserId|ByUserId|ById)?$/;
/** `Id`, `VendorID`, `vendor_id`, `uuid`, `guid`. */
const ID = /(^|[a-z0-9_.])(id|ids|uuid|guid)$|(Id|ID|Ids|IDs|Uuid|UUID|Guid|GUID)$/;
/** `TaxCode`, `country_code`, `Ref`, `Key`, `Hash`, `Version`, `ETag`. */
const CODE = /(Code|_code|Ref|_ref|Key|_key|Hash|_hash|Version|_version|ETag|etag|Token|_token)$/;
const NAMEY = /(name|title|subject|label|email|phone|mobile|address|street|city|state|zip|postal|description|summary|amount|total|balance|price|rent|date|due|status|stage|type|category)/i;

const READABLE: ReadonlySet<SemanticType> = new Set<SemanticType>([
  "currency",
  "timestamp",
  "status_enum",
  "text",
  "url",
  "percent",
  "count",
  "duration",
]);

export const isPlumbing = (candidate: FieldCandidate): boolean => {
  const { key, semantic, valueType } = candidate;
  if (key === "_all") return true;
  if (semantic === "identifier" || semantic === "boolean" || valueType === "boolean") return true;
  const name = leaf(key);
  if (AUDIT.test(key) || AUDIT_CAMEL.test(key)) return true;
  if (ID.test(key) || ID.test(name)) return true;
  if (CODE.test(key)) return true;
  return false;
};

const tierOf = (candidate: FieldCandidate): number => {
  if (isPlumbing(candidate)) return 3;
  if (candidate.semantic && READABLE.has(candidate.semantic)) return 1;
  if (NAMEY.test(leaf(candidate.key))) return 1;
  if (candidate.valueType === "temporal" || candidate.valueType === "categorical") return 1;
  return 2;
};

/**
 * The fields to show first, best first, at most `cap`.
 *
 * Plumbing comes in only when nothing else is left, so a record of nothing
 * but ids still shows something rather than an empty top.
 */
export const rankKeyFields = (
  candidates: readonly FieldCandidate[],
  hints: KeyFieldHints = {},
  cap: number = KEY_FIELD_CAP,
): string[] => {
  const known = new Set(candidates.map((candidate) => candidate.key));
  const picked: string[] = [];
  const take = (key: string | undefined): void => {
    if (key === undefined || !known.has(key) || picked.includes(key)) return;
    if (key === hints.identity) return;
    picked.push(key);
  };

  for (const key of hints.title ?? []) take(key);
  take(hints.status);
  for (const key of hints.facts ?? []) take(key);

  const rest = candidates
    .map((candidate, index) => ({ candidate, index, tier: tierOf(candidate) }))
    .filter(({ candidate }) => !picked.includes(candidate.key) && candidate.key !== hints.identity)
    .sort((a, b) => a.tier - b.tier || a.index - b.index);

  const readable = rest.filter((entry) => entry.tier < 3);
  for (const entry of readable) take(entry.candidate.key);
  if (picked.length === 0) for (const entry of rest) take(entry.candidate.key);

  return picked.slice(0, cap);
};
