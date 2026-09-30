import { z } from "zod";
import type { EntityKind, EntitySpec, WidgetBrief, WidgetIntent } from "@freebirdai/dash-spec";
import { facetsFromRecipe, ownFields, recipeFor } from "@freebirdai/dash-spec";
import type { LlmAdapter, LlmTool } from "./llm.js";
import { unitCarrier, unitCarriers } from "./units.js";

/**
 * Turning a request into a brief, over record types rather than endpoints.
 *
 * The replacement for hunting through an endpoint list. Choosing between two
 * hundred endpoints titled "Retrieve all X" is a job nobody can do well — the
 * model least of all — and it was never the question anybody was asking. The
 * question is which *records* they mean, and once an API has been described
 * that is a list of a hundred plain nouns with a sentence each.
 *
 * **The brief is small on purpose.** It names the record type, what the widget
 * is for, and only what the request actually asked for. Everything else — the
 * columns, the sort, the filter strips, the endpoint, the pipeline — comes
 * from the record type and its kind, deterministically, in `compileBrief`. So
 * the model is never asked to produce a pipeline it could get subtly wrong; it
 * produces a handful of names that are checked against the real thing.
 *
 * **Intent is the whole of the fix.** Asked for records "with a filter by
 * category", the old flow built a chart of counts per category, because a
 * grouping was the only vocabulary it had for "by category". Here, wanting to
 * *see* records and wanting to *count* them across something are different
 * answers to a question the model is asked outright, and the prompt spends
 * most of its length on that one distinction because it is the one that was
 * being got wrong.
 */

/** A field worth naming in a brief. */
export interface BriefField {
  readonly path: string;
  readonly label: string;
  /**
   * `narrow` filters or groups; `total` is a number worth adding up; `when`
   * dates the record; `other` is any other plain field, named so a request
   * about it can reach it — its values are too many to list.
   */
  readonly role: "narrow" | "total" | "when" | "other";
  /**
   * The values this field holds: the API's declared set, or, where it declares
   * none, what this account's records were seen to hold.
   *
   * Carried so a narrowing phrase can be written in the data's own spelling
   * rather than the user's — "USD", not "US dollars". A total narrowed by a
   * word the records never hold counts nothing and looks right.
   */
  readonly values?: readonly string[];
  /**
   * The values are what the records were seen to hold, not a set the API
   * declares: `all` where the read saw every record, `some` where it did not —
   * a first page shows the values near the start of the list, not all of them.
   */
  readonly seen?: "all" | "some";
  /**
   * The documentation says this number is in the smallest currency unit
   * (12500 is $125.00). An amount a request names is written in that unit:
   * "more than $250" compared 250 cents, and counted the wrong payments
   * (checkpoint 4). The values are never rescaled on this claim alone.
   */
  readonly minor?: true;
  /**
   * What the documentation says the field means, in its own words and short.
   * Two fields can answer to the same word — a flag that is true only when
   * something happened in full, and an amount that says how much of it did —
   * and only the documentation tells them apart. A count of "refunded, in full
   * or in part" read the flag, and missed every part refund (2026-09-30).
   */
  readonly note?: string;
}

/** One API's described record types, as one source to choose from. */
export interface BriefSource {
  readonly connection: string;
  /** The API's own name, so two of them can be told apart in the roster. */
  readonly title: string;
  readonly entities: readonly EntitySpec[];
  /**
   * What this account's records were seen to hold, by record type id and
   * field path — for fields the API declares no values for. Never from the
   * catalog: these are the account's own words.
   */
  readonly seen?: Readonly<
    Record<
      string,
      {
        readonly fields: Readonly<Record<string, readonly string[]>>;
        readonly everyRecord?: boolean;
        /** Fields whose every value was different — names and titles, never offered to narrow by. */
        readonly unique?: readonly string[];
      }
    >
  >;
}

/** One record type the model may choose. */
export interface BriefCandidate {
  /**
   * What the model copies, and what makes it unique across every API.
   *
   * The record type's own id where that is unambiguous, qualified with the
   * connection where two APIs both have one — the same rule the chat's widget
   * and record handles follow, and for the same reason: "task" reads as a
   * thing and "task--acme" reads as configuration, so the second is worth
   * paying for only where the first would be ambiguous.
   */
  readonly entity: string;
  /** Which API this came from, and its own id there. */
  readonly connection: string;
  readonly recordType: string;
  /** That API's name, for grouping the roster where there is more than one. */
  readonly source: string;
  readonly many: string;
  readonly kind: EntityKind;
  readonly description?: string | undefined;
  /**
   * Whether somebody would start a widget from these.
   *
   * False for the kinds that only make sense under another record — a list of
   * every category on an account is a glossary, not a dashboard.
   */
  readonly starting: boolean;
  readonly fields: readonly BriefField[];
  /**
   * Every field the record type has, listed or not. What tells a name the
   * roster left out from a name no record has — only the second is sent back.
   */
  readonly paths?: readonly string[];
}

export interface WriteBriefInput {
  /** What the user asked for, in their own words. */
  readonly intent: string;
  readonly candidates: readonly BriefCandidate[];
  /**
   * Today, as YYYY-MM-DD, so "this year" or "last month" can be turned into
   * dates. Absent, a request naming only relative time has nothing to go on.
   */
  readonly today?: string | undefined;
}

export interface WriteBriefResult {
  readonly brief: WidgetBrief | null;
  /** The model's own words for what it built, shown to the user. */
  readonly reason: string;
  /**
   * A different reading of the same words, offered beside the answer.
   *
   * Deliberately not a question asked before building. Blocking on "did you
   * mean records or a count?" makes every request an interrogation, and the
   * answer is usually obvious — so the better reading is built and the other
   * is offered as one click. It is null on almost every request, and has to
   * stay that way: an alternative on everything is a question on everything
   * wearing different clothes.
   */
  readonly alternative: { readonly label: string; readonly brief: WidgetBrief } | null;
  /**
   * More widgets, when the request asked for separate things seen together.
   *
   * Empty on almost every request, and it has to stay that way: a set on
   * everything would turn "show me my tasks" into a dashboard nobody asked
   * for. A request naming two collections is genuinely two widgets — which is
   * different from one widget carrying a second record's fields, and different
   * again from two readings of one request.
   */
  readonly plus: readonly WidgetBrief[];
  readonly error: string | null;
  /**
   * Set when no record type is what the request is about: the model's words
   * for which records are missing. Said, never built — asked how many Pokémon
   * there were, with no such record type, the nearest one was counted instead
   * and looked like an answer (checkpoint 2).
   */
  readonly unmatched?: string;
}

