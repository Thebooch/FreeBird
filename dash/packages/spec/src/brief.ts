import type { AlongsideMode, WidgetBrief } from "./brief-schema.js";
import type { Coercion } from "./coercion.js";
import { COERCION_SEMANTICS, coercionForFormat } from "./coercion.js";
import type { BuiltinComponentId } from "./contracts.js";
import type { WidgetSpec } from "./dashboard.js";
import { parseWidget } from "./dashboard.js";
import type { EntityField, EntitySpec } from "./entity.js";
import { entityById, fieldPathSchema } from "./entity.js";
import { entityGraph, linkColumn } from "./entity-graph.js";
import type { GraphOp } from "./relations.js";
import { FACET_MAX_PER_WIDGET, FACET_MAX_VALUES } from "./facet.js";
import { idSchema, pathParamNames } from "./primitives.js";
import { defaultFacets, defaultSort, recipeFor } from "./recipes.js";
import type { ResourceSpec } from "./resource.js";
import type { PipelineStep } from "./pipeline.js";
import type { SemanticType } from "./semantics.js";
import type { WidgetShape } from "./shape.js";
import { shapeSteps } from "./shape.js";

/**
 * A brief, compiled into the widget that answers it.
 *
 * The layer that replaces an endpoint hunt with a sentence. Everything a
 * widget needs used to be assembled per request from raw endpoint shapes —
 * which endpoint, which of its fields plays which role, what to group by —
 * and most of those questions have the same answer every time for a given
 * kind of record. A brief states only what is *particular* to this request;
 * the record type and its kind's recipe supply the rest.
 *
 * Deterministic and pure: the same brief over the same record type always
 * compiles to the same widget. A model's only job is to write the brief, which
 * is a handful of names it can be checked against — not a pipeline it could
 * get subtly wrong.
 *
 * The brief's own shape lives in `brief-schema.ts` and is re-exported here, so
 * every caller still imports it from one place. See that file for why.
 */

export {
  ALONGSIDE_MODES,
  WIDGET_INTENTS,
  widgetBriefSchema,
  type AlongsideMode,
  type WidgetBrief,
  type WidgetIntent,
} from "./brief-schema.js";

export interface CompileBriefInput {
  readonly brief: WidgetBrief;
  readonly entity: EntitySpec;
  /** The structural resource, which owns the endpoint a list comes from. */
  readonly resource: ResourceSpec;
  readonly connection: string;
  /** The widget's id, already made unique against the board. */
  readonly id: string;
  /**
   * The URL of the endpoint the list comes from, where the caller knows it.
   *
   * Carried for one check: a path with a parameter still in it needs an id
   * from somewhere, and a widget on a board has nowhere to get one. Without
   * this, a record type that only exists *under* another compiled happily into
   * a widget whose source was `/leases/{{param.leaseId}}/moveouts` with no
   * `leaseId` — a widget that cannot fetch, offered as though it could. On a
   * real API that was 69 of 108 record types.
   *
   * Optional because a caller that does not know the path is no worse off than
   * before; it simply does not get the check.
   */
  readonly listPath?: string | undefined;
  /**
   * The rest of the API, for a brief that names a second record type.
   *
   * Only `alongside` reads it, and its absence costs nothing else: a caller
   * that does not pass it gets exactly the single-record compiler it had, and
   * a brief that names a second record type is told plainly that it could not
   * be looked up rather than being answered with half of what was asked.
   *
   * The whole catalog rather than the one other record type, because the link
   * between two of them is derived from every reference the API records —
   * `entityGraph` reads them once, in both directions, and says what each one
   * costs to reach. Asking a caller to pre-resolve that would be asking it to
   * re-derive the answer this already holds.
   */
  readonly related?:
    | {
        readonly entities: readonly EntitySpec[];
        readonly resources: readonly ResourceSpec[];
        readonly ops: readonly GraphOp[];
      }
    | undefined;
}

export interface CompiledBrief {
  readonly widget: WidgetSpec | null;
  readonly errors: readonly string[];
  /**
   * Where the answer differs from what was asked for, in a reader's words.
   *
   * Only compromises and fallbacks: a brief that compiled exactly as stated
   * produces none. A widget that quietly did something other than what was
   * asked is the failure this whole layer exists to stop, so the difference is
   * always said out loud rather than left for somebody to notice.
   */
  readonly notes: readonly string[];
}

/**
 * A column name the pipeline can produce, from a field path that may nest.
 *
 * `fieldNameSchema` forbids dots, so `Category.Name` cannot be a column, a
 * role, a sort key or a filter until a `derive` step makes `Category_Name`.
 * Exported because every builder of widgets over entities needs exactly this
 * mapping, and two spellings of it would disagree on the day one changed.
 */
export const columnForPath = (path: string): string => path.replace(/\./g, "_");

/** How many fields a list shows before it stops being readable. */
const MAX_COLUMNS = 6;

/** The fields a reader could be shown at all. */
const visibleFields = (entity: EntitySpec): readonly EntityField[] =>
  entity.fields.filter((field) => field.visibility !== "hidden");

/**
 * The columns a list shows: what was asked for, then what the record type
 * says, then what its kind would reach for.
 */
const columnsFor = (
  entity: EntitySpec,
  asked: readonly string[] | undefined,
  known: (path: string) => boolean,
  /**
   * Fields that hold another record's identity and can be opened, in order of
   * what they cost to show. Empty where nothing described the rest of the API.
   */
  links: readonly { readonly field: string; readonly embedded: readonly string[] }[] = [],
): readonly string[] => {
  const wanted = (asked ?? []).filter(known);
  // Somebody who named the columns gets exactly those. A link they did not ask
  // for is a column they did not ask for.
  if (wanted.length > 0) return [...new Set(wanted)].slice(0, MAX_COLUMNS);

  const chosen =
    entity.views.columns.length > 0
      ? entity.views.columns
      : (() => {
          const visible = visibleFields(entity);
          const primary = visible.filter((field) => field.visibility === "primary");
          const pool = primary.length > 0 ? primary : visible;
          /*
           * The record's own name leads whatever its visibility says: a list of
           * work orders opening on an id column is a table of numbers, and the
           * name is the one column somebody reads to find the row they meant.
           */
          return [...(entity.display?.title ?? []), ...pool.map((field) => field.path)];
        })();

  /*
   * One way through to a related record, kept in the table.
   *
   * A foreign key is hidden as a *value* — nobody reads `VendorId: 55` — and
   * every column chooser drops it for that reason, which is how a work order
   * came to sit next to the vendor who did the work with no way to reach them.
   * The renderer draws it as that vendor's name, so what lands on screen is a
   * name that opens their record, not a number.
   *
   * One, not all. A record type on a real API points at four or five others,
   * and a table that is mostly links is a table of somewhere else. The first is
   * the cheapest to resolve, which is the one most likely to read as a name.
   *
   * Left out where the row already spells that record's name in a column being
   * shown — a task showing `Category.Name` needs no `Category.Id` beside it,
   * because the name itself is what carries the link.
   */
  const already = new Set(chosen);
  const link = links.find(
    (one) => !already.has(one.field) && !one.embedded.some((path) => already.has(path)),
  );
  const withLink = link ? [...chosen.slice(0, MAX_COLUMNS - 1), link.field] : chosen;
  return [...new Set(withLink)].slice(0, MAX_COLUMNS);
};

