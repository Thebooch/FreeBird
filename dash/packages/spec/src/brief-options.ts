import type { WidgetBrief } from "./brief-schema.js";
import { columnForPath } from "./brief.js";
import type { BuiltinComponentId } from "./contracts.js";
import type { EntityField, EntitySpec } from "./entity.js";
import { entityById } from "./entity.js";
import type { EntityGraph } from "./entity-graph.js";
import { FACET_MAX_PER_WIDGET, FACET_MAX_VALUES } from "./facet.js";
import { humanLabel } from "./presentation.js";
import { defaultFacets, defaultSort, recipeFor } from "./recipes.js";

/**
 * What a widget's request may be changed to, derived from the record type.
 *
 * The other half of storing the brief. A widget carries the sentence it was
 * compiled from, and this says what else that sentence could have said — which
 * fields it could show, what it could be narrowed by, what it could be set
 * beside. Pure, and a function of the record type rather than of a
 * conversation, so the same controls appear whether a widget is being previewed
 * or has been on a board for a month. Before this, a widget's decisions came
 * from a *draft*, and the draft was destroyed the moment it was added.
 *
 * **The same shape a setup question has.** A control and a question are one
 * thing seen from different ends — the card's own comment says so — so these
 * render through the components that already exist rather than through a second
 * set that would drift from them. What changes is only where they are derived:
 * from `allStepsAcross(draft)` there, from the brief and the record type here.
 *
 * **The record type is not among them.** Changing which records a widget is
 * about is not an edit to it; it is a different widget, and pretending
 * otherwise would mean silently discarding every column, filter and sort that
 * named a field the new record type has never heard of.
 */

/** One thing a control may be set to. */
export interface BriefOption {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
}

/** One decision about a widget, and what it is currently set to. */
export interface BriefControl {
  readonly stepId: string;
  readonly question: string;
  readonly help: string | null;
  readonly multiple: boolean;
  readonly skippable: boolean;
  /** A typed answer is accepted instead of an option. */
  readonly freeText: boolean;
  readonly options: readonly BriefOption[];
  readonly value: readonly string[];
  /** False for a control still showing what the record type chose for it. */
  readonly settled: boolean;
  /** A widget cannot exist without this one. */
  readonly required: boolean;
}

/** How many fields a control lists before it stops being a list. */
const MAX_OPTIONS = 40;

/** The fields somebody could be shown at all. */
const visible = (entity: EntitySpec): readonly EntityField[] =>
  entity.fields.filter((field) => field.visibility !== "hidden");

const labelOf = (field: EntityField): string => field.label ?? humanLabel(field.path);

const optionFor = (field: EntityField, recommended = false): BriefOption => ({
  value: field.path,
  label: labelOf(field),
  description: field.description ?? null,
  recommended,
});

/**
 * A field that can be counted along rather than read.
 *
 * An object or a list is neither: a strip of them reads "[object Object]", and
 * a chart broken down by one draws a single bar with everything in it.
 */
const categorical = (field: EntityField): boolean =>
  !field.kinds.includes("object") &&
  !field.kinds.includes("array") &&
  field.semantic !== "timestamp";

/** A field a number can be totalled from. */
const TOTALLABLE = new Set(["currency", "number", "count", "duration", "bytes", "percent"]);

const numeric = (field: EntityField): boolean =>
  Boolean(field.semantic && TOTALLABLE.has(field.semantic)) &&
  !field.kinds.includes("object") &&
  !field.kinds.includes("array");

/**
 * The readings this kind of record supports, given what it carries.
 *
 * A card with no name and a feed with no date cannot be bound, so offering
 * them would be offering a widget that renders as a binding error. The same
 * question `compileBrief` answers when it falls back to a table.
 */
const viewsFor = (entity: EntitySpec): readonly BuiltinComponentId[] => {
  const named = (entity.display?.title ?? []).length > 0;
  const dated =
    Boolean(entity.views.timeField) || visible(entity).some((one) => one.semantic === "timestamp");
  const views: BuiltinComponentId[] = ["table"];
  if (named) views.push("cards", "list");
  if (named && dated) views.push("feed");
  return views;
};

