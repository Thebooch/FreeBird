import type { ComponentContract, ParamDef, RoleContract } from "@freebirdai/dash-spec";
import {
  COMPONENT_CONTRACTS,
  PRESENTATION_MANIFESTS,
  contractFor,
  fieldLabel,
  humanLabel,
  isEmptyShape,
  rolesForShape,
  statusTone,
} from "@freebirdai/dash-spec";
import { componentFits, fieldsForRole, valueTypesOf, type BindableField } from "../bind.js";
import type { FieldInfo, InferredShape } from "../infer.js";
import { highlightCandidates, nounFromTitle } from "../suggest.js";
import {
  ROLE_STEP,
  applyAnswer,
  isRoleStep,
  roleOfStep,
  type ConciergeDraft,
} from "./draft.js";

/**
 * Every question the concierge asks, derived from what is actually there.
 *
 * This file contains no domain vocabulary and must never gain any. The view
 * options come from the shipped component contracts; the field options come
 * from whatever the endpoint's own response turned out to hold; the control
 * options come from the parameters the endpoint itself declares. Nothing here
 * knows what a lease or an invoice is, which is precisely why it works the
 * same on an API nobody has seen before.
 *
 * Pure. The whole conversation can be driven in a test with no model, no
 * network and no clock — which is also how the "degrade to the deterministic
 * wizard" path works when there is no AI key at all.
 */

export interface StepOption {
  readonly value: string;
  readonly label: string;
  /** What choosing this means, in shape terms rather than domain terms. */
  readonly description?: string;
  /** At most one option per step carries this. */
  readonly recommended?: boolean;
}

export interface Step {
  readonly id: string;
  readonly question: string;
  /** Context worth reading before answering. Omitted when the question stands alone. */
  readonly help?: string;
  readonly options: readonly StepOption[];
  readonly multiple: boolean;
  /** Whether "no thanks" is a legitimate answer. */
  readonly skippable: boolean;
  /** Whether a typed answer is accepted instead of an option. */
  readonly freeText?: boolean;
}

/**
 * A second endpoint that can be joined in, in op terms.
 *
 * The capability report's `JoinOffer` speaks in *resources*; this speaks in
 * ops, because ops are what a widget's `sources` name. The server does that
 * translation, so this file never has to know a resource graph exists.
 */
export interface JoinCandidate {
  /** Stable identity, used as the option's value. */
  readonly id: string;
  /** The op whose rows carry the foreign key. */
  readonly fromOp: string;
  /** The op returning the other side. */
  readonly toOp: string;
  readonly title: string;
  /** Field on the `fromOp` rows. */
  readonly leftField: string;
  /** Field on the `toOp` rows it matches. */
  readonly rightField: string;
  /**
   * How the second endpoint is actually called.
   *
   * `filtered` is one extra request for the whole set. `perRow` is one request
   * per row, and carries the input it feeds — without that the join cannot be
   * built at all, so such a candidate is never offered rather than offered and
   * then failing at confirm time.
   */
  readonly fetch:
    | { readonly mode: "filtered"; readonly param?: string | undefined }
    | {
        readonly mode: "perRow";
        readonly param: string;
        readonly maxRows: number;
      };
}

/**
 * A collection that belongs to one record — a task's notes, a property's units.
 *
 * The mirror image of a join, and derived from the same relations. A join
 * needs its target callable on its own, so it can be fetched wholesale and
 * matched; these are the ones a join has to discard, because the endpoint
 * cannot be called without the parent's id in the first place. That is exactly
 * what makes them children rather than peers, and the path parameter is not an
 * obstacle here but the whole mechanism — the record supplies it.
 */
export interface ChildCollection {
  /** Stable id, used as the section's id and the option's value. */
  readonly id: string;
  /** The record this hangs off. */
  readonly parentOp: string;
  readonly title: string;
  /** The endpoint listing the collection. */
  readonly op: string;
  /**
   * Its URL path, and the kind of thing it returns.
   *
   * Carried for the same reason a bare endpoint carries them: the endpoint
   * index the model chooses from shows a path and a group, and a candidate
   * with neither reads as less real than its neighbours. A nested collection
   * is not a lesser endpoint — it is one that needs an id — and the model
   * should be choosing on what the records are, not on how much the entry
   * happens to say.
   */
  readonly path?: string | undefined;
  readonly resource?: string | undefined;
  /**
   * The field on the parent's rows that fills this endpoint's input.
   *
   * Known by the relation graph, which worked it out when it proved the link.
   * Reading it here beats re-deriving it from a convention downstream.
   */
  readonly parentIdField?: string | undefined;
  /**
   * The endpoint input that receives the parent's identity.
   *
   * Lands in the URL path or the query depending on where the endpoint
   * declares it; the widget's `params` map covers both, so this does not need
   * to know which.
   */
  readonly param?: string | undefined;
  /**
   * Field on the child rows carrying the parent's id, for when the endpoint
   * takes no input and the rows have to be matched instead.
   */
  readonly linkField?: string | undefined;
  /**
   * Whether that field holds one id or a list of them.
   *
   * An array-valued foreign key — `PropertyIds`, `tag_ids` — is as ordinary as
   * a scalar one and needs a different comparison. Getting it wrong is silent:
   * a list never equals an id, so the section renders empty and looks like a
   * record with no children rather than like a mistake.
   */
  readonly linkKind?: "scalar" | "array" | undefined;
}

/** A record view the capability report found. */
export interface DrillDownCandidate {
  readonly resource: string;
  readonly title: string;
  readonly listOp: string;
  readonly detailOp: string;
  readonly idField: string;
  readonly detailParam: string;
  readonly labelField?: string | undefined;
}

/**
 * What reading an API would cost, and whether it can be read at all.
 *
 * Carried on the context because the price has to be part of the question. An
 * assistant that reads an endpoint because a sentence sounded like a request
 * for one is the thing the whole consent flow exists to prevent, and "about 36
 * requests" is the only form of that consent worth asking for.
 */
export interface ReadPlan {
  readonly connection: string;
  readonly requests: number;
  readonly estimatedMs: number;
  /** A current report already covers it, so reading again costs nothing new. */
  readonly alreadyRead: boolean;
  /** A report exists but describes different endpoints. */
  readonly stale: boolean;
  /**
   * A credential is required and none is stored.
   *
   * When this is true the read is not offered at all — it would spend requests
   * to collect a row of 401s. The key is asked for through the panel that
   * handles credentials, never through the conversation.
   */
  readonly needsKey: boolean;
}

