import type { HighlightSpec, ResourceSpec, WidgetSpec } from "@freebirdai/dash-spec";
import { isFieldNoise, parseWidget } from "@freebirdai/dash-spec";
import type { FieldInfo, InferredShape } from "./infer.js";
import type { Ambiguity } from "./propose.js";

/**
 * The pieces a widget is assembled from, wherever the decisions came from.
 *
 * What survived the roster. This file used to author whole widgets by rule — a
 * parallel way to make one, competing with the builder and with the chat, and
 * offering a board of ready-made widgets the model reached for instead of
 * answering what was asked. That is gone; widgets are now decided once, from
 * the record types, and compiled.
 *
 * These are the mechanical parts that were never about *choosing* anything:
 * turning an endpoint title into a noun, spotting which columns are worth
 * marking, flattening a dotted name into one a pipeline can bind, and building
 * a pane. Every one is universal — shape, English, or a statistic from a real
 * sample — and none of them knows any vendor.
 */

export interface AuthoredWidget {
  readonly id: string;
  /** Who wrote it. The build path does not care, but the UI can say. */
  readonly source: "model" | "rule" | "chat";
  readonly widget: WidgetSpec;
  /** One sentence, in the register a person would use. */
  readonly headline: string;
  /** The evidence, one clause each, so the offer can be judged not just read. */
  readonly why: readonly string[];
  /** Questions worth asking before this is trusted. */
  readonly confirm: readonly Ambiguity[];
  /** Mirrors the repo's posture: the URL said so, versus a name suggested it. */
  readonly confidence: "declared" | "inferred";
  readonly cost: {
    /** Requests to render it as it sits on the dashboard. */
    readonly requests: number;
    /** Extra requests once a row is opened. */
    readonly onOpen: number;
  };
  /** Higher sorts first. Ranking is total, so the order is reproducible. */
  readonly score: number;
}

/* ── English, not vocabulary ───────────────────────────────────────────── */

const VERBS =
  /^(get|retrieve|list|fetch|find|search|show|return|read|query|lookup|look up)\s+/i;
// The trailing `$` matters: "Retrieve all" strips to "all", and an article on
// its own is not a noun — it has to reduce to nothing so the caller falls back.
const ARTICLES = /^(all|the|a|an|my|your)(\s+|$)/i;

/**
 * The noun in an endpoint's title: "Retrieve all leases" → "leases".
 *
 * Titles in the wild are verb phrases, and a headline built from one reads
 * like a machine wrote it. Stripping a leading retrieval verb is the same
 * class of universal English rule as singularising a path segment — it knows
 * nothing about any particular API.
 */
export const nounFromTitle = (title: string): string | undefined => {
  let text = title.trim();
  for (let i = 0; i < 3; i++) {
    const stripped = text.replace(VERBS, "").replace(ARTICLES, "");
    if (stripped === text) break;
    text = stripped;
  }
  // A trailing qualifier is noise in a headline: "leases by status" → "leases".
  // "Comments on a post" → "comments". A relationship phrase is context the
  // headline already supplies, and leaving it in produces "the comments on a
  // post within them".
  text = text.replace(/\s+(by|for|with|in|of|on|from|at)\s+.*$/i, "").replace(/\s*\(.*\)\s*$/, "");
  text = text.trim().toLowerCase();
  if (text === "" || text.split(/\s+/).length > 3) return undefined;
  return text;
};

/** The plural a headline should use for a resource. */
const pluralFor = (resource: ResourceSpec, title: string): string =>
  nounFromTitle(title) ?? resource.id.replace(/-/g, " ");

/* ── highlight candidates ──────────────────────────────────────────────── */

/**
 * Fields worth drawing attention to, most confident first.
 *
 * Candidacy is a **shape** — a boolean flag, or a column with a small closed
 * set of values — and the tone is only a hint layered on top. That ordering
 * matters: gating candidacy on recognised words would suppress most of what
 * people actually want marked, because a status vocabulary cannot contain
 * every domain's words. `listed`, `vacant` and `delinquent` are all unknown to
 * it, and all three are exactly the kind of thing someone wants to see.
 *
 * `toneOf` is injected so the single existing status vocabulary stays the only
 * definition of it, without this package depending on the component library.
 */