/** The first field carrying one of the semantics this kind sorts by. */
const sortFor = (
  entity: EntitySpec,
  asked: WidgetBrief["sort"],
  known: (path: string) => boolean,
): { field: string; dir: "asc" | "desc" } | null => {
  if (asked && known(asked.field)) {
    return { field: asked.field, dir: asked.dir ?? recipeFor(entity.kind).sortDir };
  }
  const chosen = defaultSort(entity);
  return chosen ? { field: chosen.field, dir: chosen.dir } : null;
};

/**
 * The fields offered as filter strips.
 *
 * Saying nothing and saying "none" are different answers, and collapsing them
 * would make a hand-built widget unable to turn the strips off: every untick
 * would land here as an empty list and be answered with the defaults, so the
 * last strip could never be removed. Absent means "choose for me"; present
 * means exactly this, even when it is empty.
 */
const filtersFor = (
  entity: EntitySpec,
  asked: readonly string[] | undefined,
  known: (path: string) => boolean,
): readonly string[] =>
  asked === undefined ? defaultFacets(entity) : [...new Set(asked.filter(known))];

/** The field a feed orders by, which it cannot render without. */
const timeFieldFor = (entity: EntitySpec): string | null => {
  if (entity.views.timeField) return entity.views.timeField;
  const found = visibleFields(entity).find((field) => field.semantic === "timestamp");
  return found?.path ?? null;
};

/**
 * The roles a list of records binds, which differ per component.
 *
 * Returns null when the component cannot be bound from what this record type
 * has — a feed with no date, say — so the caller can fall back to something
 * that renders rather than emitting a widget that fails its binding check and
 * tells the reader their data no longer matches.
 */
const listRoles = (
  component: BuiltinComponentId,
  entity: EntitySpec,
  columns: readonly string[],
): Record<string, string | string[]> | null => {
  const title = entity.display?.title?.[0];
  const subtitle = entity.display?.subtitle;
  const status = entity.display?.status;

  if (component === "table") return { columns: columns.map(columnForPath) };

  if (component === "cards" || component === "list") {
    if (!title) return null;
    const meta = columns.filter((path) => path !== title && path !== subtitle && path !== status);
    return {
      title: columnForPath(title),
      ...(subtitle ? { subtitle: columnForPath(subtitle) } : {}),
      ...(status ? { status: columnForPath(status) } : {}),
      /*
       * `cards` takes several trailing details and `list` takes one. Binding an
       * array to a role that is not multi fails the binding check, which
       * renders as "this view no longer matches its data" — a message that
       * blames the reader's data for a defect here.
       */
      ...(meta.length > 0
        ? {
            meta:
              component === "cards"
                ? meta.slice(0, 2).map(columnForPath)
                : columnForPath(meta[0] ?? ""),
          }
        : {}),
    };
  }

  if (component === "feed") {
    const time = timeFieldFor(entity);
    if (!title || !time) return null;
    return { time: columnForPath(time), title: columnForPath(title) };
  }

  return null;
};

/** The readable half of a nested record, by the names one is given. */
const NAMEISH = /^(name|title|label)$/i;

const leafOf = (path: string): string => path.split(".").pop() ?? path;

/**
 * A field, or the readable half of it when it holds a record.
 *
 * The object-valued field is the trap here, and a common one: 57 of a real
 * API's 108 record types carry at least one. A record's `Category` is an
 * object and its `Category.Name` is the word beside it, so binding the first
 * renders "[object Object]" in every cell and every filter tile — while the
 * thing somebody meant by naming it sits one level down.
 *
 * So the readable half is used wherever there is one, and silently: that is
 * not a compromise, it is the correct reading of what was asked. Null where
 * there is none, for the caller to say out loud.
 *
 * Takes the record type rather than closing over one, because a widget over
 * two of them has to resolve a field on either side by the same rule.
 */
const readableHalf = (entity: EntitySpec, path: string): string | null => {
  const field = entity.fields.find((one) => one.path === path);
  if (!field) return null;
  if (!field.kinds.includes("object") && !field.kinds.includes("array")) return path;
  const inside = entity.fields.find(
    (one) =>
      one.path.startsWith(`${path}.`) &&
      one.visibility !== "hidden" &&
      NAMEISH.test(leafOf(one.path)),
  );
  return inside?.path ?? null;
};

/* ── a second record type ───────────────────────────────────────────────── */

/** How many of the far record type's own fields fit beside a row of these. */
const MAX_JOINED_COLUMNS = 3;

/**
 * The columns a comparison of two record types agrees on.
 *
 * Stacking two sets of rows only draws a chart if they agree what their
 * columns are called, and they are different record types with different field
 * names — one bucketed by the day it was listed, the other by the day it was
 * submitted. Each side groups into these, so the component binds one pair of
 * names whatever was compared. The same three the setup card's own comparisons
 * use, deliberately: two spellings of a convention are two conventions.
 */
const PAIR_BUCKET = "bucket";
const PAIR_VALUE = "count";
const PAIR_SERIES = "series";

/** The bucket a date axis is read at, absent anybody saying otherwise. */
const DEFAULT_GRAIN = "1mo";

/**
 * A source name, from a record type's id.
 *
 * A join prefixes the far side's columns with its source name, and a column
 * name has a tighter alphabet than an id: `unit-2` is a perfectly good record
 * type id, and `unit-2_Number` is not a column anything can bind to.
 */
const handleFor = (id: string): string => {
  const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
};

/** How many of a record's rows are read for their nested collection. */
const FAN_OUT_MAX_ROWS = 25;

/** The far record type, and the endpoint that lists it. */
interface FarSide {
  readonly entity: EntitySpec;
  readonly op: string;
  /**
   * The URL parameter the primary's own id fills, for a collection that only
   * exists inside one record.
   *
   * Present exactly when the graph says the far side is reached by `path` —
   * `/leases/{leaseId}/transactions` and its sixty siblings on this API. The
   * endpoint cannot be called once for the whole account, so it is called once
   * per record instead, capped, and the cap is said out loud.
   */
  readonly perRecordParam?: string;
}

/** Either the thing, or the sentence saying why there is not one. */
type Resolved<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: string };

