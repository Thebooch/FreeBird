import { widgetShapeSchema } from "@freebirdai/dash-spec";
import { z } from "zod";

/**
 * A widget being built, one answer at a time.
 *
 * The concierge is a deterministic state machine over this object. The model
 * reads the opening intent and picks among options the machine computed; it
 * never writes a field name here, because a name it invented would not be in
 * the option list it was given.
 *
 * Deliberately not a tool schema — the flat-subset rule governs what the model
 * is handed, not what the server stores, so this can use the records and
 * unions the real shape needs.
 */

const fieldName = z.string().min(1).max(160);

export const joinDraftSchema = z.object({
  op: z.string().min(1),
  rowsPath: z.string().default("$"),
  /** Field on the primary rows carrying the other endpoint's identity. */
  leftField: fieldName,
  /** Field on the joined rows it matches. */
  rightField: fieldName,
  kind: z.enum(["inner", "left"]).default("left"),
  /**
   * Whether the target can be filtered by the key, or has to be asked once per
   * row. Carried on the draft because it is the difference between one request
   * and twenty-five, and the person choosing deserves to have been told.
   */
  needsFanOut: z.boolean().default(false),
  /** The query parameter that makes it one request, when there is one. */
  filterParam: z.string().max(160).optional(),
  /**
   * The input the per-row call feeds, when there is no filter parameter.
   *
   * A fan-out with nowhere to put the key is not a join, it is the same
   * request repeated — so its absence is what stops such a join being offered
   * at all, rather than something discovered when the build fails.
   */
  fanOutParam: z.string().max(160).optional(),
  /** Cap on per-row calls. Reported, never silently applied. */
  maxRows: z.number().int().min(1).max(100).default(25),
});

export type JoinDraft = z.infer<typeof joinDraftSchema>;

/**
 * A second endpoint measured alongside the first, rather than joined to it.
 *
 * "How many listings per month against how many applications per month" is not
 * a join and cannot be made into one: neither set of rows is an attribute of
 * the other, and there is nothing to match them on. They are two counts over a
 * shared axis, and the only thing they have in common is the bucket.
 *
 * So each side is grouped by its own time field and the results are stacked,
 * with a label naming which is which. That is what the chart wants — one row
 * per bucket per series — and it is why this is a separate shape rather than
 * another kind of join.
 */
export const compareDraftSchema = z.object({
  op: z.string().min(1),
  rowsPath: z.string().default("$"),
  /** Time field on the primary rows. */
  leftTimeField: fieldName,
  /** Time field on the compared endpoint's rows. */
  rightTimeField: fieldName,
  /** What to call each side where a person reads it. */
  leftLabel: z.string().min(1).max(80),
  rightLabel: z.string().min(1).max(80),
  /**
   * What is being measured on each side.
   *
   * Only `count` for now, and deliberately: counting rows is the whole of what
   * "how many X" means, and it is the thing that was silently getting turned
   * into the sum of whichever number happened to be nearby.
   */
  measure: z.literal("count").default("count"),
});

export type CompareDraft = z.infer<typeof compareDraftSchema>;

/**
 * A second measurement drawn beside the first.
 *
 * The general form of `compare` above, which could say exactly one thing:
 * two endpoints, counted, over a date. Everything real about that shape was
 * the union — each side reduced to the same columns and stacked, with a label
 * saying which is which — and none of it required the axis to be a date, the
 * measure to be a count, or there to be exactly two.
 *
 * So a series is just another source with its own shape. The primary stays
 * `draft.op` + `draft.shape`; these are the ones beside it. The runtime needed
 * no change at all: `sources` already allows four and the union already stacks
 * every one of them.
 */