/** How many fields of each kind are worth putting in front of the model. */
const MAX_NARROW = 5;
const MAX_TOTAL = 3;
const MAX_WHEN = 4;
/** Values shown per field. Declared sets are complete, so fewer say enough; seen ones are what a request will copy. */
const MAX_DECLARED_VALUES = 8;
const MAX_SEEN_VALUES = 12;
/** Other plain fields named, without values. */
const MAX_OTHER = 12;

/** A field whose name says it dates the record: `created_at`, `bookedOn`, `date`, `posted`. */
const DATE_NAME = /(^|[._])(date|day|time|at|on)$|(^|[._])(created|updated|booked|posted|issued|closed|opened|due|paid|delivered)(_?(at|on|date))?$|Date$|At$|On$/;

/** A field that names or describes a record rather than sorting it into a kind: `title`, `description`, `sku`. */
const NAMING_PATH = /(^|[._])(title|name|description|summary|body|text|content|notes?|comments?|sku|slug|email|url|phone|image|thumbnail)$/i;

/** A path that names an identity rather than a quantity: `id`, `userId`, `account_id`. */
const IDENTIFIER_PATH = /(^|[._])id$|Id$|_ids?$/;
const DESCRIPTION_CHARS = 100;
/** How much of the documentation's sentence about one field the roster carries. */
const FIELD_NOTE_CHARS = 90;

/** Numbers worth totalling, as opposed to identifiers that happen to be numeric. */
/*
 * Not percentages: adding shares gives a number that is a share of nothing.
 * An average of them is only right when every share is out of the same whole,
 * which nothing here can know, so they are not offered as a total at all.
 */
const TOTALLABLE = new Set(["currency", "number", "count", "duration", "bytes"]);

/**
 * The record types a request could be about, with the few fields worth naming.
 *
 * Deliberately not every field. A brief names what somebody asked to narrow or
 * total by, and those are a handful per record type — where the whole field
 * dictionary for a real API is twelve hundred entries and would put the
 * prompt back where the endpoint list had it.
 */
/**
 * The record types to choose between, across every API that has any.
 *
 * Takes sources rather than a flat list because *which API* is part of the
 * answer: a workspace with two connections has two rosters, and a brief that
 * could only ever see one of them made the assistant fall back to picking
 * endpoints by hand the moment somebody connected a second.
 */
export const briefCandidates = (sources: readonly BriefSource[]): BriefCandidate[] => {
  /*
   * Qualified only on collision. Two APIs that both call something a task
   * genuinely need telling apart; one that does not should not be made to read
   * like configuration for the sake of the one that might.
   */
  const owners = new Map<string, number>();
  for (const source of sources) {
    for (const entity of source.entities) {
      owners.set(entity.id, (owners.get(entity.id) ?? 0) + 1);
    }
  }

  return sources.flatMap((source) =>
    source.entities.map((entity) => {
    const recipe = recipeFor(entity.kind);
    /*
     * Its own fields only. A record sent inside its rows — an invoice row
     * carrying its work order — belongs to its own record type, and a brief
     * that filtered invoices by the work order's fields would be asking the
     * wrong record type the question.
     */
    const visible = ownFields(entity, source.entities).filter((field) => field.visibility !== "hidden");

    const narrowPaths =
      entity.views.facets.length > 0
        ? entity.views.facets
        : facetsFromRecipe(recipe, visible.map((field) => field.path));

    const labelOf = (path: string): string =>
      entity.fields.find((field) => field.path === path)?.label ?? path;

    const seenSet = source.seen?.[entity.id];
    const seen = seenSet?.fields ?? {};
    /*
     * A flag's values are true and false, whatever it is called: "VIP" is a
     * name, not a value. A field the API declares no set for offers what the
     * records were seen to hold: "money out" is `debit`, and nothing else
     * said so (measurement 1, vaultbank).
     */
    /* The documentation's sentence about a field, where it has one that says more than the label. */
    const noteOf = (path: string): { note?: string } => {
      const field = entity.fields.find((one) => one.path === path);
      const said = field?.description?.split(/(?<=[.!?])\s/)[0]?.replace(/\s+/g, " ").trim().replace(/[.]+$/, "") ?? "";
      const label = (field?.label ?? "").toLowerCase();
      return said.length >= 8 && said.toLowerCase() !== label ? { note: said.slice(0, FIELD_NOTE_CHARS) } : {};
    };

    const valuesOf = (path: string): { values: readonly string[]; seen?: "all" | "some" } => {
      const field = entity.fields.find((one) => one.path === path);
      if (!field) return { values: [] };
      if ((field.values?.length ?? 0) > 0) return { values: (field.values ?? []).slice(0, MAX_DECLARED_VALUES) };
      if (field.kinds.includes("boolean")) return { values: ["true", "false"] };
      const held = seen[path] ?? [];
      return held.length > 0
        ? { values: held.slice(0, MAX_SEEN_VALUES), seen: seenSet?.everyRecord ? "all" : "some" }
        : { values: [] };
    };

    /*
     * Flags and closed sets narrow as surely as the recipe's own choices:
     * "VIP contacts", "unpaid bills". Offered after the recipe's, so nothing it
     * chose is pushed out; a record type whose recipe had no room for a flag
     * offered no way to ask for "the VIP ones", and a count of VIP contacts
     * came out as a count of all of them (unscripted benchmark, 2026-09-28).
     */
    const closed = visible
      .filter(
        (field) =>
          !narrowPaths.includes(field.path) &&
          (field.kinds.includes("boolean") ||
            (field.values?.length ?? 0) > 0 ||
            (seen[field.path]?.length ?? 0) > 0),
      )
      .map((field) => field.path);
    const narrow: BriefField[] = [...narrowPaths, ...closed].slice(0, MAX_NARROW).map((path) => {
      const held = valuesOf(path);
      return {
        path,
        label: labelOf(path),
        role: "narrow" as const,
        ...(held.values.length > 0 ? { values: held.values, ...(held.seen ? { seen: held.seen } : {}) } : {}),
        ...noteOf(path),
      };
    });

    /*
     * Numbers worth adding up: first what the record type says is money or a
     * quantity, then any other number that is not an identity. A plain numeric
     * `total` the description left untagged was never offered, and asked for
     * the value of paid orders the model named a field that does not exist
     * (unscripted benchmark, 2026-09-28).
     */
    const tagged = visible.filter((field) => field.semantic && TOTALLABLE.has(field.semantic));
    const untagged = visible.filter(
      (field) => !field.semantic && field.kinds.includes("number") && !IDENTIFIER_PATH.test(field.path),
    );
    const total: BriefField[] = [...tagged, ...untagged]
      .slice(0, MAX_TOTAL)
      .map((field) => ({
        path: field.path,
        label: field.label ?? field.path,
        role: "total" as const,
        ...(field.format === "minor_units" ? { minor: true as const } : {}),
        ...noteOf(field.path),
      }));

    /*
     * What dates the records, so a request can say when: "in July", "this
     * year". None was ever offered, and asked for July's debits the model
     * could only count every transaction there was (measurement 1).
     */
    const when: BriefField[] = visible
      .filter(
        (field) =>
          field.semantic === "timestamp" ||
          (field.format !== undefined && /date|time|unix|iso/i.test(String(field.format))) ||
          (!field.semantic && DATE_NAME.test(field.path)),
      )
      .slice(0, MAX_WHEN)
      .map((field) => ({ path: field.path, label: field.label ?? field.path, role: "when" as const }));

    /*
     * Every other plain field, by name only. "Breeds from the United States"
     * is a question about `country`, which holds too many values to list;
     * offered nothing but `origin`, the model narrowed that, and counted 0
     * (checkpoint 2).
     */
    const listed = new Set([...narrow, ...total, ...when].map((field) => field.path));
    /*
     * Never what names or describes a record: narrowed to "smartphones", a
     * product's title matched none (checkpoint 2). Known from the check's read
     * where there was one, and from the name where there was not.
     */
    const naming = new Set(seenSet?.unique ?? []);
    const other: BriefField[] = visible
      .filter(
        (field) =>
          !listed.has(field.path) &&
          !naming.has(field.path) &&
          !NAMING_PATH.test(field.path) &&
          !IDENTIFIER_PATH.test(field.path) &&
          field.kinds.some((kind) => kind === "string" || kind === "number") &&
          !field.kinds.some((kind) => kind === "object" || kind === "array"),
      )
      .slice(0, MAX_OTHER)
      .map((field) => ({
        path: field.path,
        label: field.label ?? field.path,
        role: "other" as const,
        ...(field.format === "minor_units" ? { minor: true as const } : {}),
      }));

    return {
      entity:
        (owners.get(entity.id) ?? 0) > 1 ? `${entity.id}--${source.connection}` : entity.id,
      connection: source.connection,
      recordType: entity.id,
      source: source.title,
      many: entity.name.many,
      kind: entity.kind,
      ...(entity.description ? { description: entity.description } : {}),
      starting: recipe.starting,
      fields: [...narrow, ...total, ...when, ...other],
      paths: entity.fields.map((field) => field.path),
    };
    }),
  );
};