/**
 * The other record type a brief named, if it can be listed at all.
 *
 * The same check the primary record type gets, for the same reason: a
 * collection whose URL still has a parameter in it needs an id from somewhere,
 * and a widget on a board has nowhere to get one. Refused with the reason
 * rather than joined against an endpoint that could never be called.
 */
const farSideOf = (input: CompileBriefInput, wanted: string): Resolved<FarSide> => {
  const primary = input.entity;
  const related = input.related;
  if (!related) {
    return {
      ok: false,
      refusal: `Another record type could not be looked up here, so ${primary.name.many} are shown on their own.`,
    };
  }
  const far = entityById(related.entities, wanted);
  if (!far) {
    return {
      ok: false,
      refusal: `There is no record type here called "${wanted}", so ${primary.name.many} are shown on their own.`,
    };
  }
  if (far.id === primary.id) {
    return { ok: false, refusal: `${primary.name.many} cannot be shown alongside themselves.` };
  }
  const resource = related.resources.find((one) => one.id === far.resource);
  const listOp = resource?.listOp;
  const op = listOp ? related.ops.find((one) => one.id === listOp) : undefined;
  if (!listOp || !op) {
    return {
      ok: false,
      refusal: `${far.name.many} cannot be listed: this API has no endpoint that returns them. ${primary.name.many} are shown on their own.`,
    };
  }
  const needs = pathParamNames(op.path);
  if (needs.length > 0) {
    /*
     * A collection that only exists inside one record, reached one record at a
     * time.
     *
     * Derived from the graph rather than proposed: `scope` is the strongest
     * kind of link this model has — the API put the parent in the URL, so
     * nothing was inferred from a field name — and the reach it produces says
     * which parameter the id fills. Anything else with a parameter in its path
     * is still refused, because a widget has nowhere to get a value for it.
     */
    const graph = entityGraph({
      entities: related.entities,
      resources: related.resources,
      ops: related.ops,
    });
    const under = graph
      .backrefsOf(primary.id)
      .find(
        (one) =>
          one.entity === far.id && one.reach.mode === "path" && one.reach.op === listOp,
      );
    const param = under?.reach.mode === "path" ? under.reach.param : undefined;
    if (!param || needs.length !== 1 || needs[0] !== param) {
      return {
        ok: false,
        refusal: `${far.name.many} can only be listed for one record at a time, so they cannot be shown beside every ${primary.name.one}.`,
      };
    }
    return { ok: true, value: { entity: far, op: listOp, perRecordParam: param } };
  }
  return { ok: true, value: { entity: far, op: listOp } };
};

/** Where two record types match, in each side's own spelling. */
interface JoinOn {
  /** The field on these records. A path: the widget flattens it to a column. */
  readonly left: string;
  /** The field on the far records, likewise. */
  readonly right: string;
  /** Said out loud when more than one field could have linked the two. */
  readonly note: string | null;
}

/**
 * The field two record types match on — never asked for, always derived.
 *
 * Both directions of every relationship are already recorded, with the field
 * carrying each one and what it costs to reach. A model asked to write a join
 * key would be guessing at something the API has already stated, and a join on
 * a guess pairs rows that have nothing to do with each other — which reads
 * exactly like data, because every row in it is real.
 */
const joinOn = (
  input: CompileBriefInput,
  far: EntitySpec,
  /** Set when the far collection is fetched one primary record at a time. */
  perRecord = false,
): Resolved<JoinOn> => {
  const primary = input.entity;
  const related = input.related;
  if (!related) return { ok: false, refusal: `Nothing links ${primary.name.many} to ${far.name.many}.` };

  const graph = entityGraph({
    entities: related.entities,
    resources: related.resources,
    ops: related.ops,
  });

  /*
   * A collection fetched per record is matched back by what its own rows say.
   *
   * The fan-out already asks the right question — these are that lease's
   * transactions — but the answers all arrive in one pile, and nothing on a
   * row says which request brought it unless the row itself carries the
   * parent's id. Where it does not, this is refused rather than paired on
   * position, because rows in the wrong order are still real rows and read
   * exactly like data.
   */
  if (perRecord) {
    const left = primary.identity?.field;
    if (!left) {
      return {
        ok: false,
        refusal: `Nothing on ${primary.name.one} holds its own identity, so ${far.name.many} could not be looked up for one.`,
      };
    }
    const back = graph.referencesOf(far.id).find((one) => one.target === primary.id);
    if (!back) {
      return {
        ok: false,
        refusal: `${far.name.many} are listed under one ${primary.name.one} at a time, and their rows carry nothing saying which one — so they could not be put beside the right ${primary.name.one}.`,
      };
    }
    return { ok: true, value: { left, right: back.field, note: null } };
  }

  /*
   * This record pointing at the far one comes first.
   *
   * The two directions describe one relationship, and this is the half that
   * does not multiply rows: a task has one vendor, so a task beside its vendor
   * is still one row per task. Read the other way round, a vendor with eleven
   * tasks is eleven rows — relationally correct, reported by the runtime, and
   * rarely what somebody picturing the two together had in mind.
   */
  const outgoing = graph.referencesOf(primary.id).filter((one) => one.target === far.id);
  const chosen = outgoing[0];
  if (chosen) {
    const field = primary.fields.find((one) => one.path === chosen.field);
    const reference = field?.reference;
    const right = far.identity?.field;
    if (!right) {
      return {
        ok: false,
        refusal: `Nothing on ${far.name.one} holds its own identity, so there is nothing for ${primary.name.many} to be matched against.`,
      };
    }
    if (!field || !reference) {
      return { ok: false, refusal: `Nothing links ${primary.name.many} to ${far.name.many}.` };
    }
    return {
      ok: true,
      value: {
        left: linkColumn(field, reference),
        right,
        /*
         * Two fields pointing at the same record type are two relationships —
         * "created by" and "assigned to" are not the same question — so which
         * of them was read is part of the answer rather than a detail.
         */
        note:
          outgoing.length > 1
            ? `${far.name.many} are matched on ${field.label ?? field.path}, one of the ${outgoing.length} fields ${primary.name.one} has that point at one.`
            : null,
      },
    };
  }

  /*
   * Failing that, the far rows carrying this record's id.
   *
   * Only where the API can narrow them by it. A link inferred from a field
   * name alone is one nothing has confirmed, and matching on it pairs rows
   * that may have no relationship at all — again indistinguishable from data.
   */
  const incoming = graph.backrefsOf(primary.id).filter((one) => one.entity === far.id);
  const back = incoming.find((one) => one.reach.mode === "filter");
  if (!back) {
    return {
      ok: false,
      refusal:
        incoming.length > 0
          ? `Nothing on this API pairs ${far.name.many} with one ${primary.name.one}, so the two would have to be matched on a guess. ${primary.name.many} are shown on their own.`
          : `Nothing links ${primary.name.many} to ${far.name.many}, so they are shown on their own.`,
    };
  }
  const left = primary.identity?.field;
  if (!left) {
    return {
      ok: false,
      refusal: `Nothing on ${primary.name.one} holds its own identity, so ${far.name.many} could not be matched to it.`,
    };
  }
  return {
    ok: true,
    value: {
      left,
      right: back.field,
      note:
        incoming.length > 1
          ? `${far.name.many} are matched on ${back.field}, one of the ${incoming.length} fields they have that point at ${primary.name.one}.`
          : null,
    },
  };
};