export const seriesDraftSchema = z.object({
  op: z.string().min(1),
  rowsPath: z.string().default("$"),
  /** What to call this side where a person reads it. Never an op id. */
  label: z.string().min(1).max(80),
  /**
   * How this side is measured.
   *
   * Its own, deliberately: the two sides are different endpoints with
   * different field names, and the only thing they have to agree on is the
   * name of the column they group into. That agreement is the builder's job,
   * not something each side should have to know about the other.
   */
  shape: widgetShapeSchema,
  /**
   * Where this endpoint's input comes from, when it cannot be called bare.
   *
   * A collection that only exists under a parent — a record's notes, an
   * applicant's applications — is reachable only by asking once per parent
   * row. Recorded here so the cost is visible in the draft rather than
   * discovered when the widget runs.
   */
  fanOut: z
    .object({
      /** The source whose rows drive the calls. */
      from: z.string().min(1),
      /** Field on those rows supplying this endpoint's input. */
      field: fieldName,
      /** Which input it feeds. Defaults to the field's own name. */
      as: z.string().min(1).max(120).optional(),
      maxRows: z.number().int().min(1).max(100).default(25),
    })
    .optional(),
});

export type SeriesDraft = z.infer<typeof seriesDraftSchema>;

/**
 * Two readings of the same request, put to the person who made it.
 *
 * The pick is a single required id, so a model looking at two defensible
 * readings had to commit to one and had no way to say the other was there.
 * That is right when both would produce the same answer and wrong when they
 * would not: counting the things somebody submitted and counting the people
 * who submitted them are different numbers, and "they can change it in the
 * settings" only helps somebody who already noticed it was wrong.
 *
 * Deliberately rare. A question asked on every build is the endpoint list this
 * whole flow exists to replace, so the model is told to commit unless the two
 * readings genuinely answer different questions — and one option is always the
 * one already applied, so the widget on screen is what happens if nobody
 * answers.
 *
 * Each option is prepared in full at proposal time, while the shapes are in
 * hand. Answering then swaps in something ready rather than re-deriving a time
 * field for an endpoint the machine would have to go and look up.
 */
export const choiceDraftSchema = z.object({
  /** Which pick this is a choice about. */
  role: z.enum(["primary", "secondary"]),
  options: z
    .array(
      z.object({
        op: z.string().min(1),
        /** The endpoint's own title, for the option's heading. */
        label: z.string().min(1).max(120),
        /**
         * What these records are, in the model's words.
         *
         * The one thing no schema can derive: only the model can say "the
         * applications people submitted" against "the people who applied".
         */
        whatItIs: z.string().min(1).max(200),
        /** Prepared side, for a choice about the second endpoint. */
        series: seriesDraftSchema.optional(),
      }),
    )
    .min(2)
    .max(3),
});

export type ChoiceDraft = z.infer<typeof choiceDraftSchema>;

/**
 * A narrowing to a set of values a person confirmed.
 *
 * Held on the draft rather than applied straight to a widget so it shows up as
 * a decision with a control, like every other one: the card can say "showing
 * only Maintenance and Plumbing" and let it be changed, which is the whole
 * point of having asked.
 */
export const narrowDraftSchema = z.object({
  field: fieldName,
  /** Strings and numbers stay as they are — `"3"` matches nothing when the row holds `3`. */
  values: z.array(z.union([z.string().max(200), z.number()])).min(1).max(60),
  /** The user's phrase, carried so a confirmation can be saved under it. */
  phrase: z.string().max(120).optional(),
  /** The query parameter that applies it upstream, where the endpoint has one. */
  filterParam: z.string().max(160).optional(),
});

export type NarrowDraft = z.infer<typeof narrowDraftSchema>;

/**
 * A related collection shown beside a record — a task's notes, a unit's files.
 *
 * Carries how it is fetched as well as what it is, because those are different
 * facts: `filterParam` narrows the request when the endpoint declares one, and
 * `linkField` matches the rows when it does not. Sending an invented parameter
 * is worse than not filtering — an API free to ignore it answers 200 with the
 * whole collection, so the section looks healthy while showing every record in
 * the account.
 */