/** How the roster introduces a field's values, by where they came from. */
const VALUES_SAID = { declared: "one of", all: "in the records", some: "in some records" } as const;

/** A roster field by its path, or by its label where the model copied that. */
const fieldNamed = (fields: readonly BriefField[], named: string): BriefField | undefined =>
  fields.find((field) => field.path === named) ??
  fields.find((field) => field.label.toLowerCase() === named.trim().toLowerCase());

/** The listed spelling of a value, ignoring case and surrounding space; undefined if none matches. */
const listedAs = (listed: readonly string[], value: string): string | undefined => {
  const wanted = value.trim().toLowerCase();
  return listed.find((one) => one.trim().toLowerCase() === wanted);
};

/** A flag's values stand for true and false, and the compiler reads "yes" and "no" as those. */
const isFlag = (values: readonly string[]): boolean =>
  values.length === 2 && values.includes("true") && values.includes("false");

/**
 * The fields of a brief as a model states them, flat.
 *
 * A tool schema has to stay flat — the JSON Schema converter refuses unions
 * and records — so a brief arrives as `measureAgg` and `measureField` rather
 * than the nested `measure` the compiler wants. This is that mapping, in one
 * place, because three callers now need it: the primary brief, the extra
 * widgets a request asks for beside it, and the starter sets written for a
 * category. Three spellings of it would disagree the day any one changed.
 */
export interface BriefParts {
  readonly entity: string;
  readonly intent: WidgetIntent;
  readonly title?: string | undefined;
  readonly filters?: ReadonlyArray<{ field: string; values?: string[] | undefined }> | undefined;
  readonly columns?: readonly string[] | undefined;
  readonly groupBy?: string | undefined;
  readonly measureAgg?: "count" | "sum" | undefined;
  readonly measureField?: string | undefined;
  readonly sortField?: string | undefined;
  readonly sortDir?: "asc" | "desc" | undefined;
  readonly limit?: number | undefined;
}

export const briefFromParts = (parts: BriefParts): WidgetBrief => ({
  entity: parts.entity,
  intent: parts.intent,
  ...(parts.title?.trim() ? { title: parts.title.trim() } : {}),
  ...(parts.columns && parts.columns.length > 0 ? { columns: [...parts.columns] } : {}),
  ...(parts.filters && parts.filters.length > 0
    ? {
        filters: parts.filters.map((one) => ({
          field: one.field,
          ...(one.values && one.values.length > 0 ? { values: [...one.values] } : {}),
        })),
      }
    : {}),
  ...(parts.groupBy ? { groupBy: parts.groupBy } : {}),
  ...(parts.sortField
    ? { sort: { field: parts.sortField, ...(parts.sortDir ? { dir: parts.sortDir } : {}) } }
    : {}),
  /*
   * A measure is only carried where it means something. A count is the default
   * for every intent, and naming one on a plain list of records would turn a
   * list into a number nobody asked for.
   */
  ...(parts.intent !== "records" && (parts.measureAgg || parts.measureField)
    ? {
        measure: {
          agg: parts.measureAgg ?? "count",
          ...(parts.measureField ? { field: parts.measureField } : {}),
        },
      }
    : {}),
  ...(parts.limit !== undefined ? { limit: parts.limit } : {}),
});

/**
 * The record type a brief named, and which API it belongs to.
 *
 * Null when the model wrote something that was not offered — never
 * approximated, on the same rule every other pass here follows.
 */
export const resolveCandidate = (
  candidates: readonly BriefCandidate[],
  named: string,
): BriefCandidate | null => candidates.find((one) => one.entity === named) ?? null;

