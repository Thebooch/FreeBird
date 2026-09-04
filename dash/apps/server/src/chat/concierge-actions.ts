import type { ConciergeContext, ConciergeDraft, DraftPatch } from "@freebirdai/dash-agent";
import {
  EFFECT_STEPS,
  allSteps,
  applyStep,
  buildAll,
  describeField,
  fieldPool,
  newDraft,
  nextStep,
  readiness,
  revise,
  skipStep,
} from "@freebirdai/dash-agent";
import type { DashboardSpec, FilterDecl } from "@freebirdai/dash-spec";
import { COMPONENT_CONTRACTS, parseWidget } from "@freebirdai/dash-spec";
import type { ComponentDefinition } from "@freebirdai/core";
import { commitSetup } from "../concierge/commit.js";
import { conciergeState } from "../concierge/state.js";
import { settleDetail } from "../concierge/detail.js";
import type { DetailPlanRequest, DetailSetup } from "../concierge/detail.js";
import { z } from "zod";

/**
 * Building a widget by talking, as three thin actions.
 *
 * Thin is the design. The questions, the options and the widget are all
 * computed by the pure machine in `@freebirdai/dash-agent`; these actions move a draft
 * through it and hand the result back. The model's whole job is to read what
 * somebody asked for, pick among options it was given, and phrase the reply —
 * it never names a field, because a field it invented would not be in the list
 * the machine produced.
 *
 * The tool schemas stay flat — strings, booleans and arrays of strings — which
 * the repo's hard rule requires and `toJsonSchema` enforces by throwing.
 */

export interface ConciergeOps {
  readonly context: ConciergeContext;
  /**
   * The draft as this turn began.
   *
   * Separate from `getDraft` on purpose. The knowledge block is built once,
   * synchronously, while the registry is assembled — so it renders this
   * snapshot. The actions read live, because the model may answer several
   * questions inside one turn and each has to see the previous answer.
   */
  readonly draft: ConciergeDraft | null;
  readonly getDraft: () => Promise<ConciergeDraft | null>;
  readonly putDraft: (draft: ConciergeDraft) => Promise<void>;
  readonly clearDraft: () => Promise<void>;
  /** The board the finished widget is written to. */
  readonly getDashboard: () => DashboardSpec | null;
  readonly putDashboard: (spec: DashboardSpec) => void;
  readonly onChanged?: () => void;
  /**
   * Enumerate a connection for real.
   *
   * The only thing reachable from this file that spends a request against
   * someone's API, and it runs on exactly one path: an explicit yes to a card
   * that stated the price first.
   */
  readonly readConnection: (id: string) => Promise<{ ok: boolean; note?: string }>;
  /**
   * Work out the whole widget from one sentence, server-side.
   *
   * The endpoint catalogue used to live in the chat prompt so the model could
   * propose against it in a single call. That does not survive a real API: the
   * field lists alone measured 44.7 KB against a 24 KB budget, so what shipped
   * was a truncated roster and endpoints the assistant would deny existed.
   *
   * Moving the choosing here fixes the truncation and shrinks the prompt at
   * the same time, and it has to be here rather than across two chat turns
   * because FreeBird's engine stops the inner loop as soon as a step produces
   * prose. Absent — no model configured — the card falls back to asking, which
   * is what it did before any of this.
   */
  /**
   * Work out which values of which field a phrase like "maintenance" means.
   *
   * Reads real records, because the answer is in them and nowhere else: the
   * words were chosen by whoever set the account up, and no schema declares
   * them. Absent when there is no model to do the matching, in which case a
   * request for a subset builds the whole set and says so rather than
   * pretending to have filtered.
   */
  /**
   * Keep an answer the user confirmed, so it is not asked a second time.
   *
   * Optional: without it every drill-down is re-derived, which costs a call
   * and a question but is never wrong.
   */
  readonly rememberNarrowing?: (input: {
    connection: string;
    op: string;
    field: string;
    values: readonly (string | number)[];
    phrase: string;
    filterParam?: string | undefined;
  }) => Promise<void>;

  /**
   * Decide what opening one record shows: which fields, and which related
   * collections beside them.
   *
   * Absent when there is no model, in which case a record keeps the old
   * behaviour of showing everything the endpoint returns — which is worse but
   * never wrong, and needs nothing configured to work.
   */
  /*
   * The planner's own types, not a copy of their shape.
   *
   * This was restated here field by field, which held only for as long as the
   * two happened to agree — and they stopped agreeing twice: once when
   * `linkField` became optional, and again when the record grew a heading and
   * sections. A structural copy of a type is a second definition of it that
   * nothing keeps in step, so both sides now name the same one.
   */
  readonly planDetail?: (input: DetailPlanRequest) => Promise<DetailSetup>;

  readonly narrow?: (input: { op: string; phrase: string }) => Promise<{
    readonly field: string | null;
    readonly values: readonly (string | number)[];
    readonly all: readonly { value: string | number; count: number }[];
    readonly reason: string;
    readonly filterParam?: string | undefined;
    readonly notes: readonly string[];
  }>;

  readonly propose?: (intent: string) => Promise<{
    readonly patch: DraftPatch;
    readonly reason: string;
    readonly notes: readonly string[];
    readonly ambiguities: readonly {
      readonly field: string;
      readonly question: string;
      readonly options: readonly string[];
    }[];
  }>;
}

/**
 * The proposal fields, shared by `start_setup` and `revise_setup`.
 *
 * Flat by necessity — `toJsonSchema` throws on records and unions — so roles
 * arrive as a list of `{role, fields}` rather than an object. That also keeps
 * role names open, which matters because a custom component may declare roles
 * nothing here has heard of.
 */