export const sectionDraftSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /** The endpoint listing the collection. */
  op: z.string().min(1),
  /**
   * Field on the child rows carrying the parent's identity.
   *
   * Optional, because a section fetched through a path parameter or a declared
   * filter has no field to match on — the endpoint did the narrowing. Writing
   * an empty string for those was worse than it looks: `parseDraft` rejects
   * the whole draft rather than the one field, so a record view with a scoped
   * child collection read back as "no setup in progress" and the entire
   * conversation's work disappeared.
   */
  linkField: fieldName.optional(),
  /** Whether that field holds one id or a list of them. */
  linkKind: z.enum(["scalar", "array"]).optional(),
  /** The query parameter that narrows it upstream, where one is declared. */
  filterParam: z.string().max(160).optional(),
  columns: z.array(fieldName).max(12).default([]),
  rowsPath: z.string().default("$"),
});

export type SectionDraft = z.infer<typeof sectionDraftSchema>;

/**
 * The block at the top of a record: what it is, and the few values worth
 * reading before the rest.
 *
 * Optional throughout. A record with no header renders as a plain field list,
 * which is what every record did before this existed — so the absence is a
 * previous version of the design rather than a broken one.
 */
export const headerDraftSchema = z.object({
  title: fieldName.optional(),
  subtitle: fieldName.optional(),
  status: fieldName.optional(),
  facts: z.array(fieldName).max(4).default([]),
});

export type HeaderDraft = z.infer<typeof headerDraftSchema>;

/**
 * A named section of the record's body.
 *
 * Anything no group claims still appears, in an unnamed section at the end —
 * so grouping arranges what is there and can never hide it. The failure mode
 * of the alternative is silent, and looks exactly like data going missing.
 */
export const fieldGroupDraftSchema = z.object({
  title: z.string().min(1).max(120),
  fields: z.array(fieldName).min(1),
});

export type FieldGroupDraft = z.infer<typeof fieldGroupDraftSchema>;

export const drilldownDraftSchema = z.object({
  op: z.string().min(1),
  /** The detail endpoint's input that the row's identity feeds. */
  param: z.string().min(1).max(160),
  /** The row field holding that identity. */
  idField: fieldName,
  fields: z.array(fieldName).max(40).default([]),
  /** The identity block, when one was planned. */
  header: headerDraftSchema.optional(),
  /** Sections over `fields`. Empty means one undifferentiated list. */
  groups: z.array(fieldGroupDraftSchema).max(8).default([]),
  /**
   * Related collections shown beside the record.
   *
   * Four is the spec's cap on sections and more than anybody scans. Empty is
   * the common case and not a gap — most records have nothing hanging off
   * them worth a tab.
   */
  sections: z.array(sectionDraftSchema).max(4).default([]),
});

export type DrilldownDraft = z.infer<typeof drilldownDraftSchema>;