export interface ConciergeContext {
  readonly connections: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly ops: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly connection: string;
    /**
     * The URL path, which is often the most honest description there is.
     *
     * `/v1/rentals/units` distinguishes itself from `/v1/associations/units`
     * in a way two endpoints both titled "Retrieve all units" do not. It costs
     * nothing to carry — every op already has one.
     */
    readonly path?: string | undefined;
    /** Whatever prose the API's own spec supplied for it. */
    readonly description?: string | undefined;
    /**
     * The kind of thing this returns — "unit", "lease" — where the API says.
     *
     * Carried for grouping rather than for logic. An index of sixty endpoints
     * reads as noise flat and as a table of contents grouped, and the grouping
     * an API already declares is better than one inferred from id prefixes.
     */
    readonly resource?: string | undefined;
    /**
     * What this endpoint accepts, and what each input *does*.
     *
     * `role` is the load-bearing field, as `paramDefSchema` says: every vendor
     * spells the same idea differently, and recording the role once is what
     * lets something offer "narrow this to a date range" without knowing the
     * vendor's vocabulary. Carried here because the query tool is that
     * something, and it needs the roles rather than the names.
     *
     * Absent for an endpoint nothing has described.
     */
    readonly params?: readonly ParamDef[] | undefined;
  }>;
  /** Sampled shape per op id, for whatever has been read. */
  readonly shapes: Readonly<Record<string, InferredShape>>;
  readonly joins: readonly JoinCandidate[];
  readonly drillDowns: readonly DrillDownCandidate[];
  /** Collections that hang off a record, keyed by the op the record comes from. */
  readonly children: readonly ChildCollection[];
  /**
   * Ops whose declared params include a free-text search, and which param.
   *
   * The name is carried because the build has to write it into the source's
   * params. Knowing an endpoint *can* be searched is useless without knowing
   * what to call the input.
   */
  readonly searchable: ReadonlyArray<{ readonly op: string; readonly param: string }>;
  /** Ops whose declared params include a date range, and which params. */
  readonly rangeFilterable: ReadonlyArray<{
    readonly op: string;
    readonly start: string;
    readonly end?: string | undefined;
  }>;
  /** What reading each connection would cost. One entry per connection. */
  readonly readPlans: readonly ReadPlan[];
  /**
   * What each connection calls its fields, keyed by connection id.
   *
   * The same lexicon the browser renders headers from, so an option card
   * offering "Occupants" and a table header reading "Unit number" cannot be
   * the same field wearing two names. That drift is exactly why `humanLabel`
   * moved into `@freebirdai/dash-spec` in the first place — this is the next step of the
   * same argument, now that a better label than the mechanical one exists.
   *
   * Empty for an API nothing has mapped, which falls back to `humanLabel`.
   */
  readonly labels?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
}

/**
 * Steps whose answer is an action rather than a value.
 *
 * The machine stays pure: it can say *what* should happen next, including
 * things that spend money or open a panel, but it never does them. The
 * imperative layer — the route and the chat action — recognises these ids and
 * carries them out, then asks the machine again against a changed world.
 */
/**
 * The columns every side of a comparison groups into.
 *
 * Stacking two measurements only works if they agree on what their columns are
 * called — each side is a different endpoint with different field names, and
 * the chart needs one bucket column and one value column across all of them.
 * Fixing the names here is what lets each side keep its own field names right
 * up until the moment they are combined.
 */
/**
 * Counting the records, as an answer somebody can pick.
 *
 * Every other measure names a field; this one names none, which is exactly
 * what made it inexpressible everywhere else. It needs a value of its own to
 * be choosable at all.
 */
export const MEASURE_COUNT = "count:";

/** Series controls are `series:<index>`, one per measurement drawn beside. */
export const SERIES_STEP = "series:";

export const SERIES_BUCKET = "bucket";
export const SERIES_COUNT = "count";
/** The column the union writes each source's label into. */
export const SERIES_LABEL = "series";

export const EFFECT_STEPS: ReadonlySet<string> = new Set(["connect", "read"]);

export const emptyContext: ConciergeContext = {
  connections: [],
  ops: [],
  shapes: {},
  joins: [],
  drillDowns: [],
  children: [],
  searchable: [],
  rangeFilterable: [],
  readPlans: [],
};

/* ── the field pool ────────────────────────────────────────────────────── */

/**
 * The fields a widget can actually bind to.
 *
 * This used to exclude every nested name, and that was honest at the time: the
 * builder could not flatten one, so offering `Unit.UnitNumber` would have
 * produced a role naming a column no row carried. The cost was severe and
 * invisible — on a real listings endpoint it hid 24 of 34 fields, including
 * every name a person would identify a record by.
 *
 * Worse, it kept the wrong half. `Property` and `Unit` are objects; bound to a
 * role they render "[object Object]". So the questions offered the containers
 * and hid what was inside them.
 *
 * Now that the builder derives a nested field into a real column, the filter
 * inverts: a nested scalar is offered, a container is not. What is excluded is
 * what cannot be *drawn*, which is what the exclusion always meant to be.
 */
const flat = (shape: InferredShape | undefined): readonly FieldInfo[] =>
  (shape?.fields ?? []).filter((field) => {
    const kinds = field.kinds.filter((kind) => kind !== "null");
    // A container has nothing to show. Its children, if the walk reached them,
    // are separate fields and are offered on their own merits.
    return kinds.length > 0 && !kinds.includes("object") && !kinds.includes("array");
  });

/**
 * The columns the widget will actually have.
 *
 * After a join the right-hand columns arrive prefixed with the right source's
 * name — `runPlan` does that unconditionally, so `Id` from the second endpoint
 * becomes `invoices_Id`. The questions have to offer the names the rows will
 * carry, or every binding produced here would name a column that never exists.
 */
export const fieldPool = (
  draft: ConciergeDraft,
  context: ConciergeContext,
): readonly FieldInfo[] => {
  const left = flat(context.shapes[draft.op ?? ""]);
  if (!draft.join) return left;

  const right = flat(context.shapes[draft.join.op]);
  const prefix = draft.join.op;
  return [...left, ...right.map((field) => ({ ...field, name: `${prefix}_${field.name}` }))];
};

const answered = (draft: ConciergeDraft, id: string): boolean => draft.answered.includes(id);

/* ── describing what is on offer ───────────────────────────────────────── */

/**
 * How a field is described to somebody choosing it.
 *
 * Shape, never meaning. "A date" and "4 distinct values" are facts about the
 * response; anything about what the field *represents* would be this file
 * guessing at a domain it has no business knowing.
 */
export const describeField = (field: FieldInfo): string => {
  const parts: string[] = [];

  if (
    field.format === "iso8601" ||
    field.format === "unix_seconds" ||
    field.format === "unix_millis"
  ) {
    parts.push("a date");
  } else if (field.format === "minor_units") {
    parts.push("a whole number, possibly in cents");
  } else if (field.format) {
    parts.push(`a ${field.format}`);
  } else {
    const kinds = field.kinds.filter((kind) => kind !== "null");
    if (kinds.length > 0) parts.push(kinds.join(" or "));
  }

  // A small closed set is the single most useful thing to know about a column
  // — it is what makes something groupable, filterable or worth marking.
  if (field.distinct > 0 && field.distinct <= 12) parts.push(`${field.distinct} distinct values`);
  if (field.nullable) parts.push("sometimes empty");

  return parts.join(" · ");
};

/** The lexicon for one connection, or nothing when the API was never mapped. */
export type ConciergeLabels = Readonly<Record<string, string>>;

/** What the API's field names are called here, for the connection in play. */
export const labelsFor = (
  draft: Pick<ConciergeDraft, "connection">,
  context: ConciergeContext,
): ConciergeLabels => (draft.connection ? (context.labels?.[draft.connection] ?? {}) : {});

const fieldOption = (
  field: FieldInfo,
  recommended = false,
  labels: ConciergeLabels = {},
): StepOption => ({
  value: field.name,
  // The name the option card shows has to be the name the widget will show,
  // or choosing "Occupants" produces a column headed "Unit number".
  label: fieldLabel(field.name, labels),
  description: describeField(field),
  ...(recommended ? { recommended: true } : {}),
});

/** `PropertyId`, `unit_id`, `id` — a reference, not a measure. */
const looksLikeIdentifier = (name: string): boolean =>
  /(^|[a-z0-9_])(Id|id|ID)$/.test(name) && !/(bid|paid|valid|grid|rapid|solid)$/i.test(name);

/**
 * The field a role most likely wants.
 *
 * Ranking, never gating — every usable field stays on the list. The signals
 * are structural: a role about time prefers a real date, a role bounded by
 * cardinality prefers the smallest closed set, and a purely numeric role
 * prefers something that looks like a measure over something that looks like
 * an identifier. Summing a column of ids produces a number that is wrong in a
 * way nobody notices.
 */
