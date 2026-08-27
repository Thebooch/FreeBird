import type {
  ChildCollection,
  ConciergeContext,
  ConciergeDraft,
  LlmAdapter,
  SectionDraft,
} from "@freebirdai/dash-agent";
import { planDetail, type ChildOption, type DetailGroup, type DetailHeader } from "@freebirdai/dash-agent";
import { COMPONENT_CONTRACTS } from "@freebirdai/dash-spec";

/**
 * What a record shows, worked out once the widget itself is settled.
 *
 * Deliberately a separate pass rather than part of building the widget, for
 * two reasons. It is only relevant to *some* widgets — a comparison of two
 * counts over time has no row to click and no record behind a data point — and
 * the component's own contract says which, so a chart never pays for a
 * question that cannot apply to it. And it runs after the widget is confirmed,
 * so a table somebody discarded never cost a model call for a detail view they
 * were never going to open.
 *
 * The choosing is the model's; the options are not. Which collections can hang
 * off a record is derived from the API's own relation graph, and every field
 * name the model returns is checked against what the record really carries.
 */

/** Whether a widget of this kind has records behind its marks. */
export const opensRecords = (component: string): boolean =>
  COMPONENT_CONTRACTS[component as keyof typeof COMPONENT_CONTRACTS]?.detail?.opensRecord ?? false;

/** Whether it can carry related collections beside the record. */
const takesChildren = (component: string): boolean =>
  COMPONENT_CONTRACTS[component as keyof typeof COMPONENT_CONTRACTS]?.detail?.childSections ?? false;