export const conciergeDraftSchema = z.object({
  id: z.string().min(1),
  /**
   * Who is driving.
   *
   * `wizard` asks every applicable question in order — the deterministic path,
   * and the whole experience on an install with no AI key. `assisted` lets the
   * assistant fill the draft in one go from a conversation and asks only about
   * the decisions that *block* a widget; everything else becomes a control on
   * the approval card, next to a live preview of the thing being described.
   *
   * The draft itself is identical either way. What differs is the order things
   * are decided in, which is the only thing that was ever wrong with the
   * question-at-a-time flow.
   */
  mode: z.enum(["assisted", "wizard"]).default("wizard"),
  /** What the person said they wanted, kept so the summary can echo it back. */
  intent: z.string().max(2_000).optional(),
  /**
   * When this setup began, as an ISO instant.
   *
   * Drafts are durable on purpose — losing eight answers to a restart is the
   * thing durability exists to prevent — but durable and *abandoned* are
   * different states, and nothing recorded which one a draft was in. So a
   * setup the assistant had started one second earlier was presented to the
   * user as an unfinished job to resume or throw away, which is the question
   * the durable draft was supposed to avoid asking.
   *
   * Optional because drafts written before this existed have none, and an
   * undated draft is treated as old — the safe direction: it asks a question
   * that was already being asked, rather than silently resuming something
   * nobody remembers starting.
   */
  startedAt: z.string().optional(),
  /**
   * The model that proposed this setup, if one did.
   *
   * Carried so the finished widget can record who designed it — the actions
   * route to different models now, and two widgets on one board may not have
   * been built by the same one. Absent on a draft answered entirely by hand,
   * which is the truthful answer rather than a missing field: nobody's model
   * chose anything.
   */
  model: z.string().min(1).max(120).optional(),
  connection: z.string().min(1).optional(),
  op: z.string().min(1).optional(),
  rowsPath: z.string().default("$"),
  join: joinDraftSchema.optional(),
  /**
   * Superseded by `series`, and kept only so a draft written before that
   * existed still parses. `settle` migrates it; nothing else reads it.
   */
  compare: compareDraftSchema.optional(),
  /** Measurements drawn beside the primary one. Three at most — four sources. */
  series: z.array(seriesDraftSchema).max(3).default([]),
  /**
   * A measurement worked out but not yet paid for.
   *
   * A nested collection can only be counted by asking once per parent record,
   * so including one spends real requests against somebody's account. The
   * assistant can work out that it is the right answer; it cannot decide that
   * the answer is worth the price.
   *
   * So it sits here, priced, until somebody says yes — and only then moves
   * into `series`. Nothing is fetched in the meantime, because the preview is
   * what spends the requests and there is nothing to preview until it is
   * included. Declining leaves a widget built from the rest, which is a real
   * answer rather than a dead end.
   */
  offer: seriesDraftSchema.optional(),
  /**
   * A reading of the request the model was genuinely torn about.
   *
   * Present only when two endpoints would answer different questions; absent
   * on almost every build, which is the point.
   */
  choice: choiceDraftSchema.optional(),
  narrow: narrowDraftSchema.optional(),
  /**
   * What this widget measures, over what buckets, filtered how.
   *
   * The thing a draft could not previously hold. It knew which endpoint and
   * which fields, and had nowhere to record that the rows were being *counted*
   * — so "how many listings per month" was unanswerable while "the total rent
   * of the listings per month" was not, and the machine asked which number to
   * plot because that was the only question its shape could produce.
   *
   * Optional, and absent means exactly the old behaviour: raw rows bound to
   * roles. Present, it is emitted by the one shared emitter and shows up as
   * one editable control per decision.
   */
  shape: widgetShapeSchema.optional(),
  component: z.string().min(1).optional(),
  /** role → column, or columns for a multi role. */
  roles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  /** Presentation setting ids the user turned on, e.g. `searchable`. */
  options: z.array(z.string().max(64)).max(20).default([]),
  drilldown: drilldownDraftSchema.optional(),
  /** Columns accepted from the "these look related" step. */
  extras: z.array(fieldName).max(40).default([]),
  /** Columns accepted for status marking. */
  highlights: z.array(fieldName).max(8).default([]),
  title: z.string().max(120).optional(),
  /** Steps already answered, so the machine knows what not to ask again. */
  answered: z.array(z.string().max(64)).max(60).default([]),
  /** Steps explicitly skipped. Distinct from unanswered. */
  skipped: z.array(z.string().max(64)).max(60).default([]),
});

export type ConciergeDraft = z.infer<typeof conciergeDraftSchema>;

export const newDraft = (
  id: string,
  intent?: string,
  mode: ConciergeDraft["mode"] = "wizard",
  now: () => Date = () => new Date(),
): ConciergeDraft =>
  conciergeDraftSchema.parse({
    id,
    mode,
    startedAt: now().toISOString(),
    ...(intent ? { intent } : {}),
  });

/** Role steps are `role:<name>`, so the machine can ask one per role. */
export const ROLE_STEP = "role:";
export const isRoleStep = (stepId: string): boolean => stepId.startsWith(ROLE_STEP);
export const roleOfStep = (stepId: string): string => stepId.slice(ROLE_STEP.length);

/**
 * Record an answer.
 *
 * Pure, and total: an unknown step id is recorded as answered without changing
 * anything else, so a stale card from a reloaded page cannot corrupt a draft
 * that has since moved on.
 */