export const preferredForRole = (
  role: RoleContract,
  options: readonly FieldInfo[],
): FieldInfo | undefined => {
  if (options.length === 0) return undefined;

  const timeRole = role.accepts.includes("temporal") && !role.accepts.includes("text");
  if (timeRole) {
    const dated = options.find((field) => field.format && field.format !== "minor_units");
    if (dated) return dated;
  }

  if (role.maxCardinality !== undefined) {
    const bound = role.maxCardinality;
    const small = options
      .filter((field) => field.distinct > 1 && field.distinct <= bound)
      .sort((a, b) => a.distinct - b.distinct)[0];
    if (small) return small;
  }

  if (role.accepts.length === 1 && role.accepts[0] === "numeric") {
    const measure = options.find((field) => field.format === "minor_units");
    if (measure) return measure;
    const notAnId = options.find((field) => !looksLikeIdentifier(field.name));
    if (notAnId) return notAnId;
  }

  return options[0];
};

/**
 * Where an extra field would go, if anywhere.
 *
 * A table has `columns` and a card has `meta`, so an accepted extra has an
 * obvious home. A stat has one number and nowhere to put a second field — so
 * the extras question is not asked there at all, rather than asked and then
 * quietly ignored, which is the version somebody notices a week later.
 */
export const extrasRole = (contract: ComponentContract): RoleContract | undefined =>
  contract.roles.find((role) => role.multi === true);

/** How much of the joined endpoint a widget shows before somebody chooses. */
const JOINED_COLUMN_LIMIT = 4;

/**
 * The joined endpoint's own columns, added to the role that can hold them.
 *
 * A join fetches a second endpoint, pays for it, prefixes its columns and puts
 * them in the pool — and then nothing bound them, so the widget rendered the
 * first endpoint alone. Asked to show properties alongside their listings, the
 * listings were retrieved and invisible: every symptom of a join that had not
 * happened, with the request cost of one that had.
 *
 * The binding call cannot fix this on its own, because it is only ever shown
 * the primary endpoint's schema — it has no way to name a column it was never
 * told exists. So the columns are added here instead, deterministically, from
 * the pool the join produced.
 *
 * Ranking is `preferredForRole`'s and the role's own acceptance test is
 * `fieldsForRole`'s; nothing here re-decides either. Identifiers are skipped
 * because the join already matched on one and a second copy of it is not what
 * anybody meant by "show me the listings". Capped, because a wide endpoint
 * would otherwise push the columns somebody did ask for off the right-hand
 * edge — and every one of these is adjustable in the control afterwards.
 */
export const withJoinedColumns = (
  draft: ConciergeDraft,
  context: ConciergeContext,
): ConciergeDraft => {
  if (!draft.join || !draft.component) return draft;

  const contract = contractFor(draft.component);
  const target = contract ? extrasRole(contract) : undefined;
  if (!target) return draft;

  const bound = draft.roles[target.role];
  const already = new Set(Array.isArray(bound) ? bound : bound ? [bound] : []);

  const prefix = `${draft.join.op}_`;
  const joined = fieldPool(draft, context).filter(
    (field) =>
      field.name.startsWith(prefix) &&
      !already.has(field.name) &&
      !looksLikeIdentifier(field.name),
  );

  /*
   * Ranked by asking the role for its favourite, then its next favourite.
   * `preferredForRole` returns one field, so this is simply that, repeatedly —
   * which keeps the ordering rule in one place rather than growing a second
   * one here that would drift from it.
   */
  const picked: string[] = [];
  let remaining = fieldsForRole(target, joined);
  while (picked.length < JOINED_COLUMN_LIMIT && remaining.length > 0) {
    const next = preferredForRole(target, remaining);
    if (!next) break;
    picked.push(next.name);
    remaining = remaining.filter((field) => field.name !== next.name);
  }
  if (picked.length === 0) return draft;

  return {
    ...draft,
    roles: { ...draft.roles, [target.role]: [...already, ...picked] },
  };
};

/**
 * The control for one optional role, or nothing when there is none to show.
 *
 * One definition, used twice: `allSteps` renders it on the card, and `revise`
 * validates a patch against it. Keeping those together is the point — a
 * control offering fields a patch would be refused for naming is two answers
 * to one question, and this file has been bitten by that before.
 *
 * Returns undefined when the role is unbound, which is what keeps the wizard
 * from asking about optional polish, or when nothing in the pool could fill
 * it — a question with no options is not a question.
 */
export const optionalRoleStep = (
  draft: ConciergeDraft,
  contract: ComponentContract,
  role: RoleContract,
  fields: readonly FieldInfo[],
  /* Labels only, for the option text. Omitted where only the values are read. */
  names: Readonly<Record<string, string>> = {},
): Step | undefined => {
  if (role.required) return undefined;
  if (valueOf(draft, `${ROLE_STEP}${role.role}`).length === 0) return undefined;

  const candidates = fieldsForRole(role, fields);
  if (candidates.length === 0) return undefined;

  const noun = humanLabel(role.role).toLowerCase();
  return {
    id: `${ROLE_STEP}${role.role}`,
    question: `Which field should be the ${noun}?`,
    ...(role.description ? { help: role.description } : {}),
    options: candidates.map((field) => fieldOption(field, false, names)),
    multiple: role.multi === true,
    /*
     * Skippable, and `skipStep` unbinds it rather than only marking it
     * answered — a control that reads as removed over a card that still shows
     * the field is the silent wrongness this machine refuses everywhere else.
     */
    skippable: true,
  };
};

/**
 * The optional role a step id names, if the chosen component has one.
 *
 * The lookup `revise` needs to tell "there is no such step" from "there is no
 * such step *yet*", which are different answers and were being given the same
 * one.
 */
export const optionalRoleFor = (
  draft: ConciergeDraft,
  stepId: string,
): { contract: ComponentContract; role: RoleContract } | undefined => {
  if (!isRoleStep(stepId)) return undefined;
  const contract = COMPONENT_CONTRACTS[draft.component as keyof typeof COMPONENT_CONTRACTS] as
    | ComponentContract
    | undefined;
  if (!contract) return undefined;
  const role = contract.roles.find((candidate) => candidate.role === roleOfStep(stepId));
  if (!role || role.required) return undefined;
  return { contract, role };
};

/** Components that can actually be built from these fields, best fit first. */
export const viewOptions = (fields: readonly BindableField[]): readonly StepOption[] => {
  const fitting = Object.values(COMPONENT_CONTRACTS).filter((contract) =>
    componentFits(contract, fields),
  );

  /*
   * More required roles filled means a richer view of the same rows, so a
   * component that can use what is here ranks above one that merely tolerates
   * it. `table` sits last by construction: it fits almost everything, which
   * makes it the safe answer rather than the good one — but it stays on the
   * list, because sometimes a table is exactly what somebody wants.
   */
  const score = (contract: ComponentContract): number =>
    contract.roles.filter((role) => role.required).length * 10 -
    (contract.id === "table" ? 100 : 0);

  const ranked = [...fitting].sort(
    (a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)),
  );
  const recommended = ranked[0]?.id;

  return ranked.map((contract) => ({
    value: String(contract.id),
    label: contract.title,
    description: contract.description,
    ...(contract.id === recommended ? { recommended: true } : {}),
  }));
};

/**
 * Fields worth offering that the widget is not already showing.
 *
 * Every rule is about shape or naming convention, and each carries the reason
 * it was offered — an offer somebody cannot judge is just clutter. This is the
 * "these look related, want them too?" step, and it runs *after* the widget
 * already works, so declining it costs nothing.
 */