/**
 * The field the far rows are broken down by, for two measurements on one axis.
 *
 * A comparison needs no link — neither set of rows is an attribute of the
 * other — but it does need an axis both sides can be read along. The same
 * field on both is one plainly; failing that, a date on each side is, because
 * bucketed to the same grain two dates are the same axis whatever either is
 * called. Anything else is refused: an x-axis meaning something different on
 * each series is the most confidently wrong thing this could draw.
 */
const axisOn = (far: EntitySpec, primary: EntityField): Resolved<string> => {
  const same = far.fields.find((one) => one.path === primary.path && one.visibility !== "hidden");
  if (same) return { ok: true, value: same.path };
  if (primary.semantic === "timestamp") {
    const time =
      far.views.timeField ??
      far.fields.find((one) => one.semantic === "timestamp" && one.visibility !== "hidden")?.path;
    if (time) return { ok: true, value: time };
  }
  return {
    ok: false,
    refusal: `Nothing on ${far.name.one} matches ${primary.label ?? primary.path}, so the two could not be put on one axis.`,
  };
};

/**
 * A brief, as a widget.
 *
 * Every name the brief mentions is checked against the record type's own
 * fields. One it does not have is dropped and said out loud, never
 * approximated to the nearest match — a widget that silently filtered on some
 * other column would be confidently, invisibly wrong.
 */