export const briefSchema = z.object({
  entity: z
    .string()
    .describe(
      'The id of the record type this is about. Copy it exactly. "none" when no record type here is the kind of thing the request is about.',
    ),
  intent: z
    .enum(["records", "measure", "compare"])
    .describe(
      'What the widget is for. "records" shows the records themselves, which the reader ' +
        'narrows with filter strips — this is what "show me X", "list X" and "X filtered by ' +
        'Y" all mean. "measure" is ONE number about them: how many there are, or how much ' +
        'they come to. "compare" is that number broken down by something and drawn as a ' +
        'chart — "how many X per Y", "X by month", "compare X across Y".',
    ),
  title: z.string().optional().describe("What to call it, in the user's words. Omit to use the record type's own name."),
  filters: z
    .array(
      z.object({
        field: z.string().describe("Field path, copied exactly from the record type's list."),
        values: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            'Values to start the strip narrowed to, when the request named some — "open X" ' +
              'starts the state strip on "Open". Copy one of the values the record type lists ' +
              "where it lists any; otherwise use the user's own word. A value matching nothing " +
              "is ignored and the reader simply sees everything, so an approximate word is " +
              "safe here — an invented FIELD is not.",
          ),
        above: z.number().optional().describe("Only records whose number in this field is more than this."),
        below: z.number().optional().describe("Only records whose number in this field is less than this."),
        from: z.string().optional().describe("Only records dated on or after this day, YYYY-MM-DD, by this field."),
        to: z.string().optional().describe("Only records dated before this day, YYYY-MM-DD, by this field (exclusive)."),
        empty: z
          .boolean()
          .optional()
          .describe(
            "true: only records where this field holds nothing (not cancelled = the cancelled date is empty). " +
              "false: only records where it holds something.",
          ),
      }),
    )
    .max(4)
    .optional()
    .describe(
      'Fields to offer as filter strips. This is where "filtered by Y" goes, and also where a ' +
        'narrowing phrase goes. Omit to use the record type\'s own defaults, which are usually ' +
        "right.",
    ),
  columns: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "Field paths to show, only when the user named particular ones. Omit otherwise — the " +
        "record type already knows which fields are worth showing.",
    ),
  groupBy: z
    .string()
    .optional()
    .describe('Required for "compare": the field path the number is broken down by.'),
  measureAgg: z
    .enum(["count", "sum"])
    .optional()
    .describe(
      'What is being measured, for "measure" and "compare". "count" counts records and is ' +
        'the default. "sum" adds a number up and needs measureField.',
    ),
  measureField: z.string().optional().describe('The field path to add up. Required when measureAgg is "sum".'),
  sortField: z
    .string()
    .optional()
    .describe("A field path to sort by, only when the user asked for a particular sort."),
  sortDir: z.enum(["asc", "desc"]).optional().describe("Which way to sort."),
  limit: z.number().int().min(1).max(1000).optional().describe('Only when the user asked for "top" or "first" so many.'),
  alongsideEntity: z
    .string()
    .optional()
    .describe(
      "A SECOND kind of record, when the request names two — \"my X alongside their Y\", " +
        '"X with their Y", "X against Y". Copy its id from the list exactly, the same way ' +
        "you copy the first. Leave it out unless the request really is about two kinds of " +
        "record.",
    ),
  alongsideAs: z
    .enum(["join", "beside"])
    .optional()
    .describe(
      'Which question the second kind answers. "join" reads one record and the other ' +
        "together, a row at a time — what else is true of this one. \"beside\" sets two " +
        "measurements against each other on one axis, which is a chart and only makes sense " +
        'with "compare". Defaults to "join".',
    ),
  plus: z
    .array(
      z.object({
        entity: z.string().describe("The id of this one's record type. Copy it exactly."),
        intent: z.enum(["records", "measure", "compare"]),
        title: z.string().optional(),
        filters: z
          .array(z.object({ field: z.string(), values: z.array(z.string()).max(8).optional() }))
          .max(4)
          .optional(),
        groupBy: z.string().optional(),
        measureAgg: z.enum(["count", "sum"]).optional(),
        measureField: z.string().optional(),
      }),
    )
    .max(3)
    .optional()
    .describe(
      "MORE widgets, when the request asks for separate things to be seen together — " +
        '"my X and my Y", "X, Y and Z on one tab". One entry each, described exactly as the ' +
        "first one is. Leave it out for every ordinary request, which is nearly all of them. " +
        "Never use it to hedge between two readings of the same words — that is `alternative` " +
        "— and never for a second kind of record that belongs ON these rows, which is " +
        "`alongsideEntity`.",
    ),
  alternative: z
    .object({
      label: z
        .string()
        .describe(
          "What this other reading would show, in the user's own words. A short phrase — " +
            '"how many per category" — never a sentence and never a field path.',
        ),
      intent: z.enum(["records", "measure", "compare"]),
      entity: z
        .string()
        .optional()
        .describe("Only when the other reading is about a different kind of record."),
      groupBy: z.string().optional(),
      filters: z
        .array(z.object({ field: z.string(), values: z.array(z.string()).max(8).optional() }))
        .max(4)
        .optional(),
      measureAgg: z.enum(["count", "sum"]).optional(),
      measureField: z.string().optional(),
    })
    .optional()
    .describe(
      "A genuinely different reading of the same words, offered beside your answer rather " +
        "than instead of it. The usual one: they asked to see records and might have meant a " +
        "count broken down, or the other way about. Leave it out unless choosing it would " +
        "answer a DIFFERENT question — never to hedge between two readings that show the " +
        "same thing.",
    ),
  unmet: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      "Anything the request asked to leave out or narrow by that no filter here can express, in its " +
        "own words. The widget says it. Never drop a narrowing in silence, and never say in reason " +
        "that something was left out unless a filter does it.",
    ),
  reading: z
    .object({
      term: z.string().describe('The word, as the request wrote it: "revenue".'),
      as: z
        .string()
        .describe('The reading you built, in a few plain words: "billed totals, by the date billed".'),
    })
    .optional()
    .describe(
      "Only when a business word in the request could be worked out more than one way from " +
        "these fields — revenue, sales, active: billed or collected, before or after refunds. " +
        "Name the word and the reading you built; offer the other reading as `alternative`. " +
        "Leave it out when the words mean one thing.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence, addressed to the user, saying what you built. Plain words — name " +
        "the records, never the record type id or a field path.",
    ),
});

