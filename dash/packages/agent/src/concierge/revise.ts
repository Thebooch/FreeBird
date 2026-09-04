import type { WidgetShape } from "@freebirdai/dash-spec";
import { shapeProblems } from "@freebirdai/dash-spec";
import type { ChoiceDraft, ConciergeDraft } from "./draft.js";
import { ROLE_STEP, skipStep } from "./draft.js";
import {
  allSteps,
  applyStep,
  fieldPool,
  optionalRoleFor,
  optionalRoleStep,
  settle,
  valueOf,
  withJoinedColumns,
  type ConciergeContext,
} from "./steps.js";

/**
 * Many answers at once, checked against the same options one answer would be.
 *
 * This is what lets the assistant propose a whole widget from a sentence
 * instead of walking someone through eight questions. It is emphatically *not*
 * a relaxation of the rules: every name in the patch has to appear in the
 * option list the step machine derived for that step, or it is rejected and
 * named back. A field the model invented gets the same treatment `mapProposal`
 * already gives one — refused, with what was actually available.
 *
 * Rejections are returned rather than thrown, because the caller's job is to
 * hand them to the model so it can correct itself. A patch that is half right
 * applies its right half; the alternative is a flow that fails entirely
 * because one of six picks was wrong.
 */

export interface DraftPatch {
  readonly connection?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly join?: string | undefined;
  readonly component?: string | undefined;
  /** role name → the field(s) bound to it. */
  readonly roles?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly controls?: readonly string[] | undefined;
  /**
   * What the widget counts, as the answer the machine offers: `count:` for the
   * records themselves, or `<aggregation>:<field>` for anything else.
   *
   * A step answer rather than a shape, because changing the measure rebuilds
   * the whole measurement — the value role has to move with it, and a patch
   * that set one without the other would name a column the pipeline no longer
   * produces.
   */
  readonly measure?: string | undefined;
  /** The field the rows are broken up by. Cleared by skipping the step. */
  readonly groupBy?: string | undefined;
  /**
   * Whether to take a measurement that costs requests: "include" or "skip".
   *
   * Answered through a patch rather than through the answer route, because by
   * the time somebody decides, the widget usually works without it — and the
   * answer route only accepts an answer to the question currently blocking.
   * That guard is right; this is simply not that kind of question.
   */
  readonly offer?: string | undefined;
  /**
   * Which of two readings of the request was meant, as an endpoint id.
   *
   * Answered through a patch like everything else on the card, rather than
   * through the answer route — by the time somebody reads the two options the
   * widget usually already builds, and that route only accepts an answer to
   * the question currently blocking.
   */
  readonly choice?: string | undefined;
  /**
   * Two readings of the request, to be put to the user.
   *
   * The same distinction `offerSeries` draws against `offer`: one proposes
   * something for somebody to decide, the other is the decision. Collapsing
   * them into one field would make "here are two options" and "I pick this
   * one" the same message.
   */
  readonly choiceBetween?: ChoiceDraft | undefined;
  readonly drilldown?: string | undefined;
  readonly drilldownFields?: readonly string[] | undefined;
  readonly extras?: readonly string[] | undefined;
  readonly highlights?: readonly string[] | undefined;
  readonly title?: string | undefined;
  /**
   * The model that produced this patch.
   *
   * Not a decision about the widget, so it does not go through the step
   * machine — it is recorded on the draft and carried into the built widget,
   * which is the only way to answer "which model bound this field" now that
   * the actions no longer share one.
   */
  readonly model?: string | undefined;
  /**
   * A join nobody declared in advance.
   *
   * `join` picks from the relationships the capability report *found* — a field
   * named like another resource's id. That detection is a naming convention,
   * and a naming convention cannot cover every API: two endpoints can be
   * genuinely relatable through fields that share no vocabulary, and the person
   * asking is often the only one who knows they relate.
   *
   * So this is the open form. It is checked for *executability*, never for
   * meaning: both endpoints must exist and have been read, both fields must
   * really be on them, and the target must be callable without inputs. Whether
   * the values actually line up is a question about the data, and the only
   * honest answer to it is to run the join and report how many rows matched —
   * which `joinRows` already counts and the preview now shows.
   */
  /**
   * Restrict the rows to values somebody confirmed.
   *
   * Already resolved by the time it gets here: which field, and which of its
   * real values. Working that out means reading records and asking a model,
   * neither of which belongs in a pure function — so this only records the
   * answer and checks it is applicable.
   */
  /**
   * What the widget measures, filtered how, bucketed how.
   *
   * Checked for executability and nothing else, like every other patch here:
   * every field named has to be one the rows really carry, every aggregation
   * but a count has to name a field, and the filter has to parse. Whether
   * counting by the created date answers what somebody meant is a question
   * about the *request*, and the honest way to answer it is the preview.
   */
  readonly shape?: WidgetShape | undefined;