export const applyAnswer = (
  draft: ConciergeDraft,
  stepId: string,
  values: readonly string[],
): ConciergeDraft => {
  const answered = draft.answered.includes(stepId) ? draft.answered : [...draft.answered, stepId];
  const next: ConciergeDraft = { ...draft, answered };

  if (isRoleStep(stepId)) {
    const role = roleOfStep(stepId);
    if (values.length === 0) return next;
    return {
      ...next,
      roles: { ...next.roles, [role]: values.length === 1 ? values[0]! : [...values] },
    };
  }

  switch (stepId) {
    case "connection":
      // Choosing a different connection invalidates everything downstream: the
      // endpoints, the fields and every binding belong to the old one.
      return values[0] && values[0] !== draft.connection
        ? {
            ...newDraft(draft.id, draft.intent, draft.mode),
            // Still the same sitting: this is one answer inside it, not a new
            // one, and treating it as new would ambush the user with the
            // resume question mid-conversation.
            ...(draft.startedAt ? { startedAt: draft.startedAt } : {}),
            connection: values[0],
          }
        : next;

    case "endpoint":
      return values[0] && values[0] !== draft.op
        ? {
            ...next,
            op: values[0],
            // The fields changed, so bindings against the old ones are stale —
            // and so is the view, which was only offered because the *previous*
            // endpoint's fields could fill it.
            component: undefined,
            roles: {},
            join: undefined,
            compare: undefined,
            narrow: undefined,
            drilldown: undefined,
            extras: [],
            highlights: [],
            answered: answered.filter((id) => !isRoleStep(id) && id !== "component"),
          }
        : next;

    case "component":
      return values[0] && values[0] !== draft.component
        ? {
            ...next,
            component: values[0],
            // A different view asks for different roles.
            roles: {},
            answered: answered.filter((id) => !isRoleStep(id)),
          }
        : next;

    case "options":
      return { ...next, options: [...values] };

    case "extras":
      return { ...next, extras: [...values] };

    case "highlights":
      return { ...next, highlights: [...values] };

    case "drilldownFields":
      return next.drilldown
        ? { ...next, drilldown: { ...next.drilldown, fields: [...values] } }
        : next;

    case "title":
      return values[0] ? { ...next, title: values[0] } : next;

    default:
      return next;
  }
};

/** Mark a step declined, so it is not asked again. */
export const skipStep = (draft: ConciergeDraft, stepId: string): ConciergeDraft => {
  const marked = {
    ...draft,
    answered: draft.answered.includes(stepId) ? draft.answered : [...draft.answered, stepId],
    skipped: draft.skipped.includes(stepId) ? draft.skipped : [...draft.skipped, stepId],
  };

  /*
   * Some steps are things the widget already *has*, so declining one means
   * taking it off rather than leaving it unset.
   *
   * A filter and a comparison are both like this: the question is not "would
   * you like one" but "keep the one that is there". Marking it answered and
   * changing nothing would leave a control that reads as removed and a widget
   * that still narrows its rows — silent, and precisely wrong.
   */
  if (stepId === "filter" && marked.shape) {
    return { ...marked, shape: { ...marked.shape, filter: undefined } };
  }
  if (stepId === "groupBy" && marked.shape) {
    return { ...marked, shape: { ...marked.shape, groupBy: [] } };
  }
  if (stepId === "offer") return { ...marked, offer: undefined };
  /*
   * An optional role is one of these too. Its control only exists *because*
   * something filled it, so declining it means taking the field off the card
   * rather than recording that nobody was asked. Required roles are never
   * skippable, and one unbound here would surface plainly through `readiness`
   * rather than silently — which is the safe direction either way.
   */
  if (isRoleStep(stepId) && marked.roles[roleOfStep(stepId)] !== undefined) {
    const { [roleOfStep(stepId)]: _removed, ...rest } = marked.roles;
    return { ...marked, roles: rest };
  }
  if (stepId.startsWith("series:")) {
    const index = Number.parseInt(stepId.slice("series:".length), 10);
    if (Number.isInteger(index) && marked.series[index]) {
      return { ...marked, series: marked.series.filter((_, at) => at !== index) };
    }
  }

  return marked;
};