const proposalFields = {
  narrowTo: z
    .string()
    .optional()
    .describe(
      "The subset the user asked for, in their own words — \"maintenance\", \"overdue\", " +
        "\"commercial\". Set this WHENEVER they asked for only some of the records rather than " +
        "all of them. The values that count as a match are worked out here by reading the " +
        "records: do not try to guess them, and do not leave this out because you cannot see " +
        "what values exist. Leave it out only when they want everything.",
    ),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Endpoint id, if and only if you already know it from a previous reply in this " +
        "conversation. Leave it out otherwise — it is chosen for you, and a guessed id is " +
        "rejected rather than approximated.",
    ),
  component: z
    .string()
    .optional()
    .describe("View id from the VIEWS list, e.g. table, bar, timeseries, feed."),
  roles: z
    .array(
      z.object({
        role: z.string().describe("Role name, e.g. columns, category, value, time."),
        fields: z
          .array(z.string())
          .describe("Field name(s) from that endpoint's FIELDS list, exactly as given."),
      }),
    )
    .optional()
    .describe("Which field fills which role. One entry per role."),
  interleave: z
    .boolean()
    .optional()
    .describe(
      "Set true when the user wants several kinds of record shuffled into ONE list, each row " +
        "badged with which it came from — \"everything in one feed\", \"show them together in " +
        "one list\". Leave it out to keep them as separate widgets side by side, which is the " +
        "default. Only works for list, feed, cards and timeline: a table's columns cannot be " +
        "aligned across two kinds of record and would be half empty.",
    ),
  measure: z
    .string()
    .optional()
    .describe(
      "What the widget counts. \"count:\" counts the records themselves, which is what " +
        "\"how many\" means. Anything else is an aggregation and a field: \"sum:Amount\", " +
        "\"avg:Days\". Set this whenever the user asked how many of something there are — do " +
        "not reach for the nearest number instead.",
    ),
  groupBy: z
    .string()
    .optional()
    .describe(
      "The field the records are broken up by. A date field is bucketed by the dashboard's " +
        "own time control, so \"per month\" is this field plus that control rather than a " +
        "separate setting.",
    ),
  extras: z.array(z.string()).optional().describe("Extra field names to show alongside."),
  controls: z
    .array(z.string())
    .optional()
    .describe("Control ids to turn on, e.g. searchable, sortable, endpointRange."),
  highlights: z
    .array(z.string())
    .optional()
    .describe("Highlight ids to mark rows with, from the MARKS list."),
  drilldown: z
    .string()
    .optional()
    .describe("Detail endpoint id to open when a row is clicked, from the CLICK list."),
  title: z.string().optional().describe("What to call it, in the user's own words."),
  join: z
    .string()
    .optional()
    .describe(
      "Join id from the JOINS list — a relationship already found between two endpoints.",
    ),
  joinEndpoint: z
    .string()
    .optional()
    .describe(
      "Bring in a second endpoint that is NOT in the JOINS list. Use when the user asks to " +
        "compare or combine two things and no ready-made join connects them. Needs " +
        "joinLeftField and joinRightField.",
    ),
  joinLeftField: z
    .string()
    .optional()
    .describe("Field on THIS widget's rows that identifies the match."),
  joinRightField: z
    .string()
    .optional()
    .describe("Field on the joined endpoint's rows holding the same value."),
  skip: z
    .array(z.string())
    .optional()
    .describe(
      "Step ids to turn off, e.g. drilldown or highlights. Declining is not the same as " +
        "leaving something unset — it settles the decision.",
    ),
};

/**
 * Starting and proposing in one call, deliberately.
 *
 * The chat engine runs at most one round of tool calls before it asks for
 * prose, so a design that needed `start_setup` and then `revise_setup` in the
 * same turn could never work — the first call would land, the turn would end,
 * and the user would be looking at the endpoint list again. That is exactly
 * the experience this whole pass exists to remove.
 *
 * So the opening proposal is one call, made against the field catalogue that
 * is in the knowledge whether or not a setup is running. Everything after is
 * `revise_setup`, by which point the richer per-endpoint material is there.
 */
const startSetupSchema = z.object({
  intent: z
    .string()
    .min(1)
    .max(2_000)
    .describe("What the user said they want to see, in their own words."),
  ...proposalFields,
});

const answerStepSchema = z.object({
  stepId: z
    .string()
    .min(1)
    .describe("The id of the question being answered. Must be the one you were just shown."),
  values: z
    .array(z.string().max(200))
    .max(40)
    .default([])
    .describe(
      "The chosen option values, exactly as given in that question's options. Empty when skipping.",
    ),
  skip: z
    .boolean()
    .default(false)
    .describe("True to decline a skippable question. The setup moves on and does not re-ask it."),
});

/** Any part of the widget, changed after the opening proposal. */
const reviseSetupSchema = z.object({ ...proposalFields });

const confirmSetupSchema = z.object({
  title: z
    .string()
    .max(120)
    .optional()
    .describe("Optional final name for the widget, if the user changed their mind about it."),
});

/** The shared state shape, with this action's own dependencies supplied. */
const stateOf = (draft: ConciergeDraft, ops: ConciergeOps) =>
  conciergeState({ draft, context: ops.context, board: ops.getDashboard() });

/** The flat tool arguments as a patch the pure machine understands. */
const patchFrom = (args: {
  endpoint?: string;
  component?: string;
  measure?: string;
  groupBy?: string;
  roles?: Array<{ role: string; fields: string[] }>;
  extras?: string[];
  controls?: string[];
  highlights?: string[];
  drilldown?: string;
  title?: string;
  join?: string;
  narrowTo?: string;
  joinEndpoint?: string;
  joinLeftField?: string;
  joinRightField?: string;
  interleave?: boolean;
  skip?: string[];
}) => ({
  ...(args.endpoint ? { endpoint: args.endpoint } : {}),
  ...(args.component ? { component: args.component } : {}),
  ...(args.measure ? { measure: args.measure } : {}),
  ...(args.groupBy ? { groupBy: args.groupBy } : {}),
  ...(args.join ? { join: args.join } : {}),
  ...(args.interleave !== undefined ? { interleave: args.interleave } : {}),
  ...(args.joinEndpoint && args.joinLeftField && args.joinRightField
    ? {
        joinWith: {
          endpoint: args.joinEndpoint,
          leftField: args.joinLeftField,
          rightField: args.joinRightField,
        },
      }
    : {}),
  ...(args.roles
    ? { roles: Object.fromEntries(args.roles.map((entry) => [entry.role, entry.fields])) }
    : {}),
  ...(args.controls ? { controls: args.controls } : {}),
  ...(args.drilldown ? { drilldown: args.drilldown } : {}),
  ...(args.extras ? { extras: args.extras } : {}),
  ...(args.highlights ? { highlights: args.highlights } : {}),
  ...(args.title ? { title: args.title } : {}),
  ...(args.skip ? { skip: args.skip } : {}),
});