export const extraFieldOptions = (
  fields: readonly FieldInfo[],
  used: ReadonlySet<string>,
  labels: ConciergeLabels = {},
): readonly StepOption[] => {
  const offers: StepOption[] = [];

  for (const field of fields) {
    if (used.has(field.name)) continue;

    if (field.format === "minor_units") {
      offers.push({ ...fieldOption(field, false, labels), description: "a number worth totalling" });
      continue;
    }
    if (
      field.format === "iso8601" ||
      field.format === "unix_seconds" ||
      field.format === "unix_millis"
    ) {
      offers.push({ ...fieldOption(field, false, labels), description: "a date this record carries" });
      continue;
    }
    // A field pointing at another resource is also the opening for a join.
    if (looksLikeIdentifier(field.name)) {
      offers.push({
        ...fieldOption(field, false, labels),
        description: "an identifier — it may link to another endpoint",
      });
      continue;
    }
    if (field.distinct > 1 && field.distinct <= 12 && field.kinds.includes("string")) {
      offers.push({
        ...fieldOption(field, false, labels),
        description: `${field.distinct} distinct values — good for grouping or filtering`,
      });
      continue;
    }
    if (field.kinds.includes("string")) offers.push(fieldOption(field, false, labels));
  }

  return offers.slice(0, 12);
};

/**
 * Values worth marking on a row.
 *
 * Straight from `highlightCandidates`, which decides candidacy by *shape* — a
 * boolean flag, or a column with a small repeating set — rather than by
 * recognising words. That ordering is what makes this work on a vocabulary
 * nobody has seen: `listed`, `vacant` and `delinquent` are all unknown to the
 * tone vocabulary and all three are exactly what somebody wants marked. The
 * tone is a hint layered on top, and an unrecognised one is offered plainly
 * rather than suppressed.
 */
export const highlightOptions = (
  draft: ConciergeDraft,
  fields: readonly FieldInfo[],
): readonly StepOption[] => {
  const bound = new Set(
    Object.values(draft.roles).flatMap((value) => (Array.isArray(value) ? value : [value])),
  );
  const candidates = highlightCandidates(fields, statusTone, { exclude: [...bound] });

  // Only the first is recommended. Marking everything markable is the same as
  // marking nothing — the pills stop being a signal and become the row.
  const best = candidates[0];
  return candidates.slice(0, 8).map(({ highlight, confident }) => ({
    value: highlight.id,
    label: highlight.label,
    description: confident
      ? `Marks rows matching \`${highlight.when}\`.`
      : `Marks rows matching \`${highlight.when}\`. I could not tell how urgent that is, so it is marked plainly.`,
    ...(highlight.id === best?.highlight.id && confident ? { recommended: true } : {}),
  }));
};

const controlOptions = (
  draft: ConciergeDraft,
  context: ConciergeContext,
): readonly StepOption[] => {
  const options: StepOption[] = [];
  const op = draft.op ?? "";

  // What the endpoint itself can be narrowed by, from its declared params.
  if (context.searchable.some((entry) => entry.op === op)) {
    options.push({
      value: "endpointSearch",
      label: "Search this endpoint",
      description: "It accepts a search term, so filtering happens before the rows arrive.",
      recommended: true,
    });
  }
  if (context.rangeFilterable.some((entry) => entry.op === op)) {
    options.push({
      value: "endpointRange",
      label: "Follow the dashboard's date range",
      description: "It accepts a date range, so the board's time control narrows it at the source.",
    });
  }

  // What the chosen view itself offers, from its presentation manifest.
  const manifest = draft.component ? PRESENTATION_MANIFESTS[draft.component] : undefined;
  for (const setting of manifest?.settings ?? []) {
    // Booleans only: anything else needs a value, which is a different card.
    if (setting.type !== "boolean") continue;
    options.push({ value: setting.id, label: setting.label, description: setting.description });
  }

  return options;
};

const joinsFor = (draft: ConciergeDraft, context: ConciergeContext): readonly JoinCandidate[] =>
  context.joins.filter((join) => join.fromOp === draft.op && join.toOp !== draft.op);

const joinOptions = (
  candidates: readonly JoinCandidate[],
  labels: ConciergeLabels = {},
): readonly StepOption[] => {
  /*
   * The cost is part of the offer, not a detail to discover afterwards. One
   * filtered request and one request per row are different enough that
   * somebody would choose differently knowing which they had agreed to — and
   * the cheap one is the only kind worth recommending.
   */
  const cheap = candidates.find((join) => join.fetch.mode === "filtered");
  return candidates.map((join) => ({
    value: join.id,
    label: join.title,
    description:
      join.fetch.mode === "filtered"
        ? `Matches on ${fieldLabel(join.leftField, labels)}. One extra request for the whole set.`
        : `Matches on ${fieldLabel(join.leftField, labels)}. That endpoint cannot be filtered by it, so it costs one request per row — up to ${join.fetch.maxRows}.`,
    ...(join.id === cheap?.id ? { recommended: true } : {}),
  }));
};

/**
 * The offer to go and read an API, with what it costs.
 *
 * Three shapes, and which one applies is a fact about the connection rather
 * than a preference: no key means the read cannot succeed and is not offered;
 * a key and no report means an offer with a price on it; a report that covers
 * this endpoint but returned no rows means reading again will not help and
 * something else should be picked.
 */
const readStep = (
  draft: ConciergeDraft,
  context: ConciergeContext,
  ops: ReadonlyArray<{ id: string; title: string; connection: string }>,
): Step | null => {
  const plan = context.readPlans.find((entry) => entry.connection === draft.connection);
  const elsewhere: StepOption[] =
    ops.length > 1
      ? [
          {
            value: "other",
            label: "Pick a different endpoint",
            description: "Go back to the list.",
          },
        ]
      : [];

  if (!plan) return null;

  if (plan.needsKey) {
    return {
      id: "read",
      question: "This API needs a key before anything can be read from it.",
      help: "The key is entered in the connection panel, not here — nothing in this conversation is stored anywhere a credential should not be.",
      options: [
        {
          value: "key",
          label: "Add the key",
          description: "Opens the panel that handles credentials.",
          recommended: true,
        },
        ...elsewhere,
      ],
      multiple: false,
      skippable: false,
    };
  }

  /*
   * Already read, and this endpoint still has no fields.
   *
   * Reading again would spend the same requests for the same silence — the
   * endpoint returned nothing, or was refused, and that is a fact about the
   * account rather than something a retry fixes.
   */
  if (plan.alreadyRead) {
    return {
      id: "read",
      question: "This endpoint returned nothing when it was read, so there is nothing to bind to.",
      help: "That usually means the account has no records of this kind, or the key is not permitted to read them.",
      options: [
        ...elsewhere,
        {
          value: "read",
          label: "Read it again",
          description: `Costs about ${plan.requests} request(s) and is unlikely to change the answer.`,
        },
      ],
      multiple: false,
      skippable: false,
    };
  }

  return {
    id: "read",
    question: plan.stale
      ? "This API has changed since it was last read. Shall I read it again?"
      : "This API has not been read yet. Shall I read it now?",
    /*
     * The consent copy, in the register the wizard's Read step already uses.
     * Rate limits are not the real hazard — a per-request price is, and it is
     * the one thing somebody genuinely has to check before saying yes.
     */
    help:
      "Reading calls each collection endpoint once to learn what fields it returns. " +
      "Only field names are kept, never values. For almost every API this is harmless; " +
      "the one case worth checking first is whether yours charges per request.",
    options: [
      {
        value: "read",
        label: `Read it — about ${plan.requests} request(s), roughly ${Math.max(1, Math.round(plan.estimatedMs / 1000))}s`,
        description: "Nothing is read until you say so.",
        recommended: true,
      },
      ...elsewhere,
    ],
    multiple: false,
    skippable: false,
  };
};

/* ── the machine ───────────────────────────────────────────────────────── */

/**
 * Fill in anything that has exactly one possible answer.
 *
 * One option is not a question, and asking it wastes somebody's turn. But the
 * draft still has to *hold* the answer — a machine that silently skips a
 * question and then builds against a value it never recorded produces "no API
 * chosen yet" at confirm time, which is the same bug wearing a politer face.
 *
 * Pure and idempotent, so every entry point can call it without coordinating.
 */