type BriefArgs = z.infer<typeof briefSchema>;

const briefTool: LlmTool<BriefArgs> = {
  name: "write_brief",
  description: "Say which records the request is about, and what the widget should do with them.",
  schema: briefSchema,
};

export const BRIEF_SYSTEM_PROMPT = [
  "You turn a request for a dashboard widget into a brief.",
  "",
  "You are given every kind of record this API has, with a description and the few fields",
  "worth naming. Say which records the request is about, and what the widget is for.",
  "",
  "THE ONE DISTINCTION THAT MATTERS — what is the widget FOR?",
  "",
  '- "records" — they want to SEE the records. A list they can read, and narrow with filter',
  "  strips. This is what almost every request means.",
  '- "measure" — they want ONE number. How many there are, or how much they add up to.',
  '- "compare" — they want a number BROKEN DOWN by something, drawn as a chart.',
  "",
  "Getting this wrong is the most damaging thing you can do here, and it goes wrong in one",
  "direction: turning a request to SEE records into a chart that COUNTS them.",
  "",
  '- "show me X with a filter by Y" is records. Put Y in filters. It is NOT a comparison —',
  "  the person wants the records in front of them with a way to narrow down, not a count.",
  '- "X filtered by Y", "X by Y" where they asked to see or list X: records, Y in filters.',
  '- "how many X per Y", "X by month", "compare X and Y", "breakdown of X by Y": compare.',
  '- "how many X", "total X", "what are we owed": measure.',
  "- When the words could be read either way, prefer records. A list can be read and then",
  "  narrowed; a chart of counts answers one question and hides the records entirely.",
  "",
  "A WORD THAT NAMES A VALUE, NOT A FIELD.",
  "",
  '- "maintenance tasks", "open work", "unpaid bills" name a *value* one of the fields holds.',
  "  That is still records — the whole set — with the strip for that field started narrowed to",
  "  the value. Put the field in `filters` and the word in that filter's `values`.",
  "- Never leave the word out and hand back the unnarrowed list: they asked for a subset.",
  "- Never answer it with a count either. They want to see the ones that match.",
  "- Copy the value from the ones the field lists where it lists any — \"one of\" is every value",
  "  it can hold, \"in the records\" is what every record holds, \"in some records\" is what some",
  "  hold and there may be more. Write the listed value that means",
  '  what they said, spelled as listed ("urgent" might be P1). Otherwise use their own word.',
  "  A value the records never hold matches nothing, so a wrong field is worse than an",
  "  approximate word.",
  '- "in some records" lists only the values near the start of the list — there are more. A word',
  "  of the same kind as the listed values (another category, another status) still belongs to",
  "  that field, spelled the way the listed ones are.",
  '- "also" names the record type\'s other fields, whose values are too many to list. Narrow by',
  "  one of them only when the request is about that field and no field above could hold the word.",
  "",
  "Choosing the records:",
  "- Answer with a RECORD TYPE ID — the first token on its line. Copy it exactly. One you",
  "  invent or abbreviate is a failure, not an approximation.",
  "- Read the descriptions. People describe what they want in their own words, and the",
  "  records that answer it are often named something else.",
  "- A field's own words, after its path, say what it holds. Where two fields could answer",
  "  to the same word, choose by those: a yes-or-no that is true only when something",
  "  happened in full does not find the records where it happened in part.",
  "- Pick the records the user wants to see. A request to see work grouped by who it is",
  "  assigned to is about the work, not about the people.",
  '- When NONE of the record types is the kind of thing the request is about, answer entity',
  '  "none" and say in the reason which records are missing. Never answer with a different',
  "  kind of record instead: a count of the wrong records looks like an answer and is wrong.",
  "  Records that only mention the thing — a link to it, a field naming it — are not it.",
  "- Some record types are marked as reference lists. Those are things other records point",
  "  at — a set of categories, a set of statuses. Somebody almost never wants a board of",
  "  them; pick one only if the request is plainly about the list itself.",
  "",
  "Narrowing phrases:",
  "- A word in front of the records usually narrows them rather than naming something else.",
  '  "open X", "overdue X", "unpaid X" are all X with a strip started on that value. Choose',
  "  the records the noun names, put the field in filters, and put the word in its values.",
  "- Never leave a narrowing invisible. Somebody who cannot see what was narrowed cannot",
  "  widen it, and will believe they are looking at everything there is.",
  "",
  "Ranges — a number or a time the request names:",
  '- "more than 100", "over $50", "under 10": a filter on that number field with `above` or',
  "  `below` (both exclusive). No values.",
  '- "in July 2026", "this year", "since March", "last month": a filter on the field the record',
  "  type is dated by, with `from` (inclusive) and `to` (exclusive), as YYYY-MM-DD. July 2026 is",
  "  from 2026-07-01 to 2026-08-01. Work relative words out from TODAY.",
  "- A range goes with any narrowing by value on other fields: debits in July is two filters.",
  "- A field marked \"in the smallest currency unit\" holds 100 for 1.00: write an amount the",
  "  request names in that unit. More than $250 is above 25000.",
  "",
  "Whether a field holds anything:",
  '- "not cancelled", "leave out archived ones", "without a due date": a filter with `empty` on the',
  "  field that records it, usually a date (a cancelled, archived or closed date) listed under",
  '  "dated by" or "also". true: it holds nothing (never cancelled); false: it holds something. No values.',
  "- Such a field is the answer even when nothing else in the list is about it. Put a narrowing in",
  "  unmet only when no listed field records it at all.",
  "- Every narrowing the request states goes in filters. One nothing here can express goes in",
  "  unmet, in the request's words: the widget says so. Never leave one out in silence, and never",
  "  say in reason that something was left out unless a filter does it.",
  "",
  "SEVERAL THINGS AT ONCE.",
  "",
  "- Four different things can be a \"second\" one, and they are not interchangeable:",
  "  - another record's fields ON each row  -> alongsideEntity, alongsideAs \"join\"",
  "  - two counts set against each other    -> alongsideEntity, alongsideAs \"beside\"",
  "  - the same words read two ways         -> alternative",
  "  - two separate things asked for        -> plus",
  '- "show me my X and my Y" is `plus`: two widgets, seen together. "Show me X with their Y"',
  "  is not — that is one widget with the other's fields on it.",
  "- Never use `plus` to hedge. If you are unsure which of two readings they meant, that is",
  "  `alternative` and it is one widget either way.",
  "",
  "A word that reads several ways:",
  "- Revenue, sales, active and the like can be worked out more than one way from the same",
  "  records: billed or collected, before or after refunds. Build the likeliest, say which in",
  "  `reading` (the word, and your reading in a few plain words), and offer the other as the",
  "  alternative. The reader sees which one the number is. Leave `reading` out otherwise.",
  "",
  "Offering the other reading:",
  "- When the words genuinely read two ways, build the better one and offer the other as an",
  "  alternative with a short label. Do not ask first: the person sees what you built and",
  '  can switch in one click, which is faster than answering a question.',
  "- Only when choosing it would answer a DIFFERENT question. Two readings that show the",
  "  same thing are one reading, and an alternative on every request is an interrogation",
  "  wearing different clothes.",
  "",
  "TWO KINDS OF RECORD AT ONCE.",
  "",
  '- Some requests name two: "X alongside their Y", "X with their Y", "X against Y". Put the',
  "  first in entity and the second in alongsideEntity, both copied from the list.",
  '- alongsideAs says which question is being asked. "join" reads one record and the other',
  '  together, a row at a time, and is the usual one. "beside" sets two measurements against',
  '  each other on one axis, which is a chart and only ever goes with "compare".',
  "- A word that names a VALUE is not a second kind of record. A narrowing phrase belongs in",
  "  filters, as above; name a second record type only when the request is about both.",
  "- Leave it out when in doubt. One kind of record answered well is almost always the right",
  "  answer, and a second one nothing links to the first is dropped anyway.",
  "",
  "Naming fields:",
  "- Copy field paths exactly from the chosen record type's own list. Never invent one, and",
  "  never name a field listed under a different record type.",
  "- Say as little as possible. Every record type already knows which fields are worth",
  "  showing, how to sort them and what to filter by, and those defaults are usually better",
  "  than a guess. Name a field only when the request actually asked for that field.",
  "- Leave columns out unless particular fields were asked for by name.",
].join("\n");