  /**
   * Measurements drawn beside the primary one.
   *
   * The general form of `compareWith` below, which could only ever say "these
   * two endpoints, counted, over a date". Nothing about stacking two
   * measurements requires the axis to be a date, the measure to be a count, or
   * there to be exactly two — so this says the same thing without any of those
   * three assumptions, and each side brings its own shape.
   *
   * Checked for executability: the endpoint has to exist and have been read,
   * every field named has to be on *its own* rows, and nothing may fan out
   * from a source that is not there.
   */
  /**
   * A measurement worked out but not taken, because it costs requests.
   *
   * The same shape as a `seriesWith` entry and deliberately a different field:
   * one is applied, the other is offered. Nothing about a nested collection
   * makes it wrong — only expensive — and the difference between those two is
   * whose decision it is.
   */
  readonly offerSeries?:
    | {
        readonly endpoint: string;
        readonly label: string;
        readonly shape: WidgetShape;
        readonly fanOut: {
          readonly from: string;
          readonly field: string;
          readonly as?: string | undefined;
          readonly maxRows?: number | undefined;
        };
      }
    | undefined;

  readonly seriesWith?:
    | ReadonlyArray<{
        readonly endpoint: string;
        readonly label: string;
        readonly shape: WidgetShape;
        readonly fanOut?:
          | {
              readonly from: string;
              readonly field: string;
              readonly as?: string | undefined;
              readonly maxRows?: number | undefined;
            }
          | undefined;
      }>
    | undefined;

  readonly narrowWith?:
    | {
        readonly field: string;
        readonly values: readonly (string | number)[];
        readonly phrase?: string | undefined;
        readonly filterParam?: string | undefined;
      }
    | undefined;

  /**
   * A second endpoint counted alongside the first over a shared time axis.
   *
   * Not a join and not expressible as one: neither set of rows is an attribute
   * of the other, so there is nothing to match them on. Forced through the
   * join path it silently collapses to a chart of the first endpoint, which is
   * precisely what happened to "listings per month against applications per
   * month" before this existed.
   */
  readonly compareWith?:
    | {
        readonly endpoint: string;
        readonly leftTimeField: string;
        readonly rightTimeField: string;
        readonly leftLabel: string;
        readonly rightLabel: string;
      }
    | undefined;

  readonly joinWith?:
    | {
        readonly endpoint: string;
        readonly leftField: string;
        readonly rightField: string;
        readonly kind?: "inner" | "left" | undefined;
      }
    | undefined;
  /**
   * Step ids to mark declined.
   *
   * A control on the approval card needs a way to say "not this one" — turning
   * off a drill-down, dropping the extras. Declining is not the same as
   * setting nothing: it settles the step so the wizard stops asking, which is
   * why it cannot be expressed as an empty value.
   *
   * Applied last, so a patch that both sets and declines the same step lands
   * on declined. Sending both is a contradiction; last-wins is at least a rule
   * somebody can predict.
   */
  readonly skip?: readonly string[] | undefined;
}

export interface Rejection {
  readonly stepId: string;
  /** The value that was not on offer. */
  readonly value: string;
  /** What was, so the caller can say so rather than just refusing. */
  readonly available: readonly string[];
  readonly reason: string;
}

export interface ReviseResult {
  readonly draft: ConciergeDraft;
  readonly rejected: readonly Rejection[];
}

/**
 * The order things are applied in, and it matters.
 *
 * Each choice narrows what the next one may be — the endpoint decides which
 * fields exist, the view decides which roles are needed — so a patch has to be
 * applied outside-in and re-derived at every step. Applying roles before a
 * component would validate them against whatever component was there before.
 */
const ORDER = [
  "connection",
  "endpoint",
  "join",
  "component",
  "choice",
  "measure",
  "groupBy",
  "offer",
  "roles",
  "controls",
  "drilldown",
  "drilldownFields",
  "extras",
  "highlights",
  "title",
] as const;