export const highlightCandidates = (
  fields: readonly FieldInfo[],
  toneOf: (value: unknown) => HighlightSpec["tone"],
  options: {
    /** How many rows were scanned. A closed set needs repetition to show. */
    readonly rowCount?: number;
    /** Identity and label columns, which are never statuses. */
    readonly exclude?: readonly string[];
  } = {},
): Array<{ highlight: HighlightSpec; confident: boolean }> => {
  const found: Array<{ highlight: HighlightSpec; confident: boolean }> = [];
  const excluded = new Set(options.exclude ?? []);

  for (const field of fields) {
    if (field.name.includes(".")) continue;
    // A record's id and its name are what it *is*, not what state it is in.
    if (excluded.has(field.name)) continue;
    const slug = field.name.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);

    // A boolean named as a flag: `isListed`, `hasBalance`, `active`.
    if (field.kinds.length === 1 && field.kinds[0] === "boolean") {
      found.push({
        confident: true,
        highlight: {
          id: `${slug}-true`,
          when: `${field.name} == true`,
          tone: toneOf(true),
          label: humanFlag(field.name),
          scope: "row",
        },
      });
      continue;
    }

    /*
     * A small closed set of words. Anything larger is an identifier or free
     * text, and highlighting one arbitrary value of it says nothing.
     *
     * `distinct < rowCount` is the part that matters: a column where every row
     * holds a different value is not a status, it is a name. Without it, a
     * two-row sample makes every column look like a closed set — which is
     * exactly how "Ada" ended up offered as something to highlight.
     */
    if (!field.kinds.includes("string") || field.distinct > 12 || field.distinct < 2) continue;
    if (options.rowCount !== undefined && field.distinct >= options.rowCount) continue;
    /*
     * A recognised format means the column holds data, not a state — a
     * timestamp, an address, a link. `detectFormat` already worked this out
     * while sampling, so there is no need to guess it again here.
     */
    if (field.format) continue;

    for (const sample of field.samples) {
      if (typeof sample !== "string" || sample === "" || sample.length > 40) continue;
      // A state is a word. Anything digit-heavy or punctuated like a contact
      // detail is an identifier that happened to repeat in a small sample —
      // a phone number offered as something to "highlight" is the tell.
      if (!looksLikeAState(sample)) continue;
      const tone = toneOf(sample);
      found.push({
        confident: tone !== "neutral",
        highlight: {
          id: `${slug}-${sample.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20)}`.slice(0, 64),
          when: `lower(${field.name}) == ${JSON.stringify(sample.toLowerCase())}`,
          tone,
          label: sample,
          scope: "row",
        },
      });
    }
  }

  // Recognised words first: the vocabulary is a good ranker even though it is
  // a poor gate.
  return found.sort((a, b) => Number(b.confident) - Number(a.confident));
};

/**
 * Could this value name a state?
 *
 * A shape test on the value itself, not a vocabulary: states are words —
 * `listed`, `overdue`, `In Progress`. Phone numbers, emails, codes and
 * addresses are not, and in a small sample they are just as low-cardinality,
 * which is how "(559) 617-7966" ended up being offered as a highlight.
 */