/**
 * The roster the model chooses from.
 *
 * Record types, not endpoints — a hundred plain nouns with a sentence each,
 * where the endpoint list was two hundred lines of "Retrieve all X" separated
 * only by their URLs. Reference lists sit at the end under their own heading,
 * because they are legitimate answers and almost never the right one.
 */
export const buildBriefPrompt = (input: WriteBriefInput): string => {
  const render = (candidate: BriefCandidate): string => {
    const summary = (candidate.description ?? "")
      .split("\n")[0]
      ?.slice(0, DESCRIPTION_CHARS)
      .trim();
    const head = `  ${candidate.entity}  ${candidate.many}${summary ? `  — ${summary}` : ""}`;
    if (candidate.fields.length === 0) return head;
    const narrow = candidate.fields.filter((field) => field.role === "narrow");
    const total = candidate.fields.filter((field) => field.role === "total");
    const lines = [head];
    if (narrow.length > 0) {
      lines.push(
        `      narrow by: ${narrow
          .map(
            (f) =>
              `${f.label} (${f.path}${f.note ? `: ${f.note}` : ""})${
                f.values && f.values.length > 0 ? ` ${VALUES_SAID[f.seen ?? "declared"]}: ${f.values.join(" / ")}` : ""
              }`,
          )
          .join(", ")}`,
      );
    }
    /* A number the documentation says is in the smallest currency unit says so. */
    const named = (f: BriefField) =>
      `${f.label} (${f.path}${f.minor ? ", in the smallest currency unit" : ""}${f.note ? `: ${f.note}` : ""})`;
    if (total.length > 0) {
      lines.push(`      total by: ${total.map(named).join(", ")}`);
    }
    const dated = candidate.fields.filter((field) => field.role === "when");
    if (dated.length > 0) {
      lines.push(`      dated by: ${dated.map((f) => `${f.label} (${f.path})`).join(", ")}`);
    }
    const others = candidate.fields.filter((field) => field.role === "other");
    if (others.length > 0) {
      lines.push(`      also: ${others.map(named).join(", ")}`);
    }
    return lines.join("\n");
  };

  const starting = input.candidates.filter((candidate) => candidate.starting);
  const reference = input.candidates.filter((candidate) => !candidate.starting);

  /*
   * Grouped by API only when there is more than one.
   *
   * A workspace with a single connection should not be made to read like one
   * with several — the heading would be noise on every request. With two, that
   * grouping is the only thing telling the model that two similarly named
   * record types are different things in different systems.
   */
  const sources = [...new Set(input.candidates.map((candidate) => candidate.source))];
  const listed = (group: readonly BriefCandidate[]): string[] =>
    sources.length < 2
      ? group.map(render)
      : sources.flatMap((source) => {
          const mine = group.filter((candidate) => candidate.source === source);
          return mine.length > 0 ? [`  from ${source}:`, ...mine.map(render)] : [];
        });

  return [
    "RECORD TYPES:",
    ...listed(starting),
    ...(reference.length > 0
      ? [
          "",
          "REFERENCE LISTS — things other records point at, rarely a board of their own:",
          ...listed(reference),
        ]
      : []),
    "",
    ...(input.today ? [`TODAY: ${input.today}`, ""] : []),
    "THE REQUEST:",
    input.intent,
  ].join("\n");
};

/**
 * Ask the model to write a brief.
 *
 * The record type it names is checked against the roster before anything is
 * believed — the same boundary every other model pass here draws. Field paths
 * are left to `compileBrief`, which holds the record type's whole field list
 * and reports what it dropped, rather than being checked twice against two
 * different ideas of what exists.
 */