/** The step ids a patch key maps to, and how its value becomes an answer. */
const answersFor = (
  key: (typeof ORDER)[number],
  patch: DraftPatch,
): ReadonlyArray<{ stepId: string; values: readonly string[] }> => {
  switch (key) {
    case "connection":
      return patch.connection ? [{ stepId: "connection", values: [patch.connection] }] : [];
    case "endpoint":
      return patch.endpoint ? [{ stepId: "endpoint", values: [patch.endpoint] }] : [];
    case "join":
      return patch.join ? [{ stepId: "join", values: [patch.join] }] : [];
    case "component":
      return patch.component ? [{ stepId: "component", values: [patch.component] }] : [];
    case "measure":
      return patch.measure ? [{ stepId: "measure", values: [patch.measure] }] : [];
    case "groupBy":
      return patch.groupBy ? [{ stepId: "groupBy", values: [patch.groupBy] }] : [];
    case "offer":
      return patch.offer ? [{ stepId: "offer", values: [patch.offer] }] : [];
    case "choice":
      return patch.choice ? [{ stepId: "choice", values: [patch.choice] }] : [];
    case "roles":
      return Object.entries(patch.roles ?? {}).map(([role, fields]) => ({
        stepId: `${ROLE_STEP}${role}`,
        values: fields,
      }));
    case "controls":
      return patch.controls ? [{ stepId: "options", values: patch.controls }] : [];
    case "drilldown":
      return patch.drilldown ? [{ stepId: "drilldown", values: [patch.drilldown] }] : [];
    case "drilldownFields":
      return patch.drilldownFields
        ? [{ stepId: "drilldownFields", values: patch.drilldownFields }]
        : [];
    case "extras":
      return patch.extras ? [{ stepId: "extras", values: patch.extras }] : [];
    case "highlights":
      return patch.highlights ? [{ stepId: "highlights", values: patch.highlights }] : [];
    case "title":
      return patch.title ? [{ stepId: "title", values: [patch.title] }] : [];
  }
};