export const settle = (draft: ConciergeDraft, context: ConciergeContext): ConciergeDraft => {
  let settled = draft;

  if (!settled.connection && context.connections.length === 1) {
    settled = { ...settled, connection: context.connections[0]!.id };
  }

  /*
   * Where the rows live, taken from the endpoint rather than left at `$`.
   *
   * Choosing an endpoint records the op and nothing else, so the draft kept
   * the default — and `buildFromDraft` extracts whatever the draft says. On an
   * API that returns a bare array that is right by accident; on one that wraps
   * its rows in `{ "data": [...] }` it extracts the wrapper, binds nothing,
   * and produces a widget that validates and renders empty.
   *
   * Derived, never asked: it is a fact about the response, and the only reason
   * it was ever on the draft is that the builder needs it. Re-derived on every
   * settle so changing the endpoint cannot leave the previous one's path
   * behind.
   */
  const found = settled.op ? context.shapes[settled.op]?.rowsPath : undefined;
  if (found && found !== settled.rowsPath) settled = { ...settled, rowsPath: found };

  /*
   * The old two-endpoint comparison, in the general form.
   *
   * `compare` could say exactly one thing — two endpoints, counted, over a
   * date — and `series` says that and more. Migrated here, in one place, so a
   * draft somebody was halfway through when this shipped keeps working and
   * nothing downstream has to know both shapes existed.
   */
  if (settled.compare && settled.series.length === 0 && settled.op) {
    const bucket = "{{range.grain}}";
    settled = {
      ...settled,
      shape: settled.shape ?? {
        groupBy: [{ field: settled.compare.leftTimeField, bucket, as: SERIES_BUCKET }],
        measures: [{ as: SERIES_COUNT, agg: "count" }],
        sort: [],
      },
      series: [
        {
          op: settled.compare.op,
          rowsPath: settled.compare.rowsPath,
          label: settled.compare.rightLabel,
          shape: {
            groupBy: [{ field: settled.compare.rightTimeField, bucket, as: SERIES_BUCKET }],
            measures: [{ as: SERIES_COUNT, agg: "count" }],
            sort: [],
          },
        },
      ],
      compare: undefined,
      title: settled.title,
    };
  }

  return settled;
};

/**
 * The next question, or null when the draft is ready to build.
 *
 * Steps that do not apply are never asked: no join candidate means no join
 * question, no drill-down offer means no drill-down question. That is what
 * keeps this from reading as a form somebody has to tab through.
 */
/**
 * A step, plus what the draft currently says about it.
 *
 * `nextStep` used to be the only reader of this sequence and could return the
 * moment it found something unanswered. The approval card needs the *whole*
 * set at once — a chip per decision, showing what it is set to — so the
 * sequence is now built as a list and `nextStep` is a `find` over it. One
 * definition of what may be asked, two ways of reading it.
 */
export interface StepEntry {
  readonly step: Step;
  /** What the draft holds for this step. Empty when nothing is chosen yet. */
  readonly value: readonly string[];
  /** Whether the draft has settled it — answered, skipped, or filled. */
  readonly settled: boolean;
  /**
   * Nothing after it can be asked until it is settled.
   *
   * The endpoint decides which fields exist, the view decides which roles are
   * needed, and a required role has to be bound before a widget exists at all.
   * Everything else is polish that can be left alone.
   */
  readonly required: boolean;
}

/** What the draft holds for a step, flattened for a chip label. */
export const valueOf = (draft: ConciergeDraft, stepId: string): readonly string[] => {
  if (isRoleStep(stepId)) {
    const bound = draft.roles[roleOfStep(stepId)];
    if (bound === undefined) return [];
    return Array.isArray(bound) ? bound : [bound];
  }
  if (stepId.startsWith(SERIES_STEP)) {
    const index = Number.parseInt(stepId.slice(SERIES_STEP.length), 10);
    const side = draft.series[index];
    return side ? [side.op] : [];
  }
  switch (stepId) {
    case "connection":
      return draft.connection ? [draft.connection] : [];
    case "endpoint":
      return draft.op ? [draft.op] : [];
    case "join":
      return draft.join ? [draft.join.op] : [];
    case "component":
      return draft.component ? [draft.component] : [];
    case "options":
      return draft.options;
    case "offer":
      // Gone once answered either way, so an unanswered offer reads as unset.
      return draft.offer ? [] : ["skip"];
    case "measure": {
      const measure = draft.shape?.measures[0];
      if (!measure) return [];
      return [measure.field ? `${measure.agg}:${measure.field}` : MEASURE_COUNT];
    }
    case "groupBy":
      return draft.shape?.groupBy.map((key) => key.field) ?? [];
    case "filter":
      return draft.shape?.filter ? [draft.shape.filter] : [];
    case "drilldown":
      return draft.drilldown ? [draft.drilldown.op] : [];
    case "drilldownFields":
      return draft.drilldown?.fields ?? [];
    case "extras":
      return draft.extras;
    case "highlights":
      return draft.highlights;
    case "title":
      return draft.title ? [draft.title] : [];
    default:
      return [];
  }
};

/**
 * Every decision that applies to this draft, in the order they depend on
 * each other.
 *
 * Building stops at the first unsettled **required** step, because everything
 * after it is derived from an answer that does not exist yet — there is no
 * meaningful "which field is the category" before a view has been chosen.
 */