const VIEW_LABELS: Partial<Record<BuiltinComponentId, { label: string; help: string }>> = {
  table: { label: "A table", help: "Every column side by side. Best when there are several." },
  cards: { label: "Cards", help: "One tile each, with a name and a couple of details." },
  list: { label: "A list", help: "One line each — the most rows in the least room." },
  feed: { label: "A feed", help: "Newest first, read as things that happened." },
};

export interface BriefOptionsInput {
  readonly brief: WidgetBrief;
  readonly entity: EntitySpec;
  /**
   * The rest of the API, where the caller has it.
   *
   * Only `alongside` needs it. Without it every other control is unaffected
   * and the second-record-type control simply does not appear, which is
   * honest: nothing here can say what this record could be set beside.
   */
  readonly graph?: EntityGraph | undefined;
  readonly entities?: readonly EntitySpec[] | undefined;
}

/**
 * Every decision this widget's brief holds, and what else each could be.
 */
export const briefOptions = (input: BriefOptionsInput): BriefControl[] => {
  const { brief, entity } = input;
  const controls: BriefControl[] = [];
  const fields = visible(entity);
  const recipe = recipeFor(entity.kind);
  const records = brief.intent === "records";

  controls.push({
    stepId: "title",
    question: "What should it be called?",
    help: null,
    multiple: false,
    skippable: true,
    freeText: true,
    options: [],
    value: brief.title ? [brief.title] : [],
    settled: Boolean(brief.title),
    required: false,
  });

  if (records) {
    const views = viewsFor(entity);
    controls.push({
      stepId: "view",
      question: "How should it look?",
      help: null,
      multiple: false,
      skippable: false,
      freeText: false,
      options: views.map((id) => ({
        value: id,
        label: VIEW_LABELS[id]?.label ?? id,
        description: VIEW_LABELS[id]?.help ?? null,
        recommended: id === recipe.component,
      })),
      /*
       * Absent shows what the record type would be read as, rather than
       * claiming a choice nobody made.
       */
      value: [brief.view ?? recipe.component],
      settled: Boolean(brief.view),
      required: true,
    });

    const chosen = brief.columns ?? entity.views.columns;
    controls.push({
      stepId: "columns",
      question: "Which fields should it show?",
      help: "The record type's own choice, until you make one.",
      multiple: true,
      skippable: false,
      freeText: false,
      options: fields.slice(0, MAX_OPTIONS).map((field) =>
        optionFor(field, entity.views.columns.includes(field.path)),
      ),
      value: [...chosen],
      settled: Boolean(brief.columns),
      required: true,
    });

    const facetable = fields.filter(categorical);
    const asked = brief.filters?.map((one) => one.field);
    controls.push({
      stepId: "filters",
      question: "What should the reader be able to narrow it by?",
      help: `A strip of values above the rows, with a count beside each. Up to ${FACET_MAX_PER_WIDGET}.`,
      multiple: true,
      skippable: true,
      freeText: false,
      options: facetable.slice(0, MAX_OPTIONS).map((field) =>
        optionFor(field, defaultFacets(entity).includes(field.path)),
      ),
      value: [...(asked ?? defaultFacets(entity))],
      settled: asked !== undefined,
      required: false,
    });

    /*
     * What each strip starts narrowed to, offered only where the API states
     * the values. A sample cannot establish them — rows show what an account
     * happens to have — so a strip built from data alone has no tile for the
     * status nobody is currently in.
     */
    for (const filter of brief.filters ?? []) {
      const field = entity.fields.find((one) => one.path === filter.field);
      if (!field || field.values.length === 0) continue;
      controls.push({
        stepId: `narrow:${filter.field}`,
        question: `Which ${labelOf(field).toLowerCase()} should it start on?`,
        help: "Everything, unless you pick some. The reader can always widen it.",
        multiple: true,
        skippable: true,
        freeText: false,
        options: field.values.slice(0, FACET_MAX_VALUES).map((value) => ({
          value,
          label: value,
          description: null,
          recommended: false,
        })),
        value: [...(filter.values ?? [])],
        settled: (filter.values ?? []).length > 0,
        required: false,
      });
    }

    const sortable = fields.filter((field) => !field.kinds.includes("object"));
    const fallback = defaultSort(entity);
    controls.push({
      stepId: "sort",
      question: "What should it be ordered by?",
      help: null,
      multiple: false,
      skippable: true,
      freeText: false,
      options: sortable.slice(0, MAX_OPTIONS).map((field) =>
        optionFor(field, field.path === fallback?.field),
      ),
      value: brief.sort ? [brief.sort.field] : fallback ? [fallback.field] : [],
      settled: Boolean(brief.sort),
      required: false,
    });

    if (brief.sort ?? fallback) {
      controls.push({
        stepId: "sortDir",
        question: "Which way round?",
        help: null,
        multiple: false,
        skippable: false,
        freeText: false,
        options: [
          { value: "desc", label: "Newest or largest first", description: null, recommended: true },
          { value: "asc", label: "Oldest or smallest first", description: null, recommended: false },
        ],
        value: [brief.sort?.dir ?? fallback?.dir ?? recipe.sortDir],
        settled: Boolean(brief.sort?.dir),
        required: false,
      });
    }
  } else {
    const totals = fields.filter(numeric);
    controls.push({
      stepId: "measure",
      question: "What is being measured?",
      help: null,
      multiple: false,
      skippable: false,
      freeText: false,
      options: [
        {
          value: "count",
          label: `How many ${entity.name.many.toLowerCase()}`,
          description: null,
          recommended: true,
        },
        ...totals.slice(0, MAX_OPTIONS).map((field) => ({
          value: `sum:${field.path}`,
          label: `Total ${labelOf(field).toLowerCase()}`,
          description: field.description ?? null,
          recommended: false,
        })),
      ],
      value: [
        brief.measure && brief.measure.agg !== "count" && brief.measure.field
          ? `sum:${brief.measure.field}`
          : "count",
      ],
      settled: Boolean(brief.measure),
      required: true,
    });

    if (brief.intent === "compare") {
      const across = fields.filter((field) => categorical(field) || field.semantic === "timestamp");
      controls.push({
        stepId: "groupBy",
        question: "Broken down by what?",
        help: "A date is counted by month.",
        multiple: false,
        skippable: false,
        freeText: false,
        options: across.slice(0, MAX_OPTIONS).map((field) => optionFor(field)),
        value: brief.groupBy ? [brief.groupBy] : [],
        settled: Boolean(brief.groupBy),
        required: true,
      });
    }
  }

  /*
   * Fields read through a reference — a task's vendor's phone number. Only
   * where the field really points at another record, because following
   * something that is not a reference leaves a column blank forever, which
   * looks exactly like a value this record happens not to have.
   */
  const references = input.graph?.referencesOf(entity.id) ?? [];
  if (records && references.length > 0 && input.entities) {
    const options: BriefOption[] = [];
    for (const reference of references) {
      const far = entityById(input.entities, reference.target);
      if (!far) continue;
      for (const field of visible(far).slice(0, 6)) {
        options.push({
          value: `${reference.field}.${field.path}`,
          label: `${far.name.one}: ${labelOf(field)}`,
          description: `Read through ${reference.label ?? humanLabel(reference.field)}.`,
          recommended: false,
        });
      }
    }
    if (options.length > 0) {
      controls.push({
        stepId: "linked",
        question: "Anything from a record this one points at?",
        help: "Fetched once per referenced record and filled in beside the rest.",
        multiple: true,
        skippable: true,
        freeText: false,
        options: options.slice(0, MAX_OPTIONS),
        value: (brief.linked ?? []).map((one) => `${one.through}.${one.field}`),
        settled: (brief.linked ?? []).length > 0,
        required: false,
      });
    }
  }

  /*
   * A second record type, where one can be reached. The graph already knows
   * which and at what cost, so this offers only what could actually be built
   * rather than every record type the API has.
   */
  const graph = input.graph;
  if (graph && input.entities) {
    const reachable = new Map<string, string>();
    for (const reference of graph.referencesOf(entity.id)) {
      const far = entityById(input.entities, reference.target);
      if (far) reachable.set(far.id, `Each ${entity.name.one.toLowerCase()} points at one.`);
    }
    for (const back of graph.backrefsOf(entity.id)) {
      if (back.reach.mode !== "filter" || reachable.has(back.entity)) continue;
      const far = entityById(input.entities, back.entity);
      if (far) reachable.set(far.id, `They carry a ${entity.name.one.toLowerCase()}'s identity.`);
    }
    /*
     * A collection that only lives inside one of these, last and with its
     * price.
     *
     * Last because it is the only one here that spends a request per record,
     * and an option whose cost is discovered afterwards is an option offered
     * dishonestly. Offered at all only where the far rows say which record
     * they belong to — the compiler refuses the rest, and a control that
     * builds a note instead of a widget is a control that does nothing.
     */
    for (const back of graph.backrefsOf(entity.id)) {
      if (back.reach.mode !== "path" || reachable.has(back.entity)) continue;
      const far = entityById(input.entities, back.entity);
      if (!far) continue;
      if (!graph.referencesOf(far.id).some((one) => one.target === entity.id)) continue;
      reachable.set(far.id, `Listed one ${entity.name.one.toLowerCase()} at a time, so this costs a request each.`);
    }
    if (reachable.size > 0) {
      controls.push({
        stepId: "alongside",
        question: "Anything shown beside these?",
        help: "Their fields arrive on each row.",
        multiple: false,
        skippable: true,
        freeText: false,
        options: [...reachable].slice(0, MAX_OPTIONS).map(([id, why]) => {
          const far = entityById(input.entities ?? [], id);
          return {
            value: id,
            label: far?.name.many ?? id,
            description: why,
            recommended: false,
          };
        }),
        value: brief.alongside ? [brief.alongside.entity] : [],
        settled: Boolean(brief.alongside),
        required: false,
      });
    }
  }

  return controls;
};