/**
 * Run the drill-down and fold the answer into a draft.
 *
 * Shared by both entry points because both can be where a subset is first
 * asked for — "only maintenance tasks" as the opening request, or "actually,
 * only the maintenance ones" after seeing everything.
 *
 * The result is applied rather than held for approval, and that is deliberate:
 * the confirmation the user gives is looking at the *records*, which means
 * they have to be on screen. A gate before the filter would ask somebody to
 * approve a list of category names they have never seen attached to anything.
 * So it filters, shows, and asks — and what comes back is a chip they can
 * change like every other decision.
 */
const applyNarrowing = async (
  draft: ConciergeDraft,
  phrase: string,
  ops: ConciergeOps,
): Promise<{ draft: ConciergeDraft; found: Record<string, unknown> | null }> => {
  if (!ops.narrow || !draft.op) return { draft, found: null };

  const plan = await ops.narrow({ op: draft.op, phrase });
  if (!plan.field || plan.values.length === 0) {
    return {
      draft,
      found: {
        narrowed: false,
        phrase,
        ...(plan.field ? { fieldExamined: plan.field } : {}),
        /*
         * Said outright, because the alternative is a widget that looks
         * filtered and is not. The user asked for a subset; if the subset
         * could not be found they need to know the tile shows everything.
         */
        tellTheUser:
          plan.notes.length > 0
            ? `Nothing was filtered. ${plan.notes.join(" ")}`
            : `Nothing on these records marks out "${phrase}", so this shows all of them. Say which field and value you mean and it can be applied.`,
        notes: plan.notes,
      },
    };
  }

  const revised = revise(
    draft,
    {
      narrowWith: {
        field: plan.field,
        values: plan.values,
        phrase,
        ...(plan.filterParam ? { filterParam: plan.filterParam } : {}),
      },
    },
    ops.context,
  );

  return {
    draft: revised.draft,
    found: {
      narrowed: revised.draft.narrow !== undefined,
      field: plan.field,
      values: plan.values,
      reason: plan.reason,
      /* Everything it could have been, so the user can be offered the rest. */
      otherValues: plan.all
        .map((entry) => entry.value)
        .filter((value) => !plan.values.includes(value))
        .slice(0, 20),
      ...(plan.notes.length > 0 ? { notes: plan.notes } : {}),
      tellTheUser:
        `The preview now shows only records where ${plan.field} is ` +
        `${plan.values.map((value) => `"${value}"`).join(" or ")}. Say what you picked and ask ` +
        "whether that is the right set — the other values are listed above if they want one added.",
    },
  };
};

/** Rejections, trimmed to what a model can act on. */
const rejectionsFor = (rejected: ReturnType<typeof revise>["rejected"]) =>
  rejected.map((entry) => ({
    field: entry.value,
    reason: entry.reason,
    available: entry.available.slice(0, 30),
  }));

const draftId = (): string => `draft-${Date.now().toString(36)}`;

export const lookUpSchema = z.object({
  query: z
    .string()
    .describe(
      "What to look up — an endpoint name from the roster, or a plain word like \"lease\" " +
        "or \"vendor\". Matches names, URL paths and descriptions.",
    ),
});

/** How many endpoints one lookup describes in full. */
const LOOKUP_LIMIT = 6;
/** Field names per endpoint. Enough to answer, not enough to bury the answer. */
const LOOKUP_FIELDS = 30;

/** The name the model calls it by, and the key the executor dispatches on. */
export const LOOK_UP_TOOL = "look_up_endpoint";

/**
 * Describe the endpoints matching a query, from what is already on disk.
 *
 * A **processing tool**, not an action, and the distinction is the whole
 * reason this moved. An action is a confirmed side effect: the engine runs it
 * and the result never returns to the conversation — so a model calling one to
 * answer a question announces the lookup and then has nothing to say. Which is
 * exactly what happened: "I'll look up what endpoints are available for tasks
 * and work orders", and the turn ended there. A processing tool's result is
 * fed back into the same turn before the model replies, which is what a
 * question needs and what an action can never provide.
 *
 * Reads the stored map and nothing else: no request, no spend, no writes.
 */