const looksLikeAState = (value: string): boolean => {
  const letters = (value.match(/[a-z]/gi) ?? []).length;
  const digits = (value.match(/\d/g) ?? []).length;
  if (letters < 2) return false;
  // A stray digit is fine (`Tier 1`); mostly digits is not.
  if (digits > letters) return false;
  // Punctuation that belongs to contact details and codes, never to a state.
  return !/[@()+#/\\]/.test(value);
};

/** `crates` → `Crates`, for a widget title rather than a sentence. */
const titleCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A column worth counting by.
 *
 * The same shape test a highlight uses — a small set of values that repeat —
 * because the question is the same one: which of these columns describes a
 * state rather than identifying a record?
 */
const groupable = (
  fields: readonly FieldInfo[],
  resource: ResourceSpec,
  rowCount: number,
): string | undefined => {
  const skip = new Set([resource.idField, resource.labelField].filter(Boolean) as string[]);
  for (const field of fields) {
    if (field.name.includes(".") || skip.has(field.name) || field.format) continue;
    if (field.kinds.length === 1 && field.kinds[0] === "boolean") return field.name;
    if (!field.kinds.includes("string")) continue;
    if (field.distinct < 2 || field.distinct > 12 || field.distinct >= rowCount) continue;
    if (field.samples.some((value) => typeof value === "string" && !looksLikeAState(value))) continue;
    return field.name;
  }
  return undefined;
};

/**
 * A column that holds a time, so rows can be ordered newest first.
 *
 * Read from the format `inferShape` detected rather than from the name: a
 * field called `updated` that holds a string nobody can parse is not a date,
 * and ordering by it would silently produce nonsense.
 */
const newestFirst = (fields: readonly FieldInfo[]): string | undefined =>
  fields.find(
    (field) =>
      !field.name.includes(".") &&
      (field.format === "iso8601" ||
        field.format === "unix_seconds" ||
        field.format === "unix_millis"),
  )?.name;

/** `isListed` → `Listed`; `hasBalance` → `Balance`. */
const humanFlag = (name: string): string => {
  const stripped = name.replace(/^(is|has|can|should)/i, "");
  const words = (stripped || name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * `Address.City` → `Address_City`.
 *
 * A pipeline field name cannot contain a dot (`fieldNameSchema`), and a row
 * has a nested `Address` object rather than a flat `Address.City` key — so a
 * role pointing at the dotted name binds to a column that does not exist and
 * the widget fails validation outright. The fix is the same `derive` step
 * `mapProposal` already emits; the expression lexer reads a dotted identifier
 * as one field reference, so `Address_City: "Address.City"` reaches inside.
 */
const flatName = (name: string): string => name.replace(/\./g, "_");

/** The derive step a set of role columns needs, plus the names to bind. */
export const flatten = (
  names: readonly string[],
): { readonly bound: string[]; readonly derive: Record<string, string> } => {
  const derive: Record<string, string> = {};
  const bound = names.map((name) => {
    if (!name.includes(".")) return name;
    const flat = flatName(name);
    derive[flat] = name;
    return flat;
  });
  return { bound, derive };
};

/** A drill-down or related pane, with its own dotted names flattened. */
export const pane = (input: {
  op: string;
  params: Record<string, string>;
  component: string;
  role: "fields" | "columns";
  names: readonly string[];
  title?: string;
  related?: unknown[];
  /**
   * The identity block at the top of a record.
   *
   * Its fields are deliberately NOT in `names`: they are drawn in the heading
   * instead of the body, and binding them to `fields` as well would put every
   * one of them on screen twice. They still have to be *derived* though — a
   * nested name only becomes a real column because the pipeline makes it one
   * — so they are flattened here alongside everything else.
   */
  header?: {
    title?: string;
    subtitle?: string;
    status?: string;
    facts?: readonly string[];
  };
  /** Named sections over `names`. Anything ungrouped renders after them. */
  groups?: ReadonlyArray<{ title: string; fields: readonly string[] }>;
  /**
   * Keep only the rows belonging to the record this pane was opened from.
   *
   * The other half of the same contract `params` serves. A section under a
   * record shows that record's children — sometimes the endpoint can be asked
   * for them, and sometimes it can only be asked for all of them. Which one
   * applies is a property of the endpoint, not of the relationship, so the
   * caller decides and the pane honours it either way.
   */
  matchOn?: {
    field: string;
    parentIdField: string;
    rowsPath?: string;
    /**
     * Whether the field holds one id or a list of them.
     *
     * `PropertyIds: [42, 51]` is as ordinary a foreign key as `PropertyId: 42`
     * and needs a different comparison: the list never equals an id, so the
     * scalar test is false for every row and the section renders permanently
     * empty — which reads as a record that simply has no children.
     */
    kind?: "scalar" | "array";
  };
}): Record<string, unknown> => {
  const { bound, derive } = flatten(input.names);

  /*
   * Heading and section names go through the same flattening as the body.
   *
   * They must, and for one reason: `Category.Name` is not a column until the
   * derive step makes it one, so a heading naming the dotted form would bind
   * to nothing and render blank. Merging the derives here is what keeps the
   * two halves of the record speaking about the same columns.
   */
  const headingNames = input.header
    ? [
        input.header.title,
        input.header.subtitle,
        input.header.status,
        ...(input.header.facts ?? []),
      ].filter((name): name is string => Boolean(name))
    : [];
  const heading = flatten(headingNames);
  const flatOf = new Map(headingNames.map((name, index) => [name, heading.bound[index]!]));
  Object.assign(derive, heading.derive);

  const groupNames = (input.groups ?? []).flatMap((group) => group.fields);
  const grouped = flatten(groupNames);
  const groupFlat = new Map(groupNames.map((name, index) => [name, grouped.bound[index]!]));
  Object.assign(derive, grouped.derive);

  /*
   * `string()` on both sides because `==` is strict and the same id arrives
   * typed differently across endpoints — a number in the collection, a string
   * in the token. Comparing them raw silently matches nothing.
   */
  const match = input.matchOn
    ? [
        {
          op: "filter",
          where:
            input.matchOn.kind === "array"
              ? // Same comparison, across a list. `includesId` coerces for the
                // same reason `string()` does above.
                `includesId(${input.matchOn.field}, "{{row.${input.matchOn.parentIdField}}}")`
              : `string(${input.matchOn.field}) == "{{row.${input.matchOn.parentIdField}}}"`,
        },
      ]
    : [];

  // A collection needs its rows extracted before they can be filtered; a
  // detail response is a single object, so its extract stays at `$` and the
  // derive is what makes a nested field bindable.
  const extract =
    input.matchOn || Object.keys(derive).length > 0
      ? [{ op: "extract", path: input.matchOn?.rowsPath ?? "$" }]
      : [];

  return {
    op: input.op,
    params: input.params,
    component: input.component,
    ...(input.title ? { title: input.title } : {}),
    pipeline: [
      ...extract,
      ...(Object.keys(derive).length > 0 ? [{ op: "derive", fields: derive }] : []),
      ...match,
    ],
    roles: { [input.role]: bound },
    ...(input.header
      ? {
          header: {
            ...(input.header.title ? { title: flatOf.get(input.header.title) } : {}),
            ...(input.header.subtitle ? { subtitle: flatOf.get(input.header.subtitle) } : {}),
            ...(input.header.status ? { status: flatOf.get(input.header.status) } : {}),
            facts: (input.header.facts ?? []).map((name) => flatOf.get(name) ?? name),
          },
        }
      : {}),
    ...(input.groups && input.groups.length > 0
      ? {
          groups: input.groups.map((group) => ({
            title: group.title,
            fields: group.fields.map((name) => groupFlat.get(name) ?? name),
          })),
        }
      : {}),
    ...(input.related ? { related: input.related } : {}),
  };
};