export interface DetailSetupInput {
  readonly llm: LlmAdapter;
  readonly context: ConciergeContext;
  /** The endpoint the widget lists. Children hang off this. */
  readonly listOp: string;
  /** The endpoint one record is opened from. */
  readonly detailOp: string;
  readonly component: string;
  readonly intent?: string | undefined;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface DetailSetup {
  /** Fields the record shows, in order. Empty means nothing was proposed. */
  readonly fields: readonly string[];
  /**
   * The identity block, when the record has one worth drawing.
   *
   * Absent leaves the record as a plain field list — the shape every record
   * had before this existed, so nothing regresses when a planner declines.
   */
  readonly header?: DetailHeader | undefined;
  /** Named sections over `fields`. Empty means one undifferentiated list. */
  readonly groups: readonly DetailGroup[];
  readonly sections: readonly SectionDraft[];
  /** The model's sentence about what it chose, for the user to read. */
  readonly reason: string;
  /** Everything it could have shown, so the chat can answer "what else?". */
  readonly available: {
    readonly fields: readonly string[];
    readonly children: readonly { readonly id: string; readonly title: string }[];
  };
  readonly notes: readonly string[];
}

const NOTHING: DetailSetup = {
  fields: [],
  groups: [],
  sections: [],
  reason: "",
  available: { fields: [], children: [] },
  notes: [],
};

/** The columns a child section shows. Few, and the readable ones first. */
const columnsFor = (fields: readonly { name: string }[]): string[] => {
  const flat = fields.map((field) => field.name).filter((name) => !name.includes("."));
  const nested = fields.map((field) => field.name).filter((name) => name.includes("."));
  // Nested names are usually the readable half of a reference — `Category.Name`
  // rather than the object around it — so they are worth keeping in the mix.
  return [...flat, ...nested].slice(0, 6);
};

/**
 * Propose what opening one record shows.
 *
 * Returns nothing at all for a component whose marks are aggregates, without
 * calling a model: there is no record behind a point on a monthly count, and
 * offering to configure one would promise a view that cannot exist.
 */
export const planDetailSetup = async (input: DetailSetupInput): Promise<DetailSetup> => {
  if (!opensRecords(input.component)) return NOTHING;

  const shape = input.context.shapes[input.detailOp];
  if (!shape || shape.fields.length === 0) {
    return { ...NOTHING, notes: [`Nothing has been read from "${input.detailOp}" yet.`] };
  }

  /*
   * The collections that hang off this record, with their own rows' shape so
   * columns can be chosen for them. Only those whose child endpoint has been
   * read — a section on an endpoint nobody has seen would have no columns to
   * show and would render as an empty box.
   */
  const candidates: ChildOption[] = takesChildren(input.component)
    ? input.context.children
        .filter((child: ChildCollection) => child.parentOp === input.listOp)
        .flatMap((child) => {
          const childShape = input.context.shapes[child.op];
          if (!childShape || childShape.fields.length === 0) return [];
          return [
            {
              id: child.id,
              title: child.title,
              op: child.op,
              linkField: child.linkField ?? "",
              /*
               * A parameter means the endpoint takes the parent's id, so one
               * request returns this record's rows. No parameter means the
               * collection is read under a page cap and matched afterwards,
               * which can come back empty for a record that does have rows.
               */
              exact: child.param !== undefined,
              fields: childShape.fields,
            },
          ];
        })
    : [];

  const recordTitle =
    input.context.ops.find((op) => op.id === input.listOp)?.title ?? input.detailOp;

  const plan = await planDetail(
    input.llm,
    {
      recordTitle,
      fields: shape.fields,
      children: candidates,
      ...(input.intent ? { intent: input.intent } : {}),
    },
    {
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  const available = {
    fields: shape.fields.map((field) => field.name),
    children: candidates.map((child) => ({ id: child.id, title: child.title })),
  };

  if (plan.fields.length === 0) {
    return { ...NOTHING, available, notes: plan.error ? [plan.error] : [] };
  }

  const byId = new Map(input.context.children.map((child) => [child.id, child]));
  const sections: SectionDraft[] = plan.children.flatMap((chosen) => {
    const source = byId.get(chosen.id);
    if (!source) return [];
    const childShape = input.context.shapes[chosen.op];
    return [
      {
        id: chosen.id,
        title: chosen.title,
        op: chosen.op,
        ...(source.linkField ? { linkField: source.linkField } : {}),
        ...(source.linkKind ? { linkKind: source.linkKind } : {}),
        ...(source.param ? { filterParam: source.param } : {}),
        columns: columnsFor(childShape?.fields ?? []),
        rowsPath: childShape?.rowsPath || "$",
      },
    ];
  });

  return {
    fields: plan.fields,
    ...(plan.header ? { header: plan.header } : {}),
    groups: plan.groups,
    sections,
    reason: plan.reason,
    available,
    /* Nothing to report on the happy path: every name came back checked. */
    notes: [],
  };
};

/**
 * Fold a planned record view into the draft, for whichever door confirmed it.
 *
 * There are two confirm paths — the chat's `confirm_setup` action and the
 * card's `POST /confirm` — and only the first one ever called the planner. So
 * pressing Add on the card produced a widget whose record view had no related
 * collections at all, however good the relationship graph underneath it was:
 * `buildFromDraft` reads `drilldown.sections`, and nothing but this fills them.
 *
 * That is the kind of divergence that cannot be found by reading either path,
 * because each is correct on its own. One implementation, called from both, is
 * the only version of this that stays true.
 *
 * A planner that is absent or declines leaves the draft exactly as it was: a
 * record view with the fields somebody already chose is a worse widget than one
 * with children, and a much better one than an error.
 */
export const settleDetail = async (
  draft: ConciergeDraft,
  plan: ((input: DetailPlanRequest) => Promise<DetailSetup>) | undefined,
): Promise<{ draft: ConciergeDraft; detail: DetailSetup | null }> => {
  if (!plan || !draft.drilldown || !draft.component || !draft.op) return { draft, detail: null };

  const detail = await plan({
    listOp: draft.op,
    detailOp: draft.drilldown.op,
    component: draft.component,
    ...(draft.intent ? { intent: draft.intent } : {}),
  });
  if (detail.fields.length === 0) return { draft, detail };

  return {
    draft: {
      ...draft,
      drilldown: {
        ...draft.drilldown,
        fields: [...detail.fields],
        ...(detail.header
          ? { header: { ...detail.header, facts: [...detail.header.facts] } }
          : {}),
        groups: detail.groups.map((group) => ({ title: group.title, fields: [...group.fields] })),
        sections: detail.sections.map((section) => ({ ...section, columns: [...section.columns] })),
      },
    },
    /*
     * Handed back as well as applied, because the chat answers "what else
     * could it show?" from `available` — and going to look a second time
     * would spend another call to learn what this one already returned.
     */
    detail,
  };
};

/** What `settleDetail` needs from a planner, named so both callers can type it. */
export interface DetailPlanRequest {
  readonly listOp: string;
  readonly detailOp: string;
  readonly component: string;
  readonly intent?: string | undefined;
}
