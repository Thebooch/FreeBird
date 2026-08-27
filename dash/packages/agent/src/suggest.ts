import type { HighlightSpec, ResourceSpec, WidgetSpec } from "@freebirdai/dash-spec";
import { parseWidget } from "@freebirdai/dash-spec";
import type { FieldInfo, InferredShape } from "./infer.js";
import type { Ambiguity } from "./propose.js";

/**
 * Widgets proposed by rule rather than by model.
 *
 * The deterministic twin of `proposeWidget`. Both authors produce the same
 * object — a real spec, a sentence explaining it, and the questions still worth
 * asking — and both feed the same preview-then-approve loop. A chat turn later
 * becomes a third author of the same thing, which is the whole reason the
 * shape is shared rather than each surface having its own.
 *
 * Nothing here knows any vendor. Every rule reads shape (a resource with a
 * child collection), universal naming convention (a field called `isListed`),
 * or a statistic from a real sample (a column with four distinct values).
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

/* ── the suggestions ───────────────────────────────────────────────────── */

export interface SuggestInput {
  readonly connection: string;
  readonly resources: readonly ResourceSpec[];
  /** Per resource id, from the sampling pass that produced the report. */
  readonly shapes: Readonly<Record<string, InferredShape>>;
  /** Titles for the record and its children, keyed by resource id. */
  readonly toneOf: (value: unknown) => HighlightSpec["tone"];
}

const KIND_SCORE: Readonly<Record<string, number>> = {
  parentChild: 50,
  breakdown: 30,
  recent: 25,
  collection: 20,
};

/**
 * Everything worth building on this connection, ranked.
 *
 * Pure: no model, no network, no clock. The same input always produces the
 * same array in the same order, which is what makes it testable and what makes
 * a suggestion list stable enough for someone to scroll.
 */