export const compileBrief = (input: CompileBriefInput): CompiledBrief => {
  const { brief, entity, resource, connection } = input;
  const errors: string[] = [];
  const notes: string[] = [];

  const listOp = resource.listOp;
  if (!listOp) {
    return {
      widget: null,
      errors: [`${entity.name.many} cannot be listed: this API has no endpoint that returns them.`],
      notes: [],
    };
  }

  /*
   * A collection that only exists under another record.
   *
   * Its URL still has a parameter in it, and a widget sitting on a board has
   * nothing to fill that from — so the widget could be built and could never
   * fetch. Refused with the reason rather than emitted and left to fail at the
   * first request, which is the difference between "these are reachable from a
   * lease" and a permanently empty box.
   *
   * These records are not unreachable: they are a *section* on the parent's
   * record page, which is exactly where `entityGraph` already puts them.
   */
  const needs = input.listPath ? pathParamNames(input.listPath) : [];
  if (needs.length > 0) {
    const parent = entity.scope?.parent;
    return {
      widget: null,
      errors: [
        parent
          ? `${entity.name.many} belong to one ${parent}, so they are shown on that record's own page rather than as a widget of their own.`
          : `${entity.name.many} can only be listed for one record at a time, so they are shown on that record's page rather than as a widget of their own.`,
      ],
      notes: [],
    };
  }

  const byPath = new Map(entity.fields.map((field) => [field.path, field]));
  const known = (path: string): boolean => byPath.has(path);

  /**
   * A named field, resolved to something a component can actually bind.
   *
   * `what` names the part of the widget for a note, or is null when nobody
   * asked for this field and a default simply did not work out — an unusable
   * default is not worth a sentence, because nobody wondered where it went.
   */
  const bind = (path: string, what: string | null): string | null => {
    const field = byPath.get(path);
    if (!field) {
      if (what) {
        notes.push(
          `"${path}" is not a field ${entity.name.one} has, so it was left out of the ${what}.`,
        );
      }
      return null;
    }
    const readable = readableHalf(entity, path);
    if (readable) return readable;
    if (what) {
      notes.push(
        `"${field.label ?? path}" holds a record rather than a value, so it was left out of the ${what}.`,
      );
    }
    return null;
  };

  /*
   * A name that matches nothing is explained here, before anything falls back
   * to a default. The choosers below drop an unknown name while deciding
   * whether the request named anything usable at all, so by the time a list is
   * resolved there is nothing left to write a sentence about.
   */
  const explainUnknown = (paths: readonly string[], what: string): void => {
    for (const path of paths) if (!known(path)) bind(path, what);
  };
  const askedFilters = brief.filters ?? [];
  const askedFilterPaths = brief.filters?.map((one) => one.field);
  explainUnknown(brief.columns ?? [], "columns");
  explainUnknown(askedFilterPaths ?? [], "filters");
  if (brief.sort) explainUnknown([brief.sort.field], "sort");

  const recipe = recipeFor(entity.kind);
  const askedColumns = new Set(brief.columns ?? []);
  /** Resolve a chosen list, explaining only the fields somebody actually named. */
  const bindAll = (paths: readonly string[], asked: ReadonlySet<string>, what: string): string[] => [
    ...new Set(paths.flatMap((path) => bind(path, asked.has(path) ? what : null) ?? [])),
  ];

  /*
   * The ways through to another record, cheapest first.
   *
   * Derived from the graph rather than from the field list: whether a
   * reference can be *opened* is a fact about the endpoints on the other side,
   * and one that cannot be is a column of bare ids.
   */
  const COST_FIRST = { free: 0, cheap: 1, partial: 2 } as const;
  const openable = input.related
    ? entityGraph({
        entities: input.related.entities,
        resources: input.related.resources,
        ops: input.related.ops,
      })
        .referencesOf(entity.id)
        .filter(
          (reference) =>
            reference.reach !== null &&
            known(reference.field) &&
            /*
             * A list of ids has no single record to open — the cell renders as
             * "3 bills" and correctly refuses to be a link — and a field this
             * widget cannot bind is not a column at all.
             */
            reference.holds !== "array" &&
            bind(reference.field, null) !== null,
        )
        .slice()
        /*
         * One whose name can actually be resolved, first.
         *
         * A reference the row already spells is marked `free` — but only if
         * the *name* is a column, and these columns are chosen before anything
         * flattens one. Preferring it would put an id on screen that reads
         * "Task 9" until something fetches the task, which is the opposite of
         * free. A plain id resolves to a name through the lookup every
         * reference column already uses.
         */
        .sort(
          (a, b) =>
            (a.embedded.length > 0 ? 1 : 0) - (b.embedded.length > 0 ? 1 : 0) ||
            /*
             * This record's own field beats one sitting inside another record
             * it carries: a work order points at a vendor itself, and reaches
             * a lease only through the task it belongs to. The first is a
             * relationship somebody would name; the second is a detour.
             */
            a.field.split(".").length - b.field.split(".").length ||
            COST_FIRST[a.cost] - COST_FIRST[b.cost],
        )
        .map((reference) => ({ field: reference.field, embedded: reference.embedded }))
    : [];

  const columns = bindAll(
    columnsFor(entity, brief.columns, known, openable),
    askedColumns,
    "columns",
  );

  /*
   * Filters, and what each starts narrowed to.
   *
   * Resolved together because a named field may remap — `Category` means the
   * name inside it — and the values asked for have to follow it there, or the
   * scope phrase silently stops applying.
   */
  const filters: string[] = [];
  const preselect = new Map<string, readonly string[]>();
  /** Field path → the closed set the API declares for it, where it declares one. */
  const declaredValues = new Map<string, readonly string[]>();
  const boundFilters = new Set<string>();
  for (const path of filtersFor(entity, askedFilterPaths, known)) {
    /*
     * Capped where a widget caps them.
     *
     * Found by building one: a real record type matches half a dozen fields
     * that could be narrowed by — a status, a type, a category, the type of
     * two different things it points at — and a widget takes three. Emitting
     * more produced a widget that failed its own parse, and every test passed
     * because no fixture had enough fields to reach the limit.
     *
     * Capped after binding rather than before, so a field that resolves to
     * nothing does not use up one of the three.
     */
    if (filters.length >= FACET_MAX_PER_WIDGET) break;
    const asked = askedFilters.find((one) => one.field === path);
    const bound = bind(path, asked ? "filters" : null);
    if (!bound || boundFilters.has(bound)) continue;
    boundFilters.add(bound);
    filters.push(bound);
    const stated = entity.fields.find((one) => one.path === path)?.values ?? [];
    if (stated.length > 0) declaredValues.set(bound, stated.slice(0, FACET_MAX_VALUES));
    if (asked?.values && asked.values.length > 0) preselect.set(bound, asked.values);
  }

  /*
   * Columns read through a reference.
   *
   * Only where the field really points at another record: following something
   * that is not a reference would fetch nothing and leave a column that is
   * blank forever, which looks exactly like a value this record happens not to
   * have.
   */
  const linked: { through: string; field: string; as: string; label?: string }[] = [];
  /** The paths those go through, which the pipeline has to produce as columns. */
  const throughPaths: string[] = [];
  for (const one of brief.intent === "records" ? (brief.linked ?? []) : []) {
    const field = byPath.get(one.through);
    if (!field?.reference) {
      notes.push(
        `"${field?.label ?? one.through}" does not point at another record, so nothing could be read through it.`,
      );
      continue;
    }
    throughPaths.push(one.through);
    linked.push({
      through: columnForPath(one.through),
      field: one.field,
      as: columnForPath(`${one.through}.${one.field}`),
      ...(one.label ? { label: one.label } : {}),
    });
  }

  const chosenSort = sortFor(entity, brief.sort, known);
  const sortField = chosenSort ? bind(chosenSort.field, brief.sort ? "sort" : null) : null;
  const sort = chosenSort && sortField ? { field: sortField, dir: chosenSort.dir } : null;
  /* ── a second record type, where one was named ──────────────────────── */

  /*
   * Resolved before the widget takes shape, because it changes what the widget
   * *is*: a join reads as a table whatever this kind of record usually reads
   * as, and a comparison is two sources stacked rather than one grouped.
   *
   * A refusal here is a note rather than an error. The record type named first
   * is still a good answer to most of what was asked, and refusing the whole
   * request over the half that could not be built would hand back nothing at
   * all — so the widget is built without it, and why is said out loud.
   */
  const wanted = brief.alongside;
  const mode: AlongsideMode = wanted?.as ?? "join";
  let pair: {
    readonly far: EntitySpec;
    readonly op: string;
    readonly on?: JoinOn;
    /** Set when the far collection is read one primary record at a time. */
    readonly perRecordParam?: string;
  } | null = null;
  if (wanted) {
    const side = farSideOf(input, wanted.entity);
    if (!side.ok) {
      notes.push(side.refusal);
    } else if (mode === "join" && brief.intent !== "records") {
      /*
       * A join multiplies rows, and a number over multiplied rows counts the
       * pairs rather than the records. Nobody asking how many tasks there are
       * means "how many task-and-vendor pairings", so the join is dropped and
       * the number stays a number.
       */
      notes.push(
        `${side.value.entity.name.many} were left out: joining them on would count ${entity.name.many} once for each match rather than once each.`,
      );
    } else if (mode === "beside" && brief.intent !== "compare") {
      notes.push(
        `${entity.name.many} and ${side.value.entity.name.many} can only be set against each other as a chart, so ${side.value.entity.name.many} were left out.`,
      );
    } else if (mode === "join") {
      const on = joinOn(input, side.value.entity, side.value.perRecordParam !== undefined);
      if (!on.ok) notes.push(on.refusal);
      else {
        if (on.value.note) notes.push(on.value.note);
        pair = {
          far: side.value.entity,
          op: side.value.op,
          on: on.value,
          ...(side.value.perRecordParam ? { perRecordParam: side.value.perRecordParam } : {}),
        };
        if (side.value.perRecordParam) {
          /*
           * The price, on the widget rather than discovered in a rate-limit
           * error. One request per record is the honest degradation this kind
           * of link has — the same shape the join's own caveats take — and a
           * cap that truncates in silence is the outcome this product refuses.
           */
          notes.push(
            `${side.value.entity.name.many} are listed one ${entity.name.one} at a time, so the first ${FAN_OUT_MAX_ROWS} ${entity.name.many} are read for theirs — ${FAN_OUT_MAX_ROWS} extra requests, and any ${entity.name.one} past them shows none.`,
          );
        }
      }
    } else {
      /* A comparison needs no link — only an axis, settled with the grouping. */
      pair = { far: side.value.entity, op: side.value.op };
    }
  }

  /**
   * What the two sources are called.
   *
   * The far side's columns are prefixed with its name, unconditionally, so a
   * joined row says which record each value came from. Two record types whose
   * ids differ only in a character a column name cannot carry would collide
   * here, which the parse would reject as one source named twice — so the
   * second is nudged rather than left to fail.
   */
  const leftAs = handleFor(entity.id);
  const rightAs =
    pair && handleFor(pair.far.id) === leftAs ? `${handleFor(pair.far.id)}_2` : pair ? handleFor(pair.far.id) : "";

  /**
   * The far record type's own columns, for a joined row to carry.
   *
   * Its own defaults, never anything the brief named: a brief's field names
   * are checked against the record type it is about, and letting them land on
   * either side would make "Name" mean whichever of the two happened to have
   * one. Three of them, because the point of the join is the record in front
   * of you with something true of it beside — not two tables in one.
   */
  const farColumns =
    pair?.on !== undefined
      ? [
          ...new Set(
            columnsFor(pair.far, undefined, (path) =>
              pair!.far.fields.some((one) => one.path === path),
            ).flatMap((path) => readableHalf(pair!.far, path) ?? []),
          ),
        ].slice(0, MAX_JOINED_COLUMNS)
      : [];

  /* ── what kind of widget, and what it binds ─────────────────────────── */

  let component: BuiltinComponentId;
  let roles: Record<string, string | string[]>;
  const shape: {
    groupBy: WidgetShape["groupBy"];
    measures: WidgetShape["measures"];
    sort: WidgetShape["sort"];
    limit?: number;
  } = { groupBy: [], measures: [], sort: [] };

  const measure = brief.measure ?? { agg: "count" as const };
  if (measure.agg !== "count" && !measure.field) {
    errors.push(`A ${measure.agg} needs a field to add up; only a count can leave one out.`);
  }
  if (measure.field && !known(measure.field)) {
    errors.push(`"${measure.field}" is not a field ${entity.name.one} has, so it cannot be totalled.`);
  }
  /*
   * A record cannot be added up, and the name inside it certainly cannot. This
   * is the one place `bind` must not quietly reach for the readable half.
   */
  if (measure.field && byPath.get(measure.field)?.kinds.some((kind) => kind === "object" || kind === "array")) {
    errors.push(
      `"${byPath.get(measure.field)?.label ?? measure.field}" holds a record rather than a number, so it cannot be totalled.`,
    );
  }

  /** The column a comparison breaks its number down by, once resolved. */
  let groupColumn: string | null = null;
  /** The field the far rows are bucketed by, when two are being compared. */
  let farAxis: string | null = null;
  /** The grain a date axis is read at, or none when the axis is not a date. */
  let bucket: string | null = null;

  if (brief.intent === "compare") {
    const by = brief.groupBy;
    component = "bar";
    roles = {};
    if (!by) {
      errors.push("A comparison needs something to break the number down by.");
    } else if (!known(by)) {
      errors.push(`"${by}" is not a field ${entity.name.one} has, so it cannot be compared across.`);
    } else {
      groupColumn = bind(by, null);
      if (!groupColumn) {
        errors.push(
          `"${byPath.get(by)?.label ?? by}" holds a record rather than a value, so a number cannot be broken down by it.`,
        );
      } else {
        const axisField = byPath.get(groupColumn);
        /*
         * A date axis is bucketed, and a bucketed one is a time series.
         *
         * Grouping on a raw timestamp makes one bar per distinct moment, which
         * is not a comparison of anything — every bar is 1. Nobody says "by
         * month" out loud because nobody imagines the alternative, so the
         * grain is chosen here and named in a note rather than asked about.
         */
        if (axisField?.semantic === "timestamp") bucket = DEFAULT_GRAIN;

        /*
         * The far side of a comparison: an axis it can be read along, and a
         * number it can produce. Refused rather than approximated, and the
         * chart falls back to the one record type it can honestly draw.
         */
        if (pair && mode === "beside" && axisField) {
          const axis = axisOn(pair.far, axisField);
          const totalled =
            measure.field === undefined ||
            pair.far.fields.some((one) => one.path === measure.field);
          if (!axis.ok) {
            notes.push(axis.refusal);
            pair = null;
          } else if (!totalled) {
            notes.push(
              `${pair.far.name.many} have no ${byPath.get(measure.field ?? "")?.label ?? measure.field} to add up, so the two could not be set against each other.`,
            );
            pair = null;
          } else {
            farAxis = axis.value;
            if (bucket) {
              notes.push(
                `${entity.name.many} and ${pair.far.name.many} are counted by month, which is the axis they share.`,
              );
            }
          }
        } else if (bucket) {
          notes.push(
            `${entity.name.many} are counted by month: ${axisField?.label ?? groupColumn} is a date, and one bar per moment compares nothing.`,
          );
        }

        const stacked = pair !== null && mode === "beside";
        const axisColumn = stacked ? PAIR_BUCKET : columnForPath(groupColumn);
        const valueColumn = stacked ? PAIR_VALUE : "value";
        component = bucket ? "timeseries" : "bar";
        shape.groupBy = [
          {
            field: columnForPath(groupColumn),
            ...(bucket ? { bucket } : {}),
            ...(stacked ? { as: PAIR_BUCKET } : {}),
          },
        ];
        shape.measures = [
          {
            as: valueColumn,
            agg: measure.agg,
            ...(measure.field ? { field: columnForPath(measure.field) } : {}),
          },
        ];
        roles = {
          [bucket ? "time" : "category"]: axisColumn,
          value: valueColumn,
          ...(stacked ? { series: PAIR_SERIES } : {}),
        };
      }
    }
  } else if (brief.intent === "measure") {
    component = "stat";
    /*
     * No grouping: `shapeSteps` totals every row by grouping on a constant,
     * which is how the pipeline says "all of them" without a special case.
     */
    shape.measures = [{ as: "value", agg: measure.agg, ...(measure.field ? { field: columnForPath(measure.field) } : {}) }];
    roles = { value: "value" };
  } else {
    /*
     * What was asked for, else what this kind of record reads best as. A view
     * that cannot be bound from what the record carries falls through to the
     * table below, with the reason, exactly as an unbindable default does.
     */
    component = brief.view ?? recipe.component;
    /*
     * A join reads as a table, whatever this kind of record usually reads as.
     * The far record's fields arrive as columns, and a card has no honest slot
     * for "one more column" — the same reason a linked field only lands on a
     * table.
     */
    if (pair?.on && component !== "table") {
      notes.push(
        `${entity.name.many} are shown as a table, because ${pair.far.name.many} bring columns of their own.`,
      );
      component = "table";
    }
    const bound = listRoles(component, entity, columns);
    if (bound) {
      roles = bound;
    } else {
      /*
       * The kind's preferred reading cannot be bound from what this record
       * type carries — a feed with no date on it, a card with no name. A table
       * of the same columns always can, and saying so beats a widget that
       * renders as a binding error.
       */
      notes.push(
        `${entity.name.many} are shown as a table: ${
          component === "feed"
            ? `nothing on ${entity.name.one} says when it happened`
            : `nothing on ${entity.name.one} says what to call one`
        }.`,
      );
      component = "table";
      roles = { columns: columns.map(columnForPath) };
    }
    if (sort) shape.sort = [{ field: columnForPath(sort.field), dir: sort.dir }];
    /*
     * A linked field is a column like any other once it exists, so it goes
     * where the columns go. Only on a table: the other readings bind named
     * roles, and there is no honest slot for "one more column" in a card.
     */
    if (linked.length > 0 && component === "table") {
      const bound = roles.columns;
      roles = {
        ...roles,
        columns: [...(Array.isArray(bound) ? bound : []), ...linked.map((one) => one.as)],
      };
    }
    /* The far record's columns, under the name the join gives them. */
    if (farColumns.length > 0 && component === "table") {
      const bound = roles.columns;
      roles = {
        ...roles,
        columns: [
          ...(Array.isArray(bound) ? bound : []),
          ...farColumns.map((path) => `${rightAs}_${columnForPath(path)}`),
        ],
      };
    }
  }

  if (brief.limit !== undefined) shape.limit = brief.limit;

  /* ── the pipeline ───────────────────────────────────────────────────── */

  /*
   * Every path this widget mentions, flattened in one place. A nested field is
   * not a column until a derive step makes one, and the naming is the same
   * mapping `derivedSources` reads back — so a reference on a nested field
   * still resolves to the record it points at.
   */
  const mentioned =
    brief.intent === "records"
      ? [
          ...columns,
          ...filters,
          ...(sort ? [sort.field] : []),
          ...throughPaths,
          /* The field the join matches on is a column before it is a key. */
          ...(pair?.on ? [pair.on.left] : []),
        ]
      : [...(groupColumn ? [groupColumn] : []), ...(measure.field ? [measure.field] : [])];
  const nested = [...new Set(mentioned.filter((path) => path.includes(".")))];
  const deriveFields: Record<string, string> = Object.fromEntries(
    nested.map((path) => [columnForPath(path), path]),
  );
  /*
   * An empty column for each linked field.
   *
   * The value lives on another record and arrives at render time, but a role
   * cannot bind to a column the pipeline never produced — the binding check
   * would fail and the widget would read as "this view no longer matches its
   * data". So the column is made, empty, and filled in when the record it
   * belongs to lands.
   */
  for (const one of linked) deriveFields[one.as] = "null";
  const derive: PipelineStep[] =
    Object.keys(deriveFields).length > 0 ? [{ op: "derive", fields: deriveFields }] : [];

  /*
   * How to read the values, from what the record type says they are.
   *
   * A pipeline reads what the endpoint sent: an ISO date is a string until
   * something turns it into a moment, and minor units are a plain number until
   * something divides them. Nothing here guesses — the safe half is derived
   * from the format the API itself declared, and the half that cannot be
   * derived is whatever somebody confirmed onto the field.
   *
   * Only the columns this widget actually carries. Coercing a column the
   * pipeline never produced would name a field the rows have not got.
   */
  const readingOf = (
    of: EntitySpec,
    paths: Iterable<string>,
    name: (path: string) => string,
  ): { coercions: Record<string, Coercion>; format: Record<string, { semantic: SemanticType }> } => {
    const coercions: Record<string, Coercion> = {};
    const format: Record<string, { semantic: SemanticType }> = {};
    for (const path of new Set(paths)) {
      const field = of.fields.find((one) => one.path === path);
      if (!field) continue;
      const coercion = field.coercion ?? coercionForFormat(field.format);
      if (!coercion) continue;
      coercions[name(path)] = coercion;
      /*
       * What the coercion implies, said out loud on the widget rather than
       * left for the renderer to infer from a column's name — which is how a
       * date called `Period` renders as the string it arrived as.
       */
      const semantic = COERCION_SEMANTICS[coercion];
      if (semantic) format[name(path)] = { semantic };
    }
    return { coercions, format };
  };

  /**
   * A comparison's axis, read as a label where the API sends a number.
   *
   * A bar's category is a name by definition, and a chart grouped by `userId`
   * binds its category to a numeric column — which the contract refuses, so
   * the widget compiled cleanly and then rendered "no longer matches its
   * data". Found on the first API with numeric ids to group by; the one before
   * it only ever grouped by names.
   *
   * Only where the field is recorded as holding a number or a boolean, and
   * never on a bucketed date, which is a time axis and wants the number. A
   * field that already holds text is left alone, so nothing that worked
   * before gains a step — or a different digest.
   */
  const axisAsLabel = (of: EntitySpec, path: string | null): Record<string, Coercion> => {
    if (brief.intent !== "compare" || bucket || !path) return {};
    const field = of.fields.find((one) => one.path === path);
    if (!field || field.coercion || coercionForFormat(field.format)) return {};
    return field.kinds.some((kind) => kind === "number" || kind === "boolean")
      ? { [columnForPath(path)]: "->string" }
      : {};
  };

  const own = readingOf(entity, mentioned, columnForPath);
  const coercions = { ...own.coercions, ...axisAsLabel(entity, groupColumn) };
  const readAs = own.format;
  const coerce: PipelineStep[] =
    Object.keys(coercions).length > 0 ? [{ op: "coerce", fields: coercions }] : [];

  /** The same flattening, for the far side's own field names. */
  const farDerive = (paths: readonly string[]): PipelineStep[] => {
    const fields = Object.fromEntries(
      [...new Set(paths.filter((path) => path.includes(".")))].map((path) => [
        columnForPath(path),
        path,
      ]),
    );
    return Object.keys(fields).length > 0 ? [{ op: "derive", fields }] : [];
  };

  const shaped = shapeSteps({
    groupBy: shape.groupBy,
    measures: shape.measures,
    sort: shape.sort,
    ...(shape.limit !== undefined ? { limit: shape.limit } : {}),
  });

  /*
   * One source or two, and what each of them does before they meet.
   *
   * Each source extracts its own rows and flattens its own field names, which
   * has to happen before the combine rather than after: the join prefixes the
   * far side's *top-level* keys, so a nested object left unflattened arrives
   * as one prefixed column holding a record — every value still in there and
   * none of them bindable.
   */
  let sources: Record<string, unknown>[] = [];
  let combine: Record<string, unknown> | null = null;
  let pipeline: PipelineStep[];

  /*
   * The far side's own reading of its own fields, named as the join will
   * prefix them so the format map matches the columns the rows carry.
   */
  const farReading =
    pair?.on !== undefined
      ? readingOf(pair.far, [pair.on.right, ...farColumns], columnForPath)
      : { coercions: {}, format: {} };

  if (pair?.on) {
    sources = [
      {
        as: leftAs,
        connection,
        op: listOp,
        params: {},
        label: entity.name.many,
        pipeline: [{ op: "extract", path: "$" }, ...derive, ...coerce],
      },
      {
        as: rightAs,
        connection,
        op: pair.op,
        params: {},
        label: pair.far.name.many,
        /*
         * One request per record, because the endpoint has no other form. The
         * cap is the spec's own, and it is reported as a caveat above rather
         * than trimming the answer without saying so.
         */
        ...(pair.perRecordParam
          ? {
              fanOut: {
                from: leftAs,
                field: columnForPath(pair.on.left),
                as: pair.perRecordParam,
                maxRows: FAN_OUT_MAX_ROWS,
              },
            }
          : {}),
        /*
         * Narrowed to what the join needs and what it shows. A record type has
         * every field it has, and carrying all of them through a join to drop
         * them at the component costs memory per matched row for nothing.
         */
        pipeline: [
          { op: "extract", path: "$" },
          ...farDerive([pair.on.right, ...farColumns]),
          /*
           * The far record's values read by its own record type, before the
           * join prefixes its columns — otherwise a date on one side of a
           * joined row renders as a date and the other as the string it
           * arrived as, which is the same widget disagreeing with itself.
           */
          ...(Object.keys(farReading.coercions).length > 0
            ? [{ op: "coerce" as const, fields: farReading.coercions }]
            : []),
          {
            op: "select",
            fields: [
              ...new Set([pair.on.right, ...farColumns].map((path) => columnForPath(path))),
            ],
          },
        ],
      },
    ];
    combine = {
      op: "join",
      left: leftAs,
      right: rightAs,
      on: { left: columnForPath(pair.on.left), right: columnForPath(pair.on.right) },
      /*
       * Kept, never dropped. An inner join deletes the rows that matched
       * nothing, which on a record type where the link is often empty is most
       * of them — and a widget that is quietly short of half its records says
       * nothing about why. The runtime reports both the misses and the
       * multiplications against the real rows.
       */
      kind: "left",
    };
    /* The rows arrive joined and already extracted; only the shaping is left. */
    pipeline = [...shaped];
  } else if (pair && farAxis && groupColumn) {
    /** One side of a comparison, grouped into the shared column names. */
    const side = (
      axis: string,
      flatten: readonly string[],
      of: EntitySpec,
    ): PipelineStep[] => {
      // Each side reads its own axis by its own record type's account of it.
      const fields = { ...coercions, ...axisAsLabel(of, axis) };
      return [
        { op: "extract", path: "$" },
        ...farDerive(flatten),
        ...(Object.keys(fields).length > 0 ? [{ op: "coerce" as const, fields }] : []),
        ...shapeSteps({
          groupBy: [
            { field: columnForPath(axis), ...(bucket ? { bucket } : {}), as: PAIR_BUCKET },
          ],
          measures: [
            {
              as: PAIR_VALUE,
              agg: measure.agg,
              ...(measure.field ? { field: columnForPath(measure.field) } : {}),
            },
          ],
          sort: [],
        }),
      ];
    };
    sources = [
      {
        as: leftAs,
        connection,
        op: listOp,
        params: {},
        label: entity.name.many,
        pipeline: side(groupColumn, [groupColumn, ...(measure.field ? [measure.field] : [])], entity),
      },
      {
        as: rightAs,
        connection,
        op: pair.op,
        params: {},
        label: pair.far.name.many,
        pipeline: side(farAxis, [farAxis, ...(measure.field ? [measure.field] : [])], pair.far),
      },
    ];
    combine = { op: "union", as: PAIR_SERIES };
    /*
     * Both sides arrive already reduced, so nothing is regrouped here — that
     * would collapse the two series back into one. Ordering the stacked rows
     * is all the widget itself has left to do.
     */
    pipeline = [
      { op: "sort", by: [{ field: PAIR_BUCKET, dir: "asc" }] },
      ...(shape.limit !== undefined ? [{ op: "limit" as const, count: shape.limit, from: "start" as const }] : []),
    ];
  } else {
    /*
     * Flatten, then read, then shape. A coercion names a column, so it has to
     * come after the derive that produces one — and before the grouping, or a
     * date would be bucketed as the string it arrived as.
     */
    pipeline = [{ op: "extract", path: "$" }, ...derive, ...coerce, ...shaped];
  }

  if (errors.length > 0) return { widget: null, errors, notes };

  /*
   * Filter strips only where there are records to narrow. After a grouping the
   * rows are buckets rather than records, so a strip would filter the chart's
   * own bars — which is not what anybody means by a filter.
   */
  const facets =
    brief.intent === "records"
      ? filters.map((path) => {
          const chosen = preselect.get(path) ?? [];
          /*
           * The values the API itself declares for this field, where it does.
           *
           * The one thing a sample cannot establish: rows show the values an
           * account happens to have, so a strip built from them alone has no
           * tile for the status nobody is currently in — and "Overdue 0" is a
           * useful thing to be able to see. Anything the declaration missed
           * still gets a tile, because `other` shows by default, so a stale
           * enum costs a row of "Other" rather than a hidden record.
           */
          const declared = declaredValues.get(path) ?? [];
          return {
            field: columnForPath(path),
            ...(declared.length > 0
              ? { values: declared.map((value) => ({ value })) }
              : {}),
            /*
             * Where a scope phrase lands: the strip starts narrowed, and the
             * reader can see what to and widen it. A value matching nothing is
             * dropped by the strip, so this never hides every row.
             */
            ...(chosen.length > 0 ? { default: [...chosen] } : {}),
          };
        })
      : [];

  const parsed = parseWidget({
    id: input.id,
    title: brief.title?.trim() || entity.name.many,
    component,
    /*
     * Carried on the widget so it can be changed later. Everything below is
     * derived from it, so storing the derivation without what it came from is
     * what made a finished widget uneditable.
     */
    brief,
    /*
     * Stacked rows are two record types at once, so naming either of them
     * would be a claim about rows that are not its own — and every one of
     * them is a bucket rather than a record in any case.
     */
    ...(combine?.op === "union" ? {} : { entity: entity.id }),
    ...(sources.length > 0
      ? { sources, ...(combine ? { combine } : {}) }
      : { source: { connection, op: listOp, params: {} } }),
    pipeline,
    roles,
    /*
     * How each column reads, where the record type says something about it.
     * The bucket of a time axis is a column the grouping invented, so it is
     * named here rather than found among the record type's fields.
     */
    ...(Object.keys(readAs).length > 0 || Object.keys(farReading.format).length > 0 || bucket
      ? {
          format: {
            ...readAs,
            ...Object.fromEntries(
              Object.entries(farReading.format).map(([column, spec]) => [
                `${rightAs}_${column}`,
                spec,
              ]),
            ),
            ...(bucket
              ? { [combine ? PAIR_BUCKET : columnForPath(groupColumn ?? "")]: { semantic: "timestamp" as const } }
              : {}),
          },
        }
      : {}),
    ...(facets.length > 0 ? { facets } : {}),
    ...(linked.length > 0 ? { linked } : {}),
  });

  return parsed.value
    ? { widget: parsed.value, errors: [], notes }
    : { widget: null, errors: parsed.errors, notes };
};