/**
 * A control's answer, folded back into the brief.
 *
 * The inverse of the derivation above and deliberately in the same file: a
 * control that reads a field and an answer that writes a different one is a
 * setting that appears to do nothing, and keeping the pair together is what
 * makes that visible when either changes.
 *
 * An empty answer means *cleared* rather than unanswered, so a strip can be
 * turned off and a title can be given back to the record type. The one
 * exception is a required control, where nothing chosen leaves what was there.
 */
export const answerBrief = (
  brief: WidgetBrief,
  stepId: string,
  values: readonly string[],
): WidgetBrief => {
  const first = values[0];

  if (stepId === "title") {
    const title = first?.trim();
    return title ? { ...brief, title } : { ...brief, title: undefined };
  }
  if (stepId === "view") {
    return first === "table" || first === "cards" || first === "list" || first === "feed"
      ? { ...brief, view: first }
      : { ...brief, view: undefined };
  }
  if (stepId === "columns") {
    return { ...brief, columns: values.length > 0 ? [...values] : undefined };
  }
  if (stepId === "filters") {
    /*
     * The values each strip was narrowed to survive a change to which strips
     * there are, so reordering them does not silently widen one.
     */
    const kept = new Map((brief.filters ?? []).map((one) => [one.field, one] as const));
    return {
      ...brief,
      filters: values.map((field) => kept.get(field) ?? { field }),
    };
  }
  if (stepId.startsWith("narrow:")) {
    const field = stepId.slice("narrow:".length);
    return {
      ...brief,
      filters: (brief.filters ?? []).map((one) =>
        one.field === field ? { field, ...(values.length > 0 ? { values: [...values] } : {}) } : one,
      ),
    };
  }
  if (stepId === "sort") {
    return first
      ? { ...brief, sort: { field: first, ...(brief.sort?.dir ? { dir: brief.sort.dir } : {}) } }
      : { ...brief, sort: undefined };
  }
  if (stepId === "sortDir") {
    return brief.sort && (first === "asc" || first === "desc")
      ? { ...brief, sort: { ...brief.sort, dir: first } }
      : brief;
  }
  if (stepId === "measure") {
    if (!first || first === "count") return { ...brief, measure: { agg: "count" } };
    const [, field] = first.split(/:(.*)/s);
    return field ? { ...brief, measure: { agg: "sum", field } } : brief;
  }
  if (stepId === "groupBy") {
    return first ? { ...brief, groupBy: first } : brief;
  }
  if (stepId === "linked") {
    return {
      ...brief,
      linked:
        values.length > 0
          ? values.flatMap((entry) => {
              /*
               * The last segment is the field on the far record; everything
               * before it is the path to the reference, which may itself nest.
               */
              const cut = entry.lastIndexOf(".");
              return cut > 0
                ? [{ through: entry.slice(0, cut), field: entry.slice(cut + 1) }]
                : [];
            })
          : undefined,
    };
  }
  if (stepId === "alongside") {
    return first
      ? { ...brief, alongside: { entity: first, as: brief.alongside?.as ?? "join" } }
      : { ...brief, alongside: undefined };
  }
  return brief;
};