export const suggestWidgets = (input: SuggestInput): AuthoredWidget[] => {
  const authored: AuthoredWidget[] = [];

  /*
   * Resources that only exist inside another record.
   *
   * Their collection endpoint carries a parent's id in its path, so it cannot
   * be called on its own — offering one as a standalone list would produce a
   * widget that can never load. They appear as sections of their parent
   * instead, which is where they belong anyway.
   */
  const scoped = new Set(
    input.resources.flatMap((resource) =>
      (resource.relations ?? [])
        .filter((relation) => relation.via === "path")
        .map((relation) => relation.resource),
    ),
  );

  for (const resource of input.resources) {
    const shape = input.shapes[resource.id];
    if (!resource.listOp || !shape || shape.fields.length === 0) continue;

    const plural = pluralFor(resource, resource.title);
    const columns = pickColumns(resource, shape.fields);
    if (columns.length === 0) continue;

    const candidates = highlightCandidates(shape.fields, input.toneOf, {
      rowCount: shape.rowCount,
      exclude: [resource.idField, resource.labelField].filter(
        (name): name is string => typeof name === "string",
      ),
    });
    const best = candidates[0];
    const highlights = best ? [best.highlight] : [];
    const confirm: Ambiguity[] =
      best && !best.confident
        ? [
            {
              field: best.highlight.label,
              question: `Should “${best.highlight.label}” be highlighted, and how urgent is it?`,
              options: ["Good", "Needs attention", "Urgent", "Don't highlight"],
            },
          ]
        : [];

    /*
     * Any way of reaching the children, not just a nested URL.
     *
     * This used to require `via === "path"`, which quietly meant only APIs
     * that nest a child under its parent in the URL ever got a drill-down.
     * The equally common shape — a top-level collection filtered by the
     * parent's id — was known about and still never offered. A parent with
     * children is one structure; how the child is fetched is a detail of the
     * request.
     *
     * Either half of that detail will do: a parameter the endpoint takes, or a
     * column on the child's rows to match against. Requiring `param` meant a
     * child whose endpoint declares no filter at all was dropped, even with
     * the linking column verified.
     *
     * `fanOut` stays out: one request per row is a different cost class and
     * belongs behind an explicit choice, not a suggestion.
     */
    const children = (resource.relations ?? []).filter(
      (relation) =>
        relation.cardinality === "many" &&
        (relation.via === "path" || relation.via === "filter") &&
        relation.op &&
        (relation.param || relation.foreignField),
    );

    /*
     * The headline case: a record and the collections inside it. This is what
     * makes a drill-down worth clicking — the parent is often an identifier
     * and a name, and everything interesting lives one hop out.
     */
    if (children.length > 0 && resource.idField && resource.detailOp && resource.detailParam) {
      // Pinned outside the closures below, which lose the narrowing above.
      const parentIdField = resource.idField;
      const unsampled: string[] = [];
      /*
       * Cap the sections that can be *built*, not the candidates considered.
       *
       * The cap used to be a `slice(0, 4)` here, before the check below knows
       * whether a child can be bound at all — so on an API where a parent
       * declares a dozen children, four unread ones would fill the quota and
       * the one whose columns are actually known never got a look. A learned
       * link is appended after the declared ones, which put it last in exactly
       * the case it matters most.
       */
      const related = children.flatMap((relation) => {
        const child = input.resources.find((item) => item.id === relation.resource);
        const childShape = input.shapes[relation.resource];
        if (!relation.op) return [];

        /*
         * A child nobody has sampled cannot be bound: every component needs at
         * least one role filled, and we do not know a single column name yet.
         * It is skipped — but the caller is told, because a drill-down that
         * silently opens with nothing underneath it is exactly the failure
         * this whole feature exists to fix.
         */
        const columns = child && childShape ? pickColumns(child, childShape.fields) : [];
        if (columns.length === 0) {
          unsampled.push(relation.title);
          return [];
        }

        return [
          {
            ...pane({
              op: relation.op,
              // Ask the endpoint when it can be asked; otherwise take the
              // collection and keep the rows that point back here.
              params: relation.param
                ? { [relation.param]: `{{row.${resource.idField}}}` }
                : {},
              ...(relation.param || !relation.foreignField
                ? {}
                : {
                    matchOn: {
                      field: relation.foreignField,
                      parentIdField,
                      rowsPath: childShape?.rowsPath,
                    },
                  }),
              // A has-one child is a record, not a one-row table.
              component: relation.cardinality === "many" ? "table" : "record",
              role: relation.cardinality === "many" ? "columns" : "fields",
              names: columns,
            }),
            id: relation.id,
            title: relation.title,
          },
        ];
      }).slice(0, 4);

      const built = build({
        id: `${resource.id}-with-children`,
        title: resource.title,
        connection: input.connection,
        op: resource.listOp,
        rowsPath: shape.rowsPath,
        columns,
        highlights,
        drilldown: pane({
          op: resource.detailOp,
          params: { [resource.detailParam]: `{{row.${resource.idField}}}` },
          component: "record",
          role: "fields",
          names: allFields(shape.fields),
          title: resource.title,
          related,
        }),
      });

      if (built) {
        /*
         * The sentence describes what the widget actually contains, not what
         * the API declares. Those differ whenever a child could not be opened,
         * and promising "and the vendors within them" when no vendors section
         * was built is precisely the confident-but-wrong copy this product
         * cannot afford.
         */
        const includedNames = related.slice(0, 2).map((section) => {
          const relation = children.find((item) => item.id === section.id);
          const child = relation
            ? input.resources.find((item) => item.id === relation.resource)
            : undefined;
          return child ? pluralFor(child, section.title as string) : (section.title as string);
        });
        const included = children.filter((relation) =>
          related.some((section) => section.id === relation.id),
        );
        const declared =
          included.length > 0 && included.every((relation) => relation.confidence === "declared");
        authored.push({
          id: built.id,
          source: "rule",
          widget: built,
          headline: sentence(plural, includedNames, best?.highlight.label),
          why: [
            ...included.map((relation) => {
              const child = input.resources.find((item) => item.id === relation.resource);
              const noun = child ? pluralFor(child, relation.title) : relation.resource;
              return relation.confidence === "declared"
                ? `the API declares ${noun} in its own URL`
                : `${noun} appear to belong to each ${singular(plural)}`;
            }),
            ...(best
              ? [`“${best.highlight.label}” is one of a small set of values on these records`]
              : []),
            ...(unsampled.length > 0
              ? [
                  `${unsampled.length} other collection(s) could not be opened to see their fields, so they are left out`,
                ]
              : []),
          ],
          confirm,
          confidence: declared ? "declared" : "inferred",
          cost: { requests: 1, onOpen: 1 + related.length },
          score: KIND_SCORE.parentChild! + (declared ? 5 : 0) + (best?.confident ? 2 : 0),
        });
        continue;
      }
    }

    /* A plain list, which is still worth offering when nothing else fits. */
    if (scoped.has(resource.id)) continue;
    const built = build({
      id: `${resource.id}-list`,
      title: resource.title,
      connection: input.connection,
      op: resource.listOp,
      rowsPath: shape.rowsPath,
      columns,
      highlights,
      ...(resource.idField && resource.detailOp && resource.detailParam
        ? {
            drilldown: pane({
              op: resource.detailOp,
              params: { [resource.detailParam]: `{{row.${resource.idField}}}` },
              component: "record",
              role: "fields",
              names: allFields(shape.fields),
              title: resource.title,
              related: [],
            }),
          }
        : {}),
    });
    if (!built) continue;

    authored.push({
      id: built.id,
      source: "rule",
      widget: built,
      headline: sentence(plural, [], best?.highlight.label),
      why: [
        `${shape.rowCount} record(s) came back from this endpoint`,
        ...(best
          ? [`“${best.highlight.label}” is one of a small set of values on these records`]
          : []),
      ],
      confirm,
      confidence: "inferred",
      cost: { requests: 1, onOpen: built.drilldown ? 1 : 0 },
      score: KIND_SCORE.collection! + (best?.confident ? 2 : 0),
    });

    /*
     * How many of each, by whatever small closed set the records carry.
     *
     * The question a dashboard is usually opened to answer — "how is this
     * split up?" — and it needs nothing but a categorical column, which
     * sampling has already identified.
     */
    const grouped = groupable(shape.fields, resource, shape.rowCount);
    if (grouped) {
      const bar = countBy({
        id: `${resource.id}-by-${grouped.replace(/[^a-zA-Z0-9]/g, "-")}`.slice(0, 64),
        title: `${titleCase(plural)} by ${humanFlag(grouped)}`,
        connection: input.connection,
        op: resource.listOp,
        rowsPath: shape.rowsPath,
        field: grouped,
      });
      if (bar) {
        authored.push({
          id: bar.id,
          source: "rule",
          widget: bar,
          headline: `This widget will count your ${plural} by ${humanFlag(grouped).toLowerCase()}.`,
          why: [`${humanFlag(grouped)} holds a small set of repeating values`],
          confirm: [],
          confidence: "inferred",
          cost: { requests: 1, onOpen: 0 },
          score: KIND_SCORE.breakdown!,
        });
      }
    }

    /*
     * The newest ones first.
     *
     * Nearly every dashboard has a "what just happened" panel, and the only
     * thing it needs is a column that holds a time — which `inferShape`
     * already recognised while sampling.
     */
    const timeField = newestFirst(shape.fields);
    if (timeField) {
      const feed = build({
        id: `${resource.id}-recent`,
        title: `Recent ${plural}`,
        connection: input.connection,
        op: resource.listOp,
        rowsPath: shape.rowsPath,
        columns: [timeField, ...columns.filter((name) => name !== timeField)].slice(0, 5),
        highlights,
        sort: { field: timeField, dir: "desc" as const },
        limit: 20,
      });
      if (feed) {
        authored.push({
          id: feed.id,
          source: "rule",
          widget: feed,
          headline: `This widget will show the 20 most recent ${plural}, newest first.`,
          why: [`${humanFlag(timeField)} holds a time, so these can be ordered`],
          confirm: [],
          confidence: "inferred",
          cost: { requests: 1, onOpen: 0 },
          score: KIND_SCORE.recent!,
        });
      }
    }
  }

  /*
   * A total order, so the same input always yields the same list. Ties broken
   * by id rather than left to sort stability, which is what lets a test assert
   * the whole array.
   */
  return authored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};