export const allSteps = (input: ConciergeDraft, context: ConciergeContext): StepEntry[] => {
  const draft = settle(input, context);
  const entries: StepEntry[] = [];
  /* What this API calls its fields, so every option reads as the widget will. */
  const names = labelsFor(draft, context);

  /** Push, and report whether the caller should stop building. */
  const add = (step: Step, settled: boolean, required = false): boolean => {
    entries.push({ step, value: valueOf(draft, step.id), settled, required });
    return required && !settled;
  };

  // ── which API ──────────────────────────────────────────────────────────
  if (!draft.connection) {
    /*
     * Nothing connected. Said out loud rather than silently ending, because a
     * conversation that stops with no card on screen reads as a failure of the
     * assistant rather than a missing prerequisite the user can fix.
     */
    if (context.connections.length === 0) {
      add(
        {
          id: "connect",
          question: "There is no API connected yet, so there is nothing to build from.",
          help: "Connecting one takes a URL and, usually, a key.",
          options: [
            {
              value: "open",
              label: "Connect an API",
              description:
                "Opens the connection panel. Your key is entered there — never in this conversation.",
              recommended: true,
            },
          ],
          multiple: false,
          skippable: false,
        },
        false,
        true,
      );
      return entries;
    }
    add(
      {
        id: "connection",
        question: "Which of your connected APIs is this about?",
        options: context.connections.map((connection) => ({
          value: connection.id,
          label: connection.title,
        })),
        multiple: false,
        skippable: false,
      },
      false,
      true,
    );
    return entries;
  }

  // ── which endpoint ─────────────────────────────────────────────────────
  const ops = context.ops.filter((op) => op.connection === draft.connection);
  if (ops.length === 0) return entries;

  /*
   * Read endpoints first, and one of them suggested.
   *
   * An endpoint nobody has read has no fields, so choosing it ends the
   * conversation with nothing to ask about. It stays on the list — hiding half
   * an API would be worse, and seeing it is what prompts the read — but it
   * never leads the list and is never the suggestion.
   */
  const read = ops.filter((op) => (context.shapes[op.id]?.fields.length ?? 0) > 0);
  const unread = ops.filter((op) => !read.includes(op));

  if (
    add(
      {
        id: "endpoint",
        question: "Which endpoint holds what you want to see?",
        help:
          unread.length > 0
            ? "Only endpoints that have been read carry field information; the rest need reading first."
            : undefined,
        options: [...read, ...unread].map((op) => {
          const shape = context.shapes[op.id];
          return {
            value: op.id,
            label: op.title,
            description: shape
              ? `${shape.rowCount} row(s) sampled · ${shape.fields.length} fields`
              : "not read yet — nothing can be built from it until it is",
            ...(op.id === read[0]?.id ? { recommended: true } : {}),
          };
        }),
        multiple: false,
        skippable: false,
      },
      Boolean(draft.op),
      true,
    )
  ) {
    return entries;
  }

  /*
   * Nothing has been read from this endpoint, so there is nothing to ask about
   * it — but the answer is a priced offer, not a dead end. This used to end the
   * conversation on the one screen where the user had done nothing wrong.
   */
  if (flat(context.shapes[draft.op ?? ""]).length === 0) {
    const offer = readStep(draft, context, ops);
    if (offer) add(offer, false, true);
    return entries;
  }

  // ── a second endpoint ──────────────────────────────────────────────────
  const joinCandidates = joinsFor(draft, context);
  /*
   * Offered when a relationship was found, and also whenever one is already
   * set — because a join can now arrive from the assistant rather than from
   * the report, and a decision the user cannot see is a decision they cannot
   * undo. The option list may be empty in that case; the control still shows
   * what it is joined to and still takes "no thanks".
   */
  if (joinCandidates.length > 0 || draft.join) {
    add(
      {
        id: "join",
        question: "Should this bring in a second endpoint?",
        help:
          joinCandidates.length > 0
            ? "These endpoints share a field, so their rows can be matched up into one set."
            : `Joined to "${draft.join?.op}" on ${fieldLabel(draft.join?.leftField ?? "", names)}. Nothing verified that these line up — check the caveats on the preview.`,
        options: joinOptions(joinCandidates, names),
        multiple: false,
        skippable: true,
      },
      answered(draft, "join") || Boolean(draft.join),
    );
  }

  const fields = fieldPool(draft, context);

  // ── the view ───────────────────────────────────────────────────────────
  const views = viewOptions(fields);
  if (views.length === 0) return entries;
  if (
    add(
      {
        id: "component",
        question: "How should it look?",
        help: "Only views these fields can actually fill are listed.",
        options: views,
        multiple: false,
        skippable: false,
      },
      Boolean(draft.component),
      true,
    )
  ) {
    return entries;
  }

  const contract = COMPONENT_CONTRACTS[draft.component as keyof typeof COMPONENT_CONTRACTS] as
    | ComponentContract
    | undefined;
  if (!contract) return entries;

  /*
   * The roles the measurement already decides, which must not be asked about.
   *
   * A role binds to a column, and after a group step the endpoint's own
   * columns are gone — a count is not a column until the group creates it. So
   * "which field should be the value?" is unanswerable for a widget that
   * counts rows, and the machine asked it anyway, offering whichever numbers
   * happened to be on the endpoint. That is how a request for the number of
   * listings per month became a question about rent or deposit.
   */
  const decided = rolesForShape(draft.shape);

  // ── one question per required role ─────────────────────────────────────
  for (const role of contract.roles) {
    if (!role.required) continue;
    if (decided[role.role]) continue;
    const candidates = fieldsForRole(role, fields);
    /*
     * Nothing can fill it. `componentFits` already excluded that case at the
     * view step, so reaching here means the pool changed under an
     * already-chosen component. Leaving it out is right: the build reports the
     * missing role plainly, which beats an empty card nobody can answer.
     */
    if (candidates.length === 0) continue;
    const preferred = preferredForRole(role, candidates);

    if (
      add(
        {
          id: `${ROLE_STEP}${role.role}`,
          question: `Which field should be the ${humanLabel(role.role).toLowerCase()}?`,
          help: role.description,
          options: candidates.map((field) =>
            fieldOption(field, field.name === preferred?.name, names),
          ),
          multiple: role.multi === true,
          skippable: false,
        },
        answered(draft, `${ROLE_STEP}${role.role}`),
        true,
      )
    ) {
      return entries;
    }
  }

  /*
   * An optional role that something has filled, as a control.
   *
   * Optional roles have never had a step, on the reasoning that a wizard
   * asking "which field should be the subtitle?" about every optional role of
   * every component is exactly the interrogation the `extras` question was
   * invented to replace. That reasoning holds — and it quietly meant a role
   * the *assistant* filled could not be applied either, because `revise` can
   * only set what a step offers. Asked for listings, the model bound the
   * street address as a card's subtitle and the rent as its meta, and both
   * were thrown away one layer later, leaving a card with a title on it.
   *
   * So the step exists once the role is bound and not before. That is what the
   * `series:N` controls already do — a question that exists because something
   * is set, so it can be seen and changed and taken off — and it leaves the
   * unbound case exactly as it was: no step, no question, nothing asked.
   *
   * The extras target is deliberately *not* excluded. `cards.meta` is both
   * optional and the multi role extras appends into, so excluding it would
   * leave half the reported bug in place; the two compose instead, because
   * `extraFieldOptions` already skips whatever the roles have bound.
   */
  for (const role of contract.roles) {
    if (role.required) continue;
    if (decided[role.role]) continue;
    const step = optionalRoleStep(draft, contract, role, fields, names);
    if (step) add(step, true);
  }

  // ── controls on the widget ─────────────────────────────────────────────
  const controls = controlOptions(draft, context);
  if (controls.length > 0) {
    add(
      {
        id: "options",
        question: "Any controls on this widget?",
        options: controls,
        multiple: true,
        skippable: true,
      },
      answered(draft, "options"),
    );
  }

  /*
   * Two readings of the request, put to the person who made it.
   *
   * Asked before anything else about the widget, because everything else
   * depends on which records these are — and asked at all only when the model
   * said the two would answer different questions. On almost every build there
   * is no choice here and this is not reached.
   *
   * Required, and that is the whole point: a widget counting the wrong thing
   * renders perfectly and reads as an answer. It is the one question worth
   * stopping for.
   */
  if (draft.choice) {
    const applied = draft.choice.role === "primary" ? draft.op : draft.series[0]?.op;
    add(
      {
        id: "choice",
        question: "Which of these did you mean?",
        help: "These would answer different questions, so it is worth being sure.",
        options: draft.choice.options.map((option) => ({
          value: option.op,
          label: option.label,
          description: option.whatItIs,
          ...(option.op === applied ? { recommended: true } : {}),
        })),
        multiple: false,
        skippable: false,
      },
      answered(draft, "choice"),
      true,
    );
  }

  /*
   * The measurement, the grouping and the filter, each as its own control.
   *
   * Only for a widget that measures something. A table showing rows has no
   * measurement to adjust, and a chip reading "Measuring: —" on one would be a
   * control that does nothing — the thing the card is supposed to stop doing.
   */
  if (draft.shape && !isEmptyShape(draft.shape)) {
    const numeric = fields.filter((field) => valueTypesOf(field).includes("numeric"));

    add(
      {
        id: "measure",
        question: "What is this counting?",
        help: "Counting the records answers \"how many\". Any other measure needs a number to work on.",
        options: [
          {
            value: MEASURE_COUNT,
            label: "Number of records",
            description: "Counts the rows themselves, which is what \"how many\" means.",
            recommended: true,
          },
          ...numeric.slice(0, 12).flatMap((field) => [
            {
              value: `sum:${field.name}`,
              label: `Total of ${fieldLabel(field.name, names)}`,
              description: describeField(field),
            },
            {
              value: `avg:${field.name}`,
              label: `Average of ${fieldLabel(field.name, names)}`,
              description: describeField(field),
            },
          ]),
        ],
        multiple: false,
        skippable: false,
      },
      draft.shape.measures.length > 0,
    );

    add(
      {
        id: "groupBy",
        question: "Broken up by what?",
        help: "A date is bucketed by the dashboard's own time control; anything else groups by its values.",
        options: fields.slice(0, 40).map((field) => ({
          value: field.name,
          label: fieldLabel(field.name, names),
          description: describeField(field),
        })),
        multiple: false,
        skippable: true,
      },
      answered(draft, "groupBy") || draft.shape.groupBy.length > 0,
    );

    if (draft.shape.filter) {
      /*
       * Shown so it can be removed, not edited. An expression is not a choice
       * between options, and a widget quietly narrowing its rows with nothing
       * on screen saying so is the failure this makes impossible.
       */
      add(
        {
          id: "filter",
          question: "Only some of the records?",
          help: `Currently showing only rows where ${draft.shape.filter}.`,
          options: [
            {
              value: draft.shape.filter,
              label: draft.shape.filter,
              description: "The rows this widget is limited to.",
              recommended: true,
            },
          ],
          multiple: false,
          skippable: true,
        },
        true,
      );
    }
  }

  /*
   * A measurement that costs requests, offered before it is taken.
   *
   * The one question in this machine whose answer spends somebody's money, so
   * it is asked in the only place that can honestly ask it: after the widget
   * already works without it, with the arithmetic in the question, and with
   * declining producing a real widget rather than a dead end.
   */
  if (draft.offer) {
    const cost = draft.offer.fanOut?.maxRows ?? 25;
    /*
     * The records' own noun, not the endpoint's title.
     *
     * An API titles its endpoints for the people calling them — "Retrieve all
     * applications" — and dropping that into a sentence produces "Also count
     * Retrieve all applications?". `nounFromTitle` already strips the
     * retrieval verb for the suggestion headlines; the same words are wanted
     * here for the same reason.
     */
    const noun = nounFromTitle(draft.offer.label) ?? draft.offer.label;
    add(
      {
        id: "offer",
        question: `Also count the ${noun}?`,
        help:
          `The ${noun} are only listed per record on this API, so counting them ` +
          `means one request per record — about ${cost} before it stops. Past that the ` +
          "number is a sample rather than a total, and the widget says so.",
        options: [
          {
            value: "include",
            label: `Include the ${noun}`,
            description: `About ${cost} requests each time this widget loads.`,
          },
          {
            value: "skip",
            label: "Leave it out",
            description: "The widget is built from everything else.",
          },
        ],
        multiple: false,
        skippable: true,
      },
      answered(draft, "offer"),
    );
  }

  /*
   * Each measurement drawn beside the first, so it can be taken off again.
   *
   * The bug this avoids is one joins already had: an assistant-set comparison
   * with no control was invisible on the card and could not be removed without
   * starting over.
   */
  draft.series.forEach((side, index) => {
    add(
      {
        id: `${SERIES_STEP}${index}`,
        question: `Also showing ${side.label}. Keep it?`,
        options: [
          {
            value: side.op,
            label: side.label,
            description: "Measured separately and drawn as its own series.",
            recommended: true,
          },
        ],
        multiple: false,
        skippable: true,
      },
      true,
    );
  });

  // ── clicking a row ─────────────────────────────────────────────────────
  const offers = context.drillDowns.filter((offer) => offer.listOp === draft.op);
  if (offers.length > 0) {
    add(
      {
        id: "drilldown",
        question: "What should happen when someone clicks a row?",
        options: offers.map((offer) => ({
          value: offer.detailOp,
          label: `Open the full record`,
          description: `Fetches one record using ${fieldLabel(offer.idField, names)} and shows its fields.`,
          recommended: true,
        })),
        multiple: false,
        skippable: true,
      },
      answered(draft, "drilldown"),
    );
  }

  if (draft.drilldown) {
    const detail = flat(context.shapes[draft.drilldown.op]);
    if (detail.length > 0) {
      add(
        {
          id: "drilldownFields",
          question: "Which fields should the opened record show?",
          help: "Skip this and it shows everything the record returns.",
          options: detail.map((field) => fieldOption(field, false, names)),
          multiple: true,
          skippable: true,
        },
        answered(draft, "drilldownFields"),
      );
    }
  }

  // ── the extras, after the thing already works ──────────────────────────
  const extrasTarget = extrasRole(contract);
  if (extrasTarget || draft.drilldown) {
    const used = new Set<string>(
      Object.values(draft.roles).flatMap((value) => (Array.isArray(value) ? value : [value])),
    );
    const pool = extrasTarget ? fieldsForRole(extrasTarget, fields) : fields;
    const options = extraFieldOptions(pool, used, names);
    if (options.length > 0) {
      add(
        {
          id: "extras",
          question: "These look related — want any of them shown too?",
          options,
          multiple: true,
          skippable: true,
        },
        answered(draft, "extras"),
      );
    }
  }

  // ── things worth marking ───────────────────────────────────────────────
  const marks = highlightOptions(draft, fields);
  if (marks.length > 0) {
    add(
      {
        id: "highlights",
        question: "Anything here worth marking when it shows up?",
        help: "A marked row gets a labelled pill, so it stands out without you having to read for it.",
        options: marks,
        multiple: true,
        skippable: true,
      },
      answered(draft, "highlights"),
    );
  }

  // ── a name ─────────────────────────────────────────────────────────────
  const suggestion = ops.find((op) => op.id === draft.op)?.title ?? "New widget";
  add(
    {
      id: "title",
      question: "What should it be called?",
      options: [{ value: suggestion, label: suggestion, recommended: true }],
      multiple: false,
      skippable: false,
      freeText: true,
    },
    /*
     * Not required, even though the wizard always asks it last.
     *
     * `buildFromDraft` falls back to the endpoint's own title, so an untitled
     * draft still produces a widget — which is what lets the assisted flow show
     * a preview before anybody has thought about a name.
     */
    Boolean(draft.title),
  );

  return entries;
};