export const lookUpEndpoint = (context: ConciergeContext, args: { query: string }): unknown => {
      const needle = args.query.trim().toLowerCase();
      const readable = context.ops.filter(
        (op) => (context.shapes[op.id]?.fields.length ?? 0) > 0,
      );

      const scored = readable
        .map((op) => {
          const haystack = `${op.title} ${op.path ?? ""} ${op.description ?? ""}`.toLowerCase();
          if (!needle) return { op, score: 0 };
          // An exact id or title match is what a follow-up question uses.
          if (op.id.toLowerCase() === needle || op.title.toLowerCase() === needle) {
            return { op, score: 3 };
          }
          if (op.title.toLowerCase().includes(needle)) return { op, score: 2 };
          return { op, score: haystack.includes(needle) ? 1 : 0 };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        /*
         * A miss is an answer, and a better one than a guess. The roster is
         * the whole list, so "nothing matches" genuinely means this dashboard
         * cannot read it — worth saying rather than searching harder.
         */
        return {
          query: args.query,
          found: 0,
          note:
            `No endpoint here matches "${args.query}". The roster you were given is the complete ` +
            "list, so this dashboard cannot read that — say so rather than offering to look further.",
        };
      }

      return {
        query: args.query,
        found: scored.length,
        ...(scored.length > LOOKUP_LIMIT
          ? { note: `Showing ${LOOKUP_LIMIT} of ${scored.length}. Ask again more specifically.` }
          : {}),
        endpoints: scored.slice(0, LOOKUP_LIMIT).map(({ op }) => {
          const shape = context.shapes[op.id];
          const fields = (shape?.fields ?? [])
            .filter((field) => !field.name.includes("."))
            .map((field) => field.name);
          const filters = context.rangeFilterable
            .filter((entry) => entry.op === op.id)
            .flatMap((entry) => [entry.start, entry.end ?? null]);
          const searchable = context.searchable.find((entry) => entry.op === op.id);

          return {
            id: op.id,
            name: op.title,
            /* The path is what separates two endpoints sharing a title. */
            url: op.path ?? null,
            connection: op.connection,
            ...(op.description ? { about: op.description } : {}),
            fields: fields.slice(0, LOOKUP_FIELDS),
            ...(fields.length > LOOKUP_FIELDS
              ? { moreFields: fields.length - LOOKUP_FIELDS }
              : {}),
            ...(filters.length > 0 ? { dateFilters: filters } : {}),
            ...(searchable ? { searchParam: searchable.param } : {}),
          };
        }),
      };
};

export const conciergeActions = (ops: ConciergeOps): ComponentDefinition["actions"] => [
  {
    /*
     * `"none"`, and that is a deliberate change from how this began.
     *
     * It was `preview`, on the reasoning that a multi-turn setup takes over
     * the conversation and should not start by surprise. That reasoning came
     * before the card showed a live preview of the widget. Now the card *is*
     * the confirmation — the user is looking at the thing, and Discard is one
     * click — while requiring a click before the assistant may even begin
     * makes describing a widget a two-step negotiation and gives the model a
     * reason to reach for something else instead.
     *
     * Nothing is written, nothing is spent, and no request is made. The step
     * that reaches disk is `confirm_setup`, and that is still `preview`.
     */
    id: "start_setup",
    description:
      "Build a widget from what the user described. Pass their own words as `intent` — that " +
      "is the whole call. The endpoint, the view and the field for each role are worked out " +
      "here, against every endpoint the connection has, so you do not need to name any of " +
      "them and should not guess. The reply says which records were chosen and why. Discards " +
      "any setup in progress.",
    schema: startSetupSchema,
    requiresConfirmation: "none",
    readCurrent: async () => {
      const existing = await ops.getDraft();
      return existing
        ? { replacing: existing.title ?? existing.intent ?? existing.id }
        : { replacing: null };
    },
    handler: async (args: { intent: string } & Parameters<typeof patchFrom>[0]) => {
      const intent = args.intent.trim();
      // Assisted: the assistant proposes and the card carries the rest. The
      // question-at-a-time wizard is what the card starts on its own when
      // there is no model to do the proposing.
      const fresh = newDraft(draftId(), intent, "assisted");

      /*
       * The model's own proposal wins where it made one.
       *
       * It no longer has the catalogue to propose *from*, so in practice this
       * is the older path and the offline tests — but a model that names an
       * endpoint it is sure of should not have that thrown away and re-decided
       * at the cost of two more calls.
       */
      const explicit = patchFrom(args);
      const derived = !explicit.endpoint && ops.propose ? await ops.propose(intent) : null;
      const patch = derived ? { ...derived.patch, ...explicit } : explicit;

      const result = revise(fresh, patch, ops.context);

      /*
       * The subset, worked out from the records rather than guessed. Runs
       * after the widget is built because it needs the endpoint, and needs
       * real rows from it.
       */
      const narrowed = args.narrowTo?.trim()
        ? await applyNarrowing(result.draft, args.narrowTo.trim(), ops)
        : null;

      await ops.putDraft(narrowed?.draft ?? result.draft);
      return {
        ...stateOf(narrowed?.draft ?? result.draft, ops),
        rejected: rejectionsFor(result.rejected),
        ...(narrowed?.found ? { narrowing: narrowed.found } : {}),
        ...(derived?.reason ? { picked: derived.reason } : {}),
        ...(derived && derived.notes.length > 0
          ? {
              notes: derived.notes,
              /*
               * The notes were already being sent and were already true. What
               * was missing is any indication that they outrank the pleasant
               * sentence the model was about to write.
               *
               * Asked for properties *and* listings, the pick came back as a
               * join, the join found nothing to match on, and a note said so
               * in as many words — "built from the first alone". The reply
               * read: "the widget shows your properties alongside their
               * available listings, linking listing details to each property
               * where the records match." Every part of that was false, and
               * the true version was sitting in the same payload as an
               * unlabelled array the prompt never mentioned.
               *
               * `unsure` has carried an instruction like this since the day it
               * was added, for the same reason and to good effect. This is
               * that, for the notes.
               */
              notesGuidance:
                "These are shortfalls in the widget that was just built, and they outrank " +
                "describing it. If one says an endpoint was dropped, or that the widget was " +
                "built from one source rather than the two that were asked for, say THAT " +
                "first and in your own words — before, not after, whatever the widget does " +
                "show. Never describe data the notes say is not there. The user is looking " +
                "at the widget: claiming it contains something it visibly does not is worse " +
                "than saying plainly that you could not do the whole thing.",
            }
          : {}),
        /*
         * What the model said it was unsure of, handed straight back to it.
         *
         * These outrank the card's own derived questions, and the instruction
         * says so, because they are doubts about the *request* rather than
         * about the schema. The case that forced this: asked for two counts
         * over time, the binding call reported that the endpoint it had held
         * no application data at all — and the user was then asked whether to
         * plot rent or deposit.
         */
        ...(derived && derived.ambiguities.length > 0
          ? {
              unsure: derived.ambiguities.map((item) => ({
                about: item.field,
                question: item.question,
                options: item.options,
              })),
              unsureGuidance:
                "You raised these while building it, and they matter more than any question " +
                "the card derives — they are about what was asked for, not about which column " +
                "to use. Put the important one to the user in your own words before saying the " +
                "widget is ready. If one of them says the data needed is not in this endpoint, " +
                "say that plainly instead of presenting the widget as an answer.",
            }
          : {}),
      };
    },
  },
  {
    /*
     * The only `"none"` here, and it is defensible for the same reason the
     * view actions are: recording an answer changes a draft held for this
     * session and nothing else. No spec changes, no request is made, and the
     * previous answer is one more answer away from being replaced.
     *
     * A confirmation card per question would also make the flow unusable —
     * eight questions would become sixteen clicks, and the card is already the
     * thing being answered.
     */
    id: "answer_step",
    description:
      "Record the user's answer to the current setup question and get the next one. " +
      "Values must come from that question's own options.",
    schema: answerStepSchema,
    requiresConfirmation: "none",
    authorize: async (args: { stepId: string }) => {
      const draft = await ops.getDraft();
      if (!draft) {
        return {
          ok: false as const,
          reason: "no widget setup is in progress — start one first.",
          status: 409,
        };
      }
      const current = nextStep(draft, ops.context);
      /*
       * A stale card cannot answer a question that has moved on.
       *
       * The chat column can be reloaded with an old card still rendered, and
       * its answer would otherwise be applied to whatever question happens to
       * be current — silently binding a field to the wrong role.
       */
      return (
        current?.id === args.stepId || {
          ok: false as const,
          reason: current
            ? `that answer was for "${args.stepId}", but the current question is "${current.id}".`
            : "the setup has no questions left; confirm it instead.",
          status: 409,
        }
      );
    },
    handler: async (args: { stepId: string; values: string[]; skip: boolean }) => {
      const draft = await ops.getDraft();
      if (!draft) throw new Error("no widget setup is in progress");

      /*
       * The answers that do something rather than record something.
       *
       * The step machine is pure and can only say what should happen next;
       * carrying it out belongs here. A credential never travels through this
       * path — both key-shaped answers hand off to the panel that owns them,
       * which is why neither this action's schema nor its result has anywhere
       * a secret could sit.
       */
      if (EFFECT_STEPS.has(args.stepId)) {
        const choice = args.values[0];
        if (choice === "open" || choice === "key") {
          return { ...stateOf(draft, ops), opened: "connections" as const };
        }
        if (choice === "read" && draft.connection) {
          const outcome = await ops.readConnection(draft.connection);
          // The draft is untouched: what changed, or failed to, is the world.
          return {
            ...stateOf(draft, ops),
            ...(outcome.ok ? {} : { readFailed: outcome.note ?? "the read did not complete" }),
          };
        }
        return stateOf(draft, ops);
      }

      const next = args.skip
        ? skipStep(draft, args.stepId)
        : applyStep(draft, args.stepId, args.values, ops.context);
      await ops.putDraft(next);
      return stateOf(next, ops);
    },
  },
  {
    /*
     * The one the assistant actually builds with.
     *
     * `"none"`, for the same reason `answer_step` is: it changes a draft held
     * for this session, spends nothing, reaches no disk, and is undone by the
     * next revision. A confirmation card per adjustment would make refining a
     * widget by conversation unusable, and the preview *is* the confirmation —
     * the user is looking at the result before anything is saved.
     */
    id: "revise_setup",
    description:
      "Set or change any part of the widget being built, all at once. Call it repeatedly " +
      "within one turn until the result says the widget is buildable — each result names " +
      "what is still missing and which values are valid for it. Also how you apply every " +
      "change the user asks for afterwards. Every name must come from those lists.",
    schema: reviseSetupSchema,
    requiresConfirmation: "none",
    authorize: async () =>
      (await ops.getDraft()) !== null || {
        ok: false as const,
        reason: "no widget is being built — call start_setup first.",
        status: 409,
      },
    handler: async (args: Parameters<typeof patchFrom>[0]) => {
      const draft = await ops.getDraft();
      if (!draft) throw new Error("no widget is being built");

      const result = revise(draft, patchFrom(args), ops.context);

      // "Actually, only the maintenance ones" — the same investigation, asked
      // after seeing everything rather than before.
      const narrowed = args.narrowTo?.trim()
        ? await applyNarrowing(result.draft, args.narrowTo.trim(), ops)
        : null;

      await ops.putDraft(narrowed?.draft ?? result.draft);

      /*
       * Rejections come back rather than being swallowed.
       *
       * A name that was not on offer is the model's mistake to correct, and it
       * can only correct one it is told about — silently dropping it produces
       * a widget missing the thing the user just asked for, with nothing
       * anywhere saying why.
       */
      return {
        ...stateOf(narrowed?.draft ?? result.draft, ops),
        rejected: rejectionsFor(result.rejected),
        ...(narrowed?.found ? { narrowing: narrowed.found } : {}),
      };
    },
  },
  {
    /*
     * The step that writes. `preview` and a re-parse, exactly as `add_widget`
     * does — the draft was validated when the summary was rendered, but this
     * is the call that reaches disk, and a spec that cannot execute must never
     * get there.
     */
    id: "confirm_setup",
    description:
      "Add the widget the setup produced to the dashboard. Only valid once every question " +
      "has been answered.",
    schema: confirmSetupSchema,
    requiresConfirmation: "preview",
    authorize: async () => {
      const draft = await ops.getDraft();
      if (!draft) {
        return {
          ok: false as const,
          reason: "no widget setup is in progress.",
          status: 409,
        };
      }
      /*
       * Two bars, because the modes mean different things by "finished". The
       * wizard is finished when every question has been put; the assisted flow
       * is finished when a widget can exist, since the rest of the decisions
       * are controls the user is already looking at.
       */
      if (draft.mode === "assisted") {
        const state = readiness(draft, ops.context);
        return (
          state.ready || {
            ok: false as const,
            reason: `it still needs: ${state.missing.map((piece) => piece.need).join("; ")}`,
            status: 409,
          }
        );
      }
      const pending = nextStep(draft, ops.context);
      return (
        pending === null || {
          ok: false as const,
          reason: `the setup is not finished — "${pending.question}" has not been answered.`,
          status: 409,
        }
      );
    },
    readCurrent: () => ({
      widgetCount: ops.getDashboard()?.widgets.length ?? 0,
    }),
    handler: async (args: { title?: string }) => {
      const draft = await ops.getDraft();
      const board = ops.getDashboard();
      if (!draft) throw new Error("no widget setup is in progress");
      if (!board) throw new Error("no dashboard is open");

      let named: ConciergeDraft = args.title?.trim()
        ? { ...draft, title: args.title.trim() }
        : draft;

      /*
       * What opening one record shows, decided here and nowhere earlier.
       *
       * Only some widgets have records behind their marks, and the component's
       * own contract says which — a chart of monthly counts never reaches this
       * at all. Running it on confirm rather than during the proposal means a
       * table somebody discarded never paid for a detail view they were never
       * going to open.
       */
      const settled = await settleDetail(named, ops.planDetail);
      named = settled.draft;
      const detail = settled.detail;

      const built = buildAll(named, ops.context, {
        taken: new Set(board.widgets.map((widget) => widget.id)),
      });
      const commit = commitSetup({ board, built });
      if (!commit.ok || !commit.next) {
        throw new Error(`that setup did not validate: ${commit.error ?? "unknown"}`);
      }
      const parsed = { value: commit.widgets[0]! };

      ops.putDashboard(commit.next);
      /*
       * Confirming the widget is what confirms the narrowing.
       *
       * Saved here rather than the moment it was proposed, because until this
       * point the user has only been *shown* the filtered records — pressing
       * add is them saying the set is right. Saving earlier would remember a
       * guess they went on to reject.
       */
      if (draft.narrow?.phrase && draft.op && draft.connection) {
        await ops.rememberNarrowing?.({
          connection: draft.connection,
          op: draft.op,
          field: draft.narrow.field,
          values: draft.narrow.values,
          phrase: draft.narrow.phrase,
          ...(draft.narrow.filterParam ? { filterParam: draft.narrow.filterParam } : {}),
        });
      }

      await ops.clearDraft();
      ops.onChanged?.();

      return {
        added: true,
        // The primary, under its old name. Everything that only ever cared
        // about one widget goes on reading this and is right.
        widgetId: parsed.value.id,
        title: parsed.value.title,
        ...(commit.widgets.length > 1
          ? {
              widgetIds: commit.widgets.map((widget): string => widget.id),
              titles: commit.widgets.map((widget): string => widget.title),
            }
          : {}),
        ...(commit.groupId ? { groupId: commit.groupId, group: built.group?.title } : {}),
        warnings: built.warnings,
        /*
         * What the record shows and what else it could have shown.
         *
         * Both travel back so the assistant can say what it chose *and* answer
         * "what other fields are there?" without going to look again — the
         * question that follows a proposal more often than any other.
         */
        ...(detail && detail.fields.length > 0
          ? {
              recordView: {
                fields: detail.fields,
                sections: detail.sections.map((section) => section.title),
                reason: detail.reason,
                otherFields: detail.available.fields.filter(
                  (name) => !detail!.fields.includes(name),
                ),
                otherSections: detail.available.children
                  .filter((child) => !detail!.sections.some((s) => s.id === child.id))
                  .map((child) => child.title),
                tellTheUser:
                  "Say what opening a row now shows, and that the fields and related lists above " +
                  "can be changed. Do not read the whole list out — name what you chose and offer " +
                  "the rest.",
              },
            }
          : {}),
        ...(commit.filtersAdded.length > 0 ? { filtersAdded: commit.filtersAdded } : {}),
      };
    },
  },
];

/**
 * What the assistant is told, and why each part of it is there.
 *
 * This is the whole difference between a conversation and a form. The step
 * machine can derive a perfect question — "which field should be the
 * category?" over eleven field names — and putting that question to a person
 * who asked about their expiring leases is what made the old flow read like a
 * database browser.
 *
 * So the assistant is given the *material* rather than the questions: which
 * endpoints exist, what each one's rows carry, which views those fields can
 * fill. It asks in the user's own language, decides for itself which field
 * answers what they said, and proposes a whole widget. Everything it picks is
 * still checked against these lists, so nothing it invents survives.
 */
export const conciergeKnowledge = (ops: ConciergeOps): Array<{ text: string }> => {
  const draft = ops.draft;
  /*
   * What exists, on every turn, whether or not a widget is being built.
   *
   * Removing the endpoint catalogue from the prompt fixed a real problem — a
   * complete one measured 44.7 KB against a 24 KB budget — but replaced it
   * with a bare count, and a count is not knowledge. Asked which endpoints
   * covered listings and applications, the assistant answered "I can see you
   * have 59 endpoints ... but I don't have the detailed list in front of me",
   * then offered to build a widget instead. It could only talk about the API
   * from inside the act of building against it.
   *
   * Titles alone are the fix, and they are cheap: 988 bytes for all 59 of
   * Buildium's. Fields are what made the old block enormous and they are what
   * `look_up_endpoint` now fetches on demand, so this stays a roster rather
   * than growing back into a catalogue.
   */
  const facts: Array<{ text: string }> = [{ text: whatExists(ops) }];
  if (!draft) {
    facts.push({ text: idleGuidance(ops) });
    return facts;
  }

  const state = readiness(draft, ops.context);
  const step = nextStep(draft, ops.context);

  facts.push({
    text:
      `BUILDING A WIDGET (draft ${draft.id}) — the user asked for: ` +
      `"${draft.intent ?? "something they described earlier"}". ` +
      `Right now it is: ${describeDraft(draft)}.`,
  });

  /*
   * An effect step outranks everything. Reading spends the user's money and
   * connecting needs a credential, so neither is something to work around by
   * proposing harder.
   */
  if (step && (step.id === "read" || step.id === "connect")) {
    facts.push({ text: effectGuidance(step) });
    return facts;
  }

  facts.push({ text: materials(draft, ops) });

  if (!state.ready) {
    facts.push({
      text:
        "STILL NEEDED before anything can be drawn: " +
        state.missing
          .map((piece) => `${piece.stepId} (${piece.need})`)
          .join(" · ") +
        ". Work these out from what the user tells you — ask them what they want to see, " +
        "in their own words, and choose the field yourself. Ask as many questions as it " +
        "takes to have a clear picture, and no more than that: if their first sentence " +
        "already tells you, go straight to `revise_setup` and show them something.",
    });
  } else {
    facts.push({
      text:
        "It is buildable, and the user is looking at a live preview of it right now. " +
        "Say briefly what you made and invite them to change it. When they are happy, " +
        "`confirm_setup` puts it on the board — they see a confirmation card first.",
    });
  }

  facts.push({ text: HOW_TO_BUILD });
  return facts;
};

/**
 * What to build from, before anything has been started.
 *
 * This has to carry the field names, not just the endpoint titles, because the
 * opening proposal is a *single* call — the chat engine asks for prose after
 * one round of tools, so there is no second call in which to look the fields
 * up. Names only, no shape descriptions: enough to propose from, and about a
 * quarter the size of the full material the live setup gets.
 */
/** How many endpoint titles the roster names before it stops listing them. */
const ROSTER_LIMIT = 120;

/**
 * The connections and endpoints this dashboard can see, by name.
 *
 * Deliberately titles and connection status only. The question this answers is
 * "what is there?", which is asked constantly and cheaply; "what is in it?" is
 * asked rarely and answered by `look_up_endpoint`, which costs nothing until
 * somebody asks.
 */
const whatExists = (ops: ConciergeOps): string => {
  const readable = ops.context.ops.filter(
    (op) => (ops.context.shapes[op.id]?.fields.length ?? 0) > 0,
  );

  const connections = ops.context.connections.map((connection) => {
    const mine = readable.filter((op) => op.connection === connection.id);
    return `${connection.title} (${mine.length} readable endpoint(s))`;
  });

  if (readable.length === 0) {
    return (
      "CONNECTED APIS — " +
      (connections.length > 0 ? connections.join("; ") : "none") +
      ". Nothing has been read yet, so no endpoint can be described or built from. " +
      "`start_setup` will offer the read, which costs real requests and needs the user's yes."
    );
  }

  /*
   * De-duplicated because an API can title several endpoints identically —
   * two "Retrieve all units" in different modules is real. The roster answers
   * "is there anything about units?"; `look_up_endpoint` is what separates
   * them, and it reports the path, which is the thing that actually does.
   */
  const titles = [...new Set(readable.map((op) => op.title))].sort();
  const shown = titles.slice(0, ROSTER_LIMIT);
  const more = titles.length - shown.length;

  return [
    `CONNECTED APIS — ${connections.join("; ")}.`,
    "",
    `ENDPOINTS YOU CAN SEE (${titles.length}), by name:`,
    `  ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    "",
    "This is the whole list of names — if something is not here, this dashboard cannot read it,",
    "and you should say so plainly rather than offering to look. For anything more than a name —",
    "which fields it returns, what it can be filtered by, its URL — call `look_up_endpoint`.",
    "Never answer a question about an endpoint by saying you cannot see the details: look them up.",
  ].join("\n");
};

/*
 * What the assistant is told about building widgets, when nothing is running.
 *
 * This used to be the endpoint catalogue — forty endpoints and twenty-four
 * field names apiece, 15.9 KB, rebuilt into every single turn of every
 * conversation whether or not it was about a widget. It was also incomplete,
 * because a complete one measured 44.7 KB against a 24 KB budget, so the
 * assistant would flatly deny the existence of endpoints past the fortieth.
 *
 * Now the choosing happens server-side inside `start_setup`, against all of
 * them, and this block only has to explain how to hand a sentence over. What
 * remains is fixed in size: it does not grow when an API has two thousand
 * endpoints instead of two hundred.
 */
const idleGuidance = (ops: ConciergeOps): string => {
  const buildable = ops.context.ops.filter(
    (op) => (ops.context.shapes[op.id]?.fields.length ?? 0) > 0,
  );

  if (buildable.length === 0) {
    return (
      "BUILDING WIDGETS — nothing can be built yet, because no connected API has been read. " +
      "`start_setup` will say so and offer the read, which costs real requests and needs " +
      "the user's yes."
    );
  }

  return [
    `BUILDING WIDGETS — ${buildable.length} endpoint(s) across ` +
      `${ops.context.connections.length} connection(s) are ready to build from.`,
    "",
    "VIEWS: " + Object.keys(COMPONENT_CONTRACTS).join(", "),
    "",
    "When the user describes something they want to see, call `start_setup` with their own",
    "words as `intent`. That is the whole call. The endpoint, the view and the field for each",
    "role are worked out from every available endpoint — you are not choosing from a list here",
    "and you do not need one.",
    "",
    "The user then sees a live preview with a control for every decision, and you refine it",
    "with `revise_setup`. The reply tells you which records were chosen and why; read that",
    "back to them in your own words rather than repeating endpoint ids.",
    "",
    "CLICKING A ROW: a table, list or card view can open the record behind a row, showing the",
    "fields worth reading and any related lists — a task's notes, a property's units. That is",
    "worked out here when they add the widget, from the API's own relationships, and the reply",
    "tells you what it chose and what else was available. Read the choice back to them and",
    "offer the rest; do not recite the whole list. Charts have no record behind a data point,",
    "so this never applies to them.",
    "",
    "ONLY SOME OF THE RECORDS: when they ask for a subset — \"maintenance tasks\", \"overdue\",",
    "\"commercial properties\" — pass their word as `narrowTo`. The values that count are found",
    "by reading real records here, so you do not need to know them and must not guess. A widget",
    "you build without it shows everything, which is the wrong answer to a narrower question.",
    "",
    "Never tell the user something cannot be built because you cannot see the endpoint for it.",
    "You cannot see any of them. Call `start_setup` and let it look.",
    "",
    "If two kinds of record are wanted at once, say so in the intent — both endpoints are",
    "chosen there, and they are linked from the API's own mapped relationships where those",
    "exist and from the matching field names where they do not. When a join is made the widget",
    "reports how many rows actually matched; read that back rather than assuming it lined up.",
    "",
    "Never tell the user two things cannot be shown together because no relationship is",
    "predefined. If the first attempt did not join them, `revise_setup` takes `joinEndpoint`",
    "with `joinLeftField` and `joinRightField` — pick the field on each side holding the same",
    "value and say so. Only the fields are checked, so the rows may not line up; the match",
    "count on the preview is the honest answer and belongs in your reply.",
  ].join("\n");
};

/** The lists the assistant chooses from, for the endpoint currently in play. */
const materials = (draft: ConciergeDraft, ops: ConciergeOps): string => {
  const parts: string[] = [];
  const entries = allSteps(draft, ops.context);
  const optionsOf = (stepId: string): string =>
    (entries.find((entry) => entry.step.id === stepId)?.step.options ?? [])
      .map((option) => option.value)
      .join(", ");

  const endpoints = entries.find((entry) => entry.step.id === "endpoint");
  if (endpoints && !endpoints.settled) {
    parts.push(
      "ENDPOINTS you may set: " +
        endpoints.step.options
          .map((option) => `${option.value} ("${option.label}")`)
          .join(" · "),
    );
  }

  if (draft.op) {
    /*
     * The field list is the thing that makes this work at all.
     *
     * Described by *shape* — "a date", "3 distinct values" — because that is
     * all anything here knows. Which of them means "when the lease ends" is
     * the assistant's judgement to make from the name and the user's words,
     * and it is exactly the judgement the old flow pushed onto the user.
     */
    const fields = fieldPool(draft, ops.context);
    parts.push(
      `FIELDS on this endpoint (use these names exactly): ` +
        fields
          .map((field) => {
            const shape = describeField(field);
            return shape ? `${field.name} — ${shape}` : field.name;
          })
          .join(" · "),
    );
  }

  const views = optionsOf("component");
  if (views) parts.push(`VIEWS these fields can fill: ${views}`);

  const roles = entries.filter((entry) => entry.step.id.startsWith("role:"));
  if (roles.length > 0) {
    parts.push(
      "ROLES this view needs: " +
        roles
          .map(
            (entry) =>
              `${entry.step.id.slice("role:".length)}` +
              `${entry.step.multiple ? " (takes several)" : ""}` +
              ` — ${entry.step.help ?? entry.step.question}`,
          )
          .join(" · "),
    );
  }

  for (const [label, stepId] of [
    ["MARKS", "highlights"],
    ["CONTROLS", "options"],
    ["CLICK", "drilldown"],
    ["JOINS", "join"],
  ] as const) {
    const values = optionsOf(stepId);
    if (values) parts.push(`${label}: ${values}`);
  }

  return parts.join("\n");
};

const HOW_TO_BUILD = [
  "HOW TO BUILD IT — `revise_setup` sets any part of the widget, several at once.",
  "",
  "  - Propose the whole thing in one call as soon as you know enough. Do not walk the",
  "    user through it one decision at a time; they are looking at a preview, not a form.",
  "  - Never show them a list of field names and ask which one. Ask what they want to see",
  "    and pick the field yourself. Reciting the list back is the failure this replaces.",
  "  - Never invent a name to avoid asking. Anything not in the lists above is rejected and",
  "    handed back to you; a plausible wrong binding is worse than one more question.",
  "  - Every change they ask for afterwards is another `revise_setup` — 'make it a chart',",
  "    'add the rent', 'group by status'. The preview updates as you go.",
  "  - If they describe something completely different, `start_setup` again.",
  "  - To show only some of the records, `narrowTo` with the user's own word for the subset.",
  "    The matching values are read out of the data here — never invent a filter yourself, and",
  "    never say it cannot be narrowed because you cannot see the values.",
  "  - To bring in a second endpoint, `joinEndpoint` with `joinLeftField` and",
  "    `joinRightField`. JOINS below lists the links the API itself declares, but you are",
  "    not limited to them — name any endpoint and the field on each side holding the same",
  "    value. Nothing but the fields is checked, so read the preview's match count back to",
  "    the user rather than assuming the rows lined up.",
].join("\n");

/** The two answers that do something rather than record something. */
const effectGuidance = (step: { id: string; question: string; options: readonly { value: string; label: string; description?: string }[] }): string =>
  step.id === "connect"
    ? "NOTHING IS CONNECTED — there is no API to build from. Say so and offer to open the " +
      "connection panel with `answer_step` (stepId: connect, values: [\"open\"]). The key is " +
      "entered there; never ask for one here and never accept one if it is offered."
    : `THIS ENDPOINT HAS NOT BEEN READ — "${step.question}" ` +
      `Options: ${step.options.map((option) => `${option.value} (${option.label})`).join(" | ")}. ` +
      "Reading SPENDS REAL REQUESTS against the user's API: put the number in front of them " +
      "and wait for an actual yes. Pass the answer to `answer_step` with stepId `read`. If it " +
      "is about a key, that is entered in the connection panel — never here.";

/** A one-line account of what the draft holds, for the model's own context. */
const describeDraft = (draft: ConciergeDraft): string => {
  const parts: string[] = [];
  if (draft.connection) parts.push(`connection "${draft.connection}"`);
  if (draft.op) parts.push(`endpoint "${draft.op}"`);
  if (draft.join) parts.push(`joined to "${draft.join.op}" on ${draft.join.leftField}`);
  if (draft.component) parts.push(`shown as a ${draft.component}`);
  for (const [role, value] of Object.entries(draft.roles)) {
    parts.push(`${role} = ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  if (draft.extras.length > 0) parts.push(`also showing ${draft.extras.join(", ")}`);
  if (draft.drilldown) parts.push(`clicking a row opens "${draft.drilldown.op}"`);
  if (draft.title) parts.push(`called "${draft.title}"`);
  return parts.length > 0 ? parts.join("; ") : "nothing chosen yet";
};