export const revise = (
  input: ConciergeDraft,
  patch: DraftPatch,
  context: ConciergeContext,
): ReviseResult => {
  let draft = settle(input, context);
  const rejected: Rejection[] = [];

  // Recorded before anything can be rejected: who proposed this is true even
  // if half of what they proposed turns out not to fit.
  if (patch.model) draft = { ...draft, model: patch.model };

  /*
   * The measurement lands first, and that ordering is load-bearing.
   *
   * Once a widget counts rows, its value role names a column the *group step*
   * produces — and no such column exists on the raw rows. Applied after the
   * roles, every measured proposal was rejected for binding "count" to a value
   * role that only offers the endpoint's own numeric fields.
   *
   * Validated against the endpoint the patch is about to set, not the one the
   * draft currently has: a proposal names both at once.
   */
  if (patch.shape) {
    const outcome = applyShape(draft, patch.shape, context, patch.endpoint);
    if (outcome.rejection) rejected.push(outcome.rejection);
    else draft = outcome.draft;
  }

  for (const key of ORDER) {
    /*
     * The open join lands here, between the endpoint and everything bound
     * against it — and where it lands is the whole of the fix.
     *
     * It used to be applied after this loop had finished, which broke the same
     * widget twice. Roles were validated against a pool that did not yet hold
     * the joined columns, so a proposal naming one was refused for inventing a
     * field; and `applyOpenJoin` then cleared `roles` outright, on the correct
     * reasoning that the pool had changed under them — discarding the bindings
     * the loop had just finished making. The result was a widget that fetched
     * a second endpoint, paid for it, and rendered the first one alone.
     *
     * `join` — the map-derived form, answered as an ordinary step — is already
     * ordered before `component` for exactly this reason. This is the same
     * position for the form a proposal supplies directly.
     */
    if (key === "component" && patch.joinWith) {
      const outcome = applyOpenJoin(draft, patch.joinWith, context);
      if (outcome.rejection) rejected.push(outcome.rejection);
      else draft = outcome.draft;
    }

    for (const { stepId, values } of answersFor(key, patch)) {
      // Re-derived after every application, because the previous one may have
      // changed what this one is allowed to be.
      const entry = allSteps(draft, context).find((candidate) => candidate.step.id === stepId);

      if (!entry) {
        /*
         * A value the draft already carries is not a rejection.
         *
         * `settle()` fills in the only connection there is, which removes the
         * question — and every proposal names the connection it chose, so
         * every real widget build was feeding a "there is no connection to set
         * on this widget" back to the assistant for a connection that was
         * already set correctly. Nothing failed; the report said it had.
         */
        const held = valueOf(draft, stepId);
        if (held.length === values.length && values.every((value) => held.includes(value))) {
          continue;
        }

        /*
         * An optional role has no step until something fills it — so the first
         * thing to fill one arrives before its own control exists.
         *
         * Validated against `optionalRoleStep`, which is the same definition
         * that renders the control, so what a patch may set and what the card
         * offers cannot drift apart. Everything else about the treatment is
         * unchanged: a field outside the options is still refused, still by
         * name, still with the list of what was available.
         */
        const optional = optionalRoleFor(draft, stepId);
        if (optional) {
          const step = optionalRoleStep(
            // Bound so the emitter has something to render a control *for*;
            // this stands in for the values about to be applied.
            { ...draft, roles: { ...draft.roles, [optional.role.role]: [...values] } },
            optional.contract,
            optional.role,
            fieldPool(draft, context),
          );

          const offered = new Set((step?.options ?? []).map((option) => option.value));
          const usable = values.filter((value) => offered.has(value));
          for (const value of values) {
            if (offered.has(value)) continue;
            rejected.push({
              stepId,
              value,
              available: [...offered],
              reason: step
                ? `"${value}" is not one of the choices for this`
                : `nothing on this endpoint can be the ${optional.role.role}`,
            });
          }
          if (usable.length > 0) draft = applyStep(draft, stepId, usable, context);
          continue;
        }

        rejected.push({
          stepId,
          value: values.join(", "),
          available: [],
          reason: `there is no "${stepId}" to set on this widget`,
        });
        continue;
      }

      /*
       * A free-text step takes what it is given.
       *
       * The title is the only one, and its single option is a suggestion
       * rather than a constraint — refusing somebody's own words for their own
       * widget would be absurd.
       */
      if (entry.step.freeText) {
        draft = applyStep(draft, stepId, values, context);
        continue;
      }

      const offered = new Set(entry.step.options.map((option) => option.value));
      const usable = values.filter((value) => offered.has(value));
      for (const value of values) {
        if (offered.has(value)) continue;
        rejected.push({
          stepId,
          value,
          available: entry.step.options.map((option) => option.value),
          reason: `"${value}" is not one of the choices for this`,
        });
      }

      /*
       * Nothing usable means nothing applied.
       *
       * Applying an empty answer to a required step would mark it settled
       * against a value nobody chose — the widget would then build on a
       * default the user never saw, which is exactly the kind of quiet
       * wrongness this codebase refuses everywhere else.
       */
      if (usable.length === 0) continue;
      draft = applyStep(draft, stepId, usable, context);
    }
  }

  if (patch.narrowWith) {
    const outcome = applyNarrow(draft, patch.narrowWith, context);
    if (outcome.rejection) rejected.push(outcome.rejection);
    else draft = outcome.draft;
  }

  if (patch.choiceBetween) {
    /*
     * Held rather than applied. Every option was prepared by the caller, which
     * has the shapes; nothing here has to re-derive one, and nothing is
     * decided until somebody answers.
     */
    draft = { ...draft, choice: patch.choiceBetween };
  }

  if (patch.offerSeries) {
    /*
     * Validated exactly as an applied side would be, then held rather than
     * applied. An offer that turns out not to be executable is not worth
     * asking about.
     */
    const outcome = applySeries(draft, [patch.offerSeries], context);
    rejected.push(...outcome.rejections);
    /*
     * Only what this patch produced, never what the draft already had.
     *
     * Reading it back off `outcome.draft.series` looked equivalent and was
     * not: a refused offer leaves the draft untouched, so the first existing
     * side was picked up and offered under the wrong name.
     */
    const [held] = outcome.kept;
    if (held) draft = { ...draft, offer: held };
  }

  if (patch.seriesWith) {
    const outcome = applySeries(draft, patch.seriesWith, context);
    rejected.push(...outcome.rejections);
    draft = outcome.draft;
  }

  if (patch.compareWith) {
    const outcome = applyCompare(draft, patch.compareWith, context);
    if (outcome.rejection) rejected.push(outcome.rejection);
    else draft = outcome.draft;
  }

  for (const stepId of patch.skip ?? []) {
    draft = skipStep(draft, stepId);
  }

  /*
   * Last, because only here is it settled whether there is still a join.
   *
   * `applySeries` clears one — a comparison and a join are different widget
   * shapes — so binding the joined columns any earlier could leave a widget
   * showing `listings_Address` for a join that no longer exists.
   */
  draft = withJoinedColumns(draft, context);

  return { draft, rejected };
};