/**
 * The next question, or null when there is nothing left to ask.
 *
 * In `wizard` mode that means every step, in order — the deterministic flow
 * somebody walks with no model at all. In `assisted` mode only the steps that
 * *block* a widget are asked; the rest are chips on the approval card, because
 * a conversation that interrogates you about optional polish before showing
 * you anything is the thing this mode exists to replace.
 */
export const nextStep = (input: ConciergeDraft, context: ConciergeContext): Step | null => {
  const entries = allSteps(input, context);
  const wanted =
    input.mode === "assisted"
      ? entries.find((entry) => entry.required && !entry.settled)
      : entries.find((entry) => !entry.settled);
  return wanted?.step ?? null;
};

/** One thing still needed before a widget can be built. */
export interface MissingPiece {
  readonly stepId: string;
  /** The role's own description, or the step's question. Plain enough to ask from. */
  readonly need: string;
  /** What could fill it, so a question can be asked *about* the data rather than reciting it. */
  readonly candidates: readonly string[];
}

/**
 * Whether this draft can produce a widget yet, and what is missing if not.
 *
 * This is what tells the assistant when to stop asking. It is deliberately
 * about the *blocking* decisions only — a widget with no highlights and no
 * drill-down is a perfectly good widget, and treating those as gaps is how a
 * flow ends up asking eight questions to draw a table.
 */
export const readiness = (
  draft: ConciergeDraft,
  context: ConciergeContext,
): { ready: boolean; missing: MissingPiece[] } => {
  const missing = allSteps(draft, context)
    .filter((entry) => entry.required && !entry.settled)
    .map((entry) => ({
      stepId: entry.step.id,
      need: entry.step.help ?? entry.step.question,
      candidates: entry.step.options.map((option) => option.value),
    }));
  return { ready: missing.length === 0, missing };
};

/**
 * Record an answer to a step that needed the context to interpret it.
 *
 * `applyAnswer` in `draft.ts` stays context-free so the draft module has no
 * idea a capability report exists. The two steps whose answer is an *offer*
 * rather than a value — the join and the drill-down — are resolved here,
 * against the same candidate list the question was built from. An answer
 * naming something not on that list is ignored rather than trusted, which is
 * the guard `mapProposal` already applies to a model's field names.
 */