const singular = (plural: string): string => (plural.endsWith("s") ? plural.slice(0, -1) : plural);

/** The owner's own sentence, assembled from data. */
const sentence = (plural: string, children: readonly string[], mark?: string): string => {
  const head =
    children.length > 0
      ? `This widget will show your ${plural} and the ${children.join(" and ")} within them`
      : `This widget will list your ${plural}`;
  return mark ? `${head}, and we'll highlight “${mark}”.` : `${head}.`;
};

/** Identity and label lead; nested parents are dropped for their children. */
export const pickColumns = (resource: ResourceSpec, fields: readonly FieldInfo[]): string[] => {
  const expanded = new Set(
    fields.filter((f) => f.name.includes(".")).map((f) => f.name.slice(0, f.name.indexOf("."))),
  );
  const lead = [resource.idField, resource.labelField].filter(
    (name): name is string => typeof name === "string",
  );
  return [
    ...lead,
    ...fields
      .map((field) => field.name)
      .filter((name) => !lead.includes(name) && !expanded.has(name) && !name.includes(".")),
  ].slice(0, 6);
};

/** Everything, flattened children included — a record sheet shows the lot. */
export const allFields = (fields: readonly FieldInfo[]): string[] => {
  const expanded = new Set(
    fields.filter((f) => f.name.includes(".")).map((f) => f.name.slice(0, f.name.indexOf("."))),
  );
  return fields.map((field) => field.name).filter((name) => !expanded.has(name));
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

/**
 * Parse rather than construct.
 *
 * A suggestion that cannot execute is worse than no suggestion, so anything
 * that fails to parse is dropped silently instead of being offered.
 */
export const build = (input: {
  id: string;
  title: string;
  connection: string;
  op: string;
  rowsPath: string;
  columns: readonly string[];
  highlights: readonly HighlightSpec[];
  drilldown?: unknown;
  sort?: { field: string; dir: "asc" | "desc" };
  limit?: number;
}): WidgetSpec | null => {
  const { bound, derive } = flatten(input.columns);
  const parsed = parseWidget({
    id: input.id,
    title: input.title,
    component: "table",
    source: { connection: input.connection, op: input.op, params: {} },
    pipeline: [
      { op: "extract", path: input.rowsPath },
      ...(Object.keys(derive).length > 0 ? [{ op: "derive", fields: derive }] : []),
      ...(input.sort ? [{ op: "sort", by: [input.sort] }] : []),
      ...(input.limit ? [{ op: "limit", count: input.limit }] : []),
    ],
    roles: { columns: bound },
    highlights: [...input.highlights],
    ...(input.drilldown ? { drilldown: input.drilldown } : {}),
  });
  return parsed.ok && parsed.value ? parsed.value : null;
};

/** How many records fall in each value of one column. */
const countBy = (input: {
  id: string;
  title: string;
  connection: string;
  op: string;
  rowsPath: string;
  field: string;
}): WidgetSpec | null => {
  const parsed = parseWidget({
    id: input.id,
    title: input.title,
    component: "bar",
    source: { connection: input.connection, op: input.op, params: {} },
    pipeline: [
      { op: "extract", path: input.rowsPath },
      { op: "group", by: [{ field: input.field }], agg: { total: "count()" } },
      { op: "sort", by: [{ field: "total", dir: "desc" }] },
      { op: "limit", count: 12 },
    ],
    roles: { category: input.field, value: "total" },
  });
  return parsed.ok && parsed.value ? parsed.value : null;
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