/**
 * A join proposed rather than discovered, checked for whether it can run.
 *
 * Three things have to be true, and none of them is about meaning: the other
 * endpoint has to have been read, both named fields have to exist, and the
 * other endpoint has to be reachable without an input nobody has. Anything
 * else — does `OwnerRef` really point at `OwnerId`, is this a sensible thing to
 * ask — is a question about the data that no schema can answer, and refusing on
 * a guess is how the assistant ended up saying "I can't, nobody defined that
 * relationship" about a join that would have worked fine.
 */
/**
 * Record what the widget measures, checked against the endpoint's own fields.
 *
 * Executability only, as everywhere else. `shapeProblems` does the checking
 * and lives in `@freebirdai/dash-spec` beside the emitter, so the rules about what a
 * shape may name are stated once rather than once per caller.
 *
 * A rejected shape leaves the draft alone and reports what was available,
 * rather than half-applying: a measurement that names one real field and one
 * invented one is not a partially correct answer, it is a different question.
 */
const applyShape = (
  draft: ConciergeDraft,
  shape: WidgetShape,
  context: ConciergeContext,
  endpoint?: string | undefined,
): { draft: ConciergeDraft; rejection?: Rejection } => {
  const op = endpoint ?? draft.op;
  const fields = op ? (context.shapes[op]?.fields ?? []) : [];
  const available = fields.map((field) => field.name);
  const problems = shapeProblems(shape, available);

  if (problems.length > 0) {
    return {
      draft,
      rejection: {
        stepId: "shape",
        value: problems[0] ?? "",
        available,
        reason: problems.join("; "),
      },
    };
  }

  return { draft: { ...draft, shape } };
};

/**
 * Record a narrowing, checked against the endpoint it applies to.
 *
 * Executability only, as everywhere else: the field has to be one the rows
 * really carry, and there has to be at least one value. Whether those are the
 * *right* values is a question about what somebody meant, which is why they
 * were asked before this was called and why the preview shows the result.
 */
const applyNarrow = (
  draft: ConciergeDraft,
  narrow: NonNullable<DraftPatch["narrowWith"]>,
  context: ConciergeContext,
): { draft: ConciergeDraft; rejection?: Rejection } => {
  const available = draft.op ? (context.shapes[draft.op]?.fields ?? []) : [];
  const reject = (reason: string) => ({
    draft,
    rejection: {
      stepId: "narrowWith",
      value: narrow.field,
      available: available.map((field) => field.name),
      reason,
    },
  });

  if (!draft.op) return reject("no endpoint has been chosen yet");
  if (narrow.values.length === 0) {
    // A filter matching nothing empties the widget while looking healthy.
    return reject("no values were given, so this would hide every record");
  }
  if (!available.some((field) => field.name === narrow.field)) {
    return reject(`"${narrow.field}" is not a field on these records`);
  }

  return {
    draft: {
      ...draft,
      narrow: {
        field: narrow.field,
        values: [...narrow.values],
        ...(narrow.phrase ? { phrase: narrow.phrase } : {}),
        ...(narrow.filterParam ? { filterParam: narrow.filterParam } : {}),
      },
    },
  };
};

/**
 * Measure a second endpoint beside the first rather than joining to it.
 *
 * Checked for executability and nothing else, exactly as an open join is: both
 * endpoints known and readable, both named time fields really present, not the
 * same endpoint twice. Whether the two are *worth* comparing is a question
 * about the user's intent, and they are looking at the answer.
 *
 * A comparison and a join are mutually exclusive — the widget has one shape or
 * the other — so setting either clears the other rather than leaving a draft
 * that claims both.
 */