export const applyStep = (
  input: ConciergeDraft,
  stepId: string,
  values: readonly string[],
  context: ConciergeContext,
): ConciergeDraft => {
  const draft = settle(input, context);

  /*
   * The two effect steps never mark themselves answered.
   *
   * Both are questions about the *world* rather than about the widget — is
   * there a connection, has this endpoint been read — so the honest way to
   * stop asking them is for the world to change. Recording them as answered
   * would let a failed read carry the conversation onward into questions that
   * have no options to offer.
   */
  if (EFFECT_STEPS.has(stepId)) {
    if (stepId === "read" && values[0] === "other") {
      // Back to the endpoint list, with the unread choice let go.
      return {
        ...draft,
        op: undefined,
        answered: draft.answered.filter((id) => id !== "endpoint"),
      };
    }
    return draft;
  }

  const recorded = settle(applyAnswer(draft, stepId, values), context);

  if (stepId === "join") {
    const chosen = joinsFor(draft, context).find((join) => join.id === values[0]);
    if (!chosen) return recorded;
    return {
      ...recorded,
      join: {
        op: chosen.toOp,
        rowsPath: context.shapes[chosen.toOp]?.rowsPath ?? "$",
        leftField: chosen.leftField,
        rightField: chosen.rightField,
        kind: "left",
        needsFanOut: chosen.fetch.mode === "perRow",
        maxRows: chosen.fetch.mode === "perRow" ? chosen.fetch.maxRows : 25,
        ...(chosen.fetch.mode === "filtered" && chosen.fetch.param
          ? { filterParam: chosen.fetch.param }
          : {}),
        ...(chosen.fetch.mode === "perRow" ? { fanOutParam: chosen.fetch.param } : {}),
      },
      // The pool just changed, so anything bound against the old one is stale.
      component: undefined,
      roles: {},
      answered: recorded.answered.filter((id) => !id.startsWith(ROLE_STEP) && id !== "component"),
    };
  }

  /*
   * The measurement, changed. Rebuilt rather than patched: a measure is one
   * decision — what is being counted — and half-updating it leaves a widget
   * whose value role names a column its own group step no longer produces.
   */
  if (stepId === "measure") {
    const chosen = values[0];
    if (!chosen) return recorded;
    const current = draft.shape ?? { groupBy: [], measures: [], sort: [] };
    const [agg, field] = chosen === MEASURE_COUNT ? ["count", undefined] : chosen.split(":");
    if (!agg) return recorded;
    return {
      ...recorded,
      shape: {
        ...current,
        measures: [
          field
            ? { as: field, agg: agg as "sum", field }
            : { as: SERIES_COUNT, agg: "count" as const },
        ],
      },
    };
  }

  if (stepId === "groupBy") {
    const chosen = values[0];
    const current = draft.shape ?? { groupBy: [], measures: [], sort: [] };
    if (!chosen) return { ...recorded, shape: { ...current, groupBy: [] } };
    const field = fieldPool(draft, context).find((candidate) => candidate.name === chosen);
    if (!field) return recorded;
    /*
     * A date follows the dashboard's own grain rather than pinning a bucket,
     * which is what keeps a chart moving with the board's time control.
     */
    const temporal = valueTypesOf(field).includes("temporal");
    return {
      ...recorded,
      shape: {
        ...current,
        groupBy: [{ field: chosen, ...(temporal ? { bucket: "{{range.grain}}" } : {}) }],
      },
    };
  }

  if (stepId === "filter") {
    // The only answer is the filter it already has, so anything else — and a
    // skip especially — means take it off.
    const current = draft.shape;
    if (!current) return recorded;
    const kept = values[0] === current.filter;
    return kept ? recorded : { ...recorded, shape: { ...current, filter: undefined } };
  }

  if (stepId.startsWith(SERIES_STEP)) {
    const index = Number.parseInt(stepId.slice(SERIES_STEP.length), 10);
    if (!Number.isInteger(index) || !draft.series[index]) return recorded;
    // Keeping it is the recommended answer, so only a different one removes.
    const kept = values[0] === draft.series[index]!.op;
    return kept
      ? recorded
      : { ...recorded, series: draft.series.filter((_, at) => at !== index) };
  }

  if (stepId === "choice") {
    const choice = draft.choice;
    const chosen = choice?.options.find((option) => option.op === values[0]);
    if (!choice || !chosen) return recorded;

    /*
     * A different set of records means different fields, so choosing the
     * primary resets what was bound to the old one. `applyAnswer` already does
     * exactly that for the endpoint question — this is the same answer arriving
     * through a different door.
     */
    if (choice.role === "primary") {
      const moved = applyAnswer({ ...recorded, choice: undefined }, "endpoint", [chosen.op]);
      return { ...moved, answered: [...new Set([...moved.answered, "choice"])] };
    }

    /*
     * A second endpoint that has to be read once per record is a price, not a
     * detail — so it becomes an offer rather than being applied, and the
     * existing consent step asks about it next.
     */
    const side = chosen.series;
    if (!side) return { ...recorded, choice: undefined };
    return side.fanOut
      ? { ...recorded, choice: undefined, offer: side, series: [] }
      : { ...recorded, choice: undefined, offer: undefined, series: [side] };
  }

  if (stepId === "offer") {
    /*
     * Taken or dropped, and either way the offer is gone: a priced question
     * that stays on the card after it has been answered invites the same
     * decision to be made twice.
     */
    if (!draft.offer) return recorded;
    return values[0] === "include"
      ? { ...recorded, series: [...draft.series, draft.offer], offer: undefined }
      : { ...recorded, offer: undefined };
  }

  if (stepId === "drilldown") {
    const chosen = context.drillDowns.find(
      (offer) => offer.listOp === draft.op && offer.detailOp === values[0],
    );
    if (!chosen) return recorded;
    return {
      ...recorded,
      drilldown: {
        op: chosen.detailOp,
        param: chosen.detailParam,
        idField: chosen.idField,
        fields: [],
        // Filled by the detail pass after the widget is confirmed, not here:
        // which fields lead, how they group and which collections belong
        // beside a record are all judgements. This step only records that
        // clicking a row opens one.
        groups: [],
        sections: [],
      },
    };
  }

  return recorded;
};

/**
 * How many questions are left, for a progress line that is honest about it.
 *
 * Answering a step can *add* steps — choosing a join changes the field pool
 * and reopens the view question — so this is the remaining path from here,
 * not a promise.
 */
export const remainingSteps = (draft: ConciergeDraft, context: ConciergeContext): number => {
  let count = 0;
  let current = draft;
  // Bounded: a step that failed to advance the draft would otherwise spin.
  for (let guard = 0; guard < 40; guard++) {
    const step = nextStep(current, context);
    if (!step) break;
    count++;

    /*
     * An effect step ends the count rather than being walked past.
     *
     * Its answer changes the world, not the draft — so simulating an answer
     * to it advances nothing and the walk would spin until the guard stopped
     * it, reporting "40 questions to go" on a card with two options on it.
     * What comes after a read genuinely is not knowable until the read has
     * happened, and a made-up number is worse than none.
     */
    if (EFFECT_STEPS.has(step.id)) break;

    /*
     * Every gating answer has to be *taken*, not just marked answered.
     *
     * `answered` alone does not advance the draft past a step whose guard is
     * the field itself — `if (!draft.op)` does not care what is in `answered`
     * — so a walk that only records ids loops on the same question until the
     * guard stops it, and the user is told there are forty questions left.
     */
    const chosen = (step.options.find((option) => option.recommended) ?? step.options[0])?.value;
    current = { ...current, answered: [...current.answered, step.id] };
    if (step.id === "connection") current = { ...current, connection: chosen };
    if (step.id === "endpoint") current = { ...current, op: chosen };
    if (step.id === "component") current = { ...current, component: chosen };
    if (step.id === "title") current = { ...current, title: chosen ?? "…" };
  }
  return count;
};