export const writeBrief = async (
  llm: LlmAdapter,
  input: WriteBriefInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<WriteBriefResult> => {
  const none = (error: string): WriteBriefResult => ({
    brief: null,
    reason: "",
    alternative: null,
    plus: [],
    error,
  });

  if (input.candidates.length === 0) {
    return none("this API has no record types described yet");
  }
  /* "none", unless a record type is really called that. */
  const isNone = (entity: string): boolean =>
    entity.trim().toLowerCase() === "none" && !input.candidates.some((candidate) => candidate.entity === entity);

  /*
   * Asked twice at most. A brief that breaks a rule its own schema states — a
   * sum with nothing to add up — goes back once with the reason, rather than
   * compiling into nothing: one did, and a question about a total got no
   * widget at all (unscripted benchmark, 2026-09-28).
   */
  let accepted: BriefArgs | null = null;
  let problem: string | null = null;
  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    let result: Awaited<ReturnType<LlmAdapter["generate"]>>;
    try {
      result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0,
        maxOutputTokens: 1024,
        messages: [
          { role: "system" as const, content: BRIEF_SYSTEM_PROMPT },
          {
            role: "user" as const,
            content:
              problem === null
                ? buildBriefPrompt(input)
                : `${buildBriefPrompt(input)}\n\nYOUR PREVIOUS ANSWER COULD NOT BE USED: ${problem}\nAnswer again, following the rules above.`,
          },
        ],
        tools: { write_brief: briefTool },
        toolChoice: { name: "write_brief" as const },
      });
    } catch (cause) {
      return none(cause instanceof Error ? cause.message : String(cause));
    }
    const call = result.toolCalls.find((candidate) => candidate.name === "write_brief");
    const parsed = call ? briefSchema.safeParse(call.args) : null;
    if (!parsed?.success) {
      problem = "no brief was written with the write_brief tool.";
      continue;
    }
    /* Nothing here is what was asked about: taken as said, and never sent back over a brief's rules. */
    if (isNone(parsed.data.entity)) {
      accepted = parsed.data;
      break;
    }
    const wanted = (one: { measureAgg?: string | undefined; measureField?: string | undefined; intent: string }) =>
      one.intent !== "records" && one.measureAgg === "sum" && !one.measureField;
    if (wanted(parsed.data) || (parsed.data.alternative && wanted(parsed.data.alternative))) {
      problem = 'measureAgg is "sum" but measureField is missing: name the number to add up, copied from the record type\'s fields.';
      continue;
    }
    /*
     * A field written as words — "total amount" — that is neither a path nor
     * any field's label is a description, not a name. So is a unit —
     * "kilograms" for `weight_kg` — where no one field carries it (a unit one
     * field does carry is that field; see `pathOf`), and any other name the
     * record type does not have. Sent back once rather than compiled into
     * nothing (checkpoint 3).
     */
    const roster = input.candidates.find((candidate) => candidate.entity === parsed.data.entity);
    const named = [
      ...(parsed.data.filters ?? []).map((one) => one.field),
      ...(parsed.data.columns ?? []),
      ...(parsed.data.groupBy ? [parsed.data.groupBy] : []),
      ...(parsed.data.measureField ? [parsed.data.measureField] : []),
      ...(parsed.data.sortField ? [parsed.data.sortField] : []),
    ];
    const described = roster
      ? named.filter(
          (name) =>
            (/\s/.test(name) || roster.paths !== undefined) &&
            !roster.paths?.includes(name) &&
            !roster.fields.some(
              (field) => field.path === name || field.label.toLowerCase() === name.trim().toLowerCase(),
            ) &&
            unitCarrier(roster.fields, name) === undefined,
        )
      : [];
    if (described.length > 0) {
      const said = [...new Set(described)].map((name) => {
        const carriers = roster ? unitCarriers(roster.fields, name) : [];
        return carriers.length > 0
          ? `"${name}" is a unit, not a field (${carriers.map((field) => field.path).join(" or ")} ${carriers.length === 1 ? "holds" : "hold"} it)`
          : `"${name}" is not a field`;
      });
      problem = `${said.join("; ")}: use a field path exactly as the list shows it in parentheses.`;
      continue;
    }
    /*
     * A value the field lists none of, where it lists some: "US dollars" on a
     * field whose records hold USD and EUR. Narrowed by it, a total counts
     * nothing and looks right, so it goes back once with the values. A second
     * answer is taken as meant: what the records were seen to hold may not be
     * every value there is.
     */
    const unlisted =
      roster && attempt === 1
        ? (parsed.data.filters ?? []).flatMap((one) => {
            const field = fieldNamed(roster.fields, one.field);
            /* Only a complete set can say a value is not there: what some records held is not all there is. */
            if (!field?.values || field.values.length === 0 || isFlag(field.values) || field.seen === "some") return [];
            const missing = (one.values ?? []).filter((value) => listedAs(field.values ?? [], value) === undefined);
            return missing.length > 0
              ? [`${missing.map((value) => `"${value}"`).join(", ")} for ${field.path}, which ${field.seen ? "the records hold as" : "is one of"} ${field.values.join(" / ")}`]
              : [];
          })
        : [];
    if (unlisted.length > 0) {
      problem = `a value is not one the field lists: ${unlisted.join("; ")}. Write the listed value that means what the request said, or keep the word if none does.`;
      continue;
    }
    accepted = parsed.data;
  }
  if (!accepted) return none(problem ? `the model did not write a usable brief: ${problem}` : "the model did not write a brief");
  if (isNone(accepted.entity)) {
    const missing = accepted.reason.trim() || "None of these record types is what the request is about.";
    return { brief: null, reason: missing, alternative: null, plus: [], error: null, unmatched: missing };
  }
  /*
   * Still a value that every record was seen not to hold, after being shown
   * what they do hold: it can only match nothing, so it is said rather than
   * counted as 0 (checkpoint 2). A declared set stays lenient — a
   * specification's list can be out of date.
   */
  const chosen = input.candidates.find((candidate) => candidate.entity === accepted!.entity);
  const impossible = chosen
    ? (accepted.filters ?? []).flatMap((one) => {
        const field = fieldNamed(chosen.fields, one.field);
        if (field?.seen !== "all" || !field.values || isFlag(field.values)) return [];
        return (one.values ?? [])
          .filter((value) => listedAs(field.values ?? [], value) === undefined)
          .map((value) => `No ${chosen.many.toLowerCase()} have ${field.label} "${value}": every one holds ${field.values!.join(", ")}.`);
      })
    : [];
  if (impossible.length > 0) {
    const said = impossible.join(" ");
    return { brief: null, reason: said, alternative: null, plus: [], error: null, unmatched: said };
  }
  let args: BriefArgs = accepted;
  const found = input.candidates.find((candidate) => candidate.entity === args.entity);
  if (!found) return none(`the model chose "${args.entity}", which is not a record type here`);

  /*
   * A field named by what it is called rather than where it is: the roster
   * shows "Total amount (total)", and a model copying the words in front of
   * the path wrote "total amount" — a field no record has, so a sum refused to
   * compile and a filter was dropped (unscripted benchmark, 2026-09-28).
   * Resolved to the path only where exactly one field carries that label;
   * anything else is left as written, for the compiler to refuse by name.
   */
  const pathOf = (named: string | undefined): string | undefined => {
    if (named === undefined || found.fields.some((field) => field.path === named)) return named;
    const labelled = found.fields.filter((field) => field.label.toLowerCase() === named.trim().toLowerCase());
    if (labelled.length === 1) return labelled[0]!.path;
    if (found.paths?.includes(named)) return named;
    /* A unit written for the one field that carries it: "kilograms" is `weight_kg`. */
    return unitCarrier(found.fields, named)?.path ?? named;
  };
  /* A listed value written in other letters is the listed value: "usd" is USD. */
  const spelled = (path: string, values: string[] | undefined): string[] | undefined => {
    const listed = found.fields.find((field) => field.path === path)?.values ?? [];
    return values?.map((value) => listedAs(listed, value) ?? value);
  };
  args = {
    ...args,
    ...(args.filters
      ? {
          filters: args.filters.map((one) => {
            const field = pathOf(one.field)!;
            const values = spelled(field, one.values);
            return { ...one, field, ...(values ? { values } : {}) };
          }),
        }
      : {}),
    ...(args.columns ? { columns: args.columns.map((one) => pathOf(one)!) } : {}),
    ...(args.groupBy ? { groupBy: pathOf(args.groupBy) } : {}),
    ...(args.measureField ? { measureField: pathOf(args.measureField) } : {}),
    ...(args.sortField ? { sortField: pathOf(args.sortField) } : {}),
  };

  const brief: WidgetBrief = {
    entity: found.entity,
    intent: args.intent,
    ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    ...(args.columns && args.columns.length > 0 ? { columns: args.columns } : {}),
    ...(args.filters && args.filters.length > 0
      ? {
          filters: args.filters.map((one) => ({
            field: one.field,
            ...(one.values && one.values.length > 0 ? { values: one.values } : {}),
            ...(one.above !== undefined ? { above: one.above } : {}),
            ...(one.below !== undefined ? { below: one.below } : {}),
            ...(one.from ? { from: one.from } : {}),
            ...(one.to ? { to: one.to } : {}),
            ...(one.empty !== undefined ? { empty: one.empty } : {}),
          })),
        }
      : {}),
    ...(args.groupBy ? { groupBy: args.groupBy } : {}),
    ...(args.sortField
      ? { sort: { field: args.sortField, ...(args.sortDir ? { dir: args.sortDir } : {}) } }
      : {}),
    /*
     * A measure is only carried where it means something. A count is the
     * default for every intent, and naming one on a plain list of records
     * would turn a list into a number nobody asked for.
     */
    ...(args.intent !== "records" && (args.measureAgg || args.measureField)
      ? {
          measure: {
            agg: args.measureAgg ?? "count",
            ...(args.measureField ? { field: args.measureField } : {}),
          },
        }
      : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    /*
     * The second record type, by the record type's own id.
     *
     * Resolved against the roster like the first, and carried through
     * unresolved where it is not on it: `compileBrief` holds the record types
     * and says plainly that there is no such thing, which beats dropping the
     * half of the request nobody would then know had gone missing.
     */
    ...(args.alongsideEntity
      ? {
          alongside: {
            entity:
              input.candidates.find((one) => one.entity === args.alongsideEntity)?.recordType ??
              args.alongsideEntity,
            ...(args.alongsideAs ? { as: args.alongsideAs } : {}),
          },
        }
      : {}),
    /* Asked for and not expressible: said on the widget, never dropped (checkpoint 4). */
    ...((args.unmet ?? []).some((one) => one.trim())
      ? { unmet: (args.unmet ?? []).map((one) => one.trim().slice(0, 160)).filter(Boolean).slice(0, 4) }
      : {}),
    /* Which "revenue" this is, said on the widget (plan, track E). Only on a number or a chart. */
    ...(args.reading?.term.trim() && args.reading.as.trim() && args.intent !== "records"
      ? { reading: { term: args.reading.term.trim().slice(0, 60), as: args.reading.as.trim().slice(0, 160) } }
      : {}),
  };

  /*
   * The other reading, checked as hard as the first.
   *
   * A record type it names has to be one on the roster, and one that would
   * build the very same widget is not an alternative to anything — offering it
   * would be asking a question with one answer.
   */
  let alternative: WriteBriefResult["alternative"] = null;
  const other = args.alternative;
  if (other?.label.trim()) {
    const entity = other.entity
      ? input.candidates.find((candidate) => candidate.entity === other.entity)?.entity
      : found.entity;
    /*
     * Another record type or intent, or — for a word that reads several ways —
     * another measure or narrowing of the same records: "revenue" collected
     * rather than invoiced is the same records added up differently.
     */
    const differs =
      entity !== found.entity ||
      other.intent !== args.intent ||
      (other.measureField !== undefined && pathOf(other.measureField) !== args.measureField) ||
      (other.filters !== undefined &&
        JSON.stringify(other.filters.map((one) => [pathOf(one.field), one.values ?? []])) !==
          JSON.stringify((args.filters ?? []).map((one) => [one.field, one.values ?? []])));
    if (entity && differs) {
      alternative = {
        label: other.label.trim(),
        brief: {
          entity,
          intent: other.intent,
          ...(other.filters && other.filters.length > 0
            ? {
                filters: other.filters.map((one) => ({
                  field: one.field,
                  ...(one.values && one.values.length > 0 ? { values: one.values } : {}),
                })),
              }
            : {}),
          ...(other.groupBy ? { groupBy: other.groupBy } : {}),
          ...(other.intent !== "records" && (other.measureAgg || other.measureField)
            ? {
                measure: {
                  agg: other.measureAgg ?? "count",
                  ...(other.measureField ? { field: other.measureField } : {}),
                },
              }
            : {}),
        },
      };
    }
  }

  /*
   * The other things asked for, each checked as hard as the first.
   *
   * A record type not on the roster is dropped rather than approximated, and
   * one repeating the primary is not a second widget — it is the same request
   * written twice, which is what a model does when it is padding.
   */
  const plus: WidgetBrief[] = [];
  for (const extra of args.plus ?? []) {
    const match = input.candidates.find((candidate) => candidate.entity === extra.entity);
    if (!match) continue;
    if (match.entity === found.entity && extra.intent === args.intent) continue;
    plus.push(briefFromParts({ ...extra, entity: match.entity }));
  }

  return { brief, reason: args.reason.trim(), alternative, plus, error: null };
};