const applyCompare = (
  draft: ConciergeDraft,
  compare: NonNullable<DraftPatch["compareWith"]>,
  context: ConciergeContext,
): { draft: ConciergeDraft; rejection?: Rejection } => {
  const reject = (reason: string) => ({
    draft,
    rejection: {
      stepId: "compareWith",
      value: compare.endpoint,
      /* Every endpoint that has been read is a candidate to compare against. */
      available: context.ops
        .filter((op) => (context.shapes[op.id]?.fields.length ?? 0) > 0)
        .map((op) => op.id),
      reason,
    },
  });

  if (!draft.op) return reject("no endpoint has been chosen to compare against yet");
  if (compare.endpoint === draft.op) return reject("an endpoint cannot be compared with itself");

  const target = context.ops.find((op) => op.id === compare.endpoint);
  if (!target) return reject(`"${compare.endpoint}" is not an endpoint here`);

  const left = context.shapes[draft.op];
  const right = context.shapes[compare.endpoint];
  if (!left || !right) return reject(`"${compare.endpoint}" has not been read yet`);

  const has = (shape: typeof left, name: string): boolean =>
    shape.fields.some((field) => field.name === name);
  if (!has(left, compare.leftTimeField)) {
    return reject(`"${compare.leftTimeField}" is not a field on the first endpoint`);
  }
  if (!has(right, compare.rightTimeField)) {
    return reject(`"${compare.rightTimeField}" is not a field on ${target.title}`);
  }

  return {
    draft: {
      ...draft,
      join: undefined,
      compare: {
        op: compare.endpoint,
        rowsPath: right.rowsPath || "$",
        leftTimeField: compare.leftTimeField,
        rightTimeField: compare.rightTimeField,
        leftLabel: compare.leftLabel,
        rightLabel: compare.rightLabel,
        measure: "count" as const,
      },
    },
  };
};

/**
 * Record the measurements drawn beside the primary one.
 *
 * Executability only. Each side is validated against *its own* rows, which is
 * the whole reason a series carries its own shape: two endpoints being
 * compared share nothing but the axis they are drawn on, and requiring them to
 * share field names would rule out most real comparisons.
 *
 * A side that does not check out is dropped and reported; the rest still
 * apply. Refusing all of them because one named a wrong field would throw away
 * work the user can see is right.
 */
const applySeries = (
  draft: ConciergeDraft,
  sides: NonNullable<DraftPatch["seriesWith"]>,
  context: ConciergeContext,
): { draft: ConciergeDraft; kept: ConciergeDraft["series"]; rejections: Rejection[] } => {
  const rejections: Rejection[] = [];
  const readable = context.ops
    .filter((op) => (context.shapes[op.id]?.fields.length ?? 0) > 0)
    .map((op) => op.id);

  const refuse = (endpoint: string, reason: string): void => {
    rejections.push({ stepId: "seriesWith", value: endpoint, available: readable, reason });
  };

  const kept: ConciergeDraft["series"] = [];
  for (const side of sides.slice(0, 3)) {
    /*
     * A side may be a nested collection, which is deliberately not in `ops`.
     *
     * `ops` is what a widget can *start* from, and an endpoint needing a
     * parent's id cannot start anything — nobody has an id yet. It can still
     * be measured, by asking once per parent, which is what a child link is.
     * Looking only in `ops` made every one of them "no endpoint called that",
     * which is the same exclusion that made the whole request unanswerable one
     * layer up.
     */
    const target =
      context.ops.find((op) => op.id === side.endpoint) ??
      context.children.find((child) => child.op === side.endpoint);
    if (!target) {
      refuse(side.endpoint, `there is no endpoint called "${side.endpoint}"`);
      continue;
    }
    /*
     * And one that needs a parent's id has to say where the id comes from.
     * Measuring it without a fan-out would send the token uninterpolated and
     * fail at request time, which is a worse answer than being told now.
     */
    if (!side.fanOut && context.children.some((child) => child.op === side.endpoint)) {
      const bare = context.ops.some((op) => op.id === side.endpoint);
      if (!bare) {
        refuse(
          side.endpoint,
          `"${target.title}" is only listed per record, so counting it needs a parent to read from`,
        );
        continue;
      }
    }
    const shape = context.shapes[side.endpoint];
    if (!shape || shape.fields.length === 0) {
      refuse(side.endpoint, `"${target.title}" has not been read yet, so nothing is known about it`);
      continue;
    }
    const problems = shapeProblems(
      side.shape,
      shape.fields.map((field) => field.name),
    );
    if (problems.length > 0) {
      refuse(side.endpoint, problems.join("; "));
      continue;
    }
    /*
     * A fan-out names the endpoint whose rows carry the id this one needs, and
     * that is very often neither of the two being compared.
     *
     * Counting applications means asking each *applicant* for theirs, and
     * applicants are not one of the things being measured — they are only how
     * the applications are reachable. So the driver is any readable endpoint,
     * and the builder fetches it as a hidden source: paid for, reported, and
     * not drawn.
     */
    if (side.fanOut) {
      const driver = context.shapes[side.fanOut.from];
      if (!driver || driver.fields.length === 0) {
        refuse(
          side.endpoint,
          `"${side.fanOut.from}" would have to be read first to reach ${target.title}, and nothing is known about it`,
        );
        continue;
      }
      if (!driver.fields.some((field) => field.name === side.fanOut!.field)) {
        refuse(
          side.endpoint,
          `"${side.fanOut.field}" is not a field on "${side.fanOut.from}", so it cannot supply the id`,
        );
        continue;
      }
    }

    kept.push({
      op: side.endpoint,
      rowsPath: shape.rowsPath || "$",
      label: side.label,
      shape: side.shape,
      ...(side.fanOut
        ? {
            fanOut: {
              from: side.fanOut.from,
              field: side.fanOut.field,
              ...(side.fanOut.as ? { as: side.fanOut.as } : {}),
              maxRows: side.fanOut.maxRows ?? 25,
            },
          }
        : {}),
    });
  }

  // A comparison and a join are different widget shapes, so setting one clears
  // the other rather than leaving a draft that claims both.
  return kept.length > 0
    ? { draft: { ...draft, join: undefined, series: kept }, kept, rejections }
    : { draft, kept, rejections };
};

const applyOpenJoin = (
  draft: ConciergeDraft,
  join: NonNullable<DraftPatch["joinWith"]>,
  context: ConciergeContext,
): { draft: ConciergeDraft; rejection?: Rejection } => {
  const refuse = (reason: string, available: readonly string[] = []): {
    draft: ConciergeDraft;
    rejection: Rejection;
  } => ({ draft, rejection: { stepId: "joinWith", value: join.endpoint, available, reason } });

  const target = context.ops.find((op) => op.id === join.endpoint);
  if (!target) {
    return refuse(
      `there is no endpoint called "${join.endpoint}"`,
      context.ops.map((op) => op.id),
    );
  }
  if (target.id === draft.op) return refuse("an endpoint cannot be joined to itself");

  const rightFields = (context.shapes[join.endpoint]?.fields ?? []).filter(
    (field) => !field.name.includes("."),
  );
  if (rightFields.length === 0) {
    return refuse(
      `"${join.endpoint}" has not been read, so nothing is known about its fields`,
    );
  }

  const left = fieldPool(draft, context);
  if (!left.some((field) => field.name === join.leftField)) {
    return refuse(
      `"${join.leftField}" is not a field on this widget's rows`,
      left.map((field) => field.name),
    );
  }
  if (!rightFields.some((field) => field.name === join.rightField)) {
    return refuse(
      `"${join.rightField}" is not a field on "${join.endpoint}"`,
      rightFields.map((field) => field.name),
    );
  }

  return {
    draft: {
      ...draft,
      join: {
        op: join.endpoint,
        rowsPath: context.shapes[join.endpoint]?.rowsPath ?? "$",
        leftField: join.leftField,
        rightField: join.rightField,
        /*
         * `left` by default, deliberately.
         *
         * An inner join silently deletes the rows that did not match, which on
         * a guessed relationship could be all of them — and an empty widget
         * says nothing about why. Keeping them, with the other side's columns
         * blank, makes a bad guess visible instead.
         */
        kind: join.kind ?? "left",
        // A parameter-free collection, fetched whole and joined in memory.
        // There is no per-row route here: fanning out on a guess would spend
        // one request per row to test a hunch.
        needsFanOut: false,
        maxRows: 25,
      },
      // The pool just changed, so anything bound against the old one is stale.
      component: undefined,
      roles: {},
      answered: draft.answered.filter(
        (id) => !id.startsWith(ROLE_STEP) && id !== "component" && id !== "join",
      ),
    },
  };
};
