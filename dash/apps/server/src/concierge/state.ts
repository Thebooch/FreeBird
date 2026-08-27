import type { ConciergeContext, ConciergeDraft, Step, StepEntry } from "@freebirdai/dash-agent";
import { allSteps, buildFromDraft, nextStep, readiness, remainingSteps } from "@freebirdai/dash-agent";
import type { DashboardSpec, WidgetSpec } from "@freebirdai/dash-spec";

/**
 * What a setup looks like right now, as one shape.
 *
 * Shared by the REST wizard and the chat actions so the card gets the same
 * payload whichever drove it — the two are two hands on one draft, and a
 * response that differed by which hand moved would be a second definition of
 * what a setup *is*.
 */

/** A step as JSON, flattened so the card renders it without knowing the types. */
export const renderStep = (step: Step) => ({
  stepId: step.id,
  question: step.question,
  help: step.help ?? null,
  multiple: step.multiple,
  skippable: step.skippable,
  freeText: step.freeText === true,
  options: step.options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description ?? null,
    recommended: option.recommended === true,
  })),
});

/** A decision on the approval card: what it is, and what it is set to. */
const renderControl = (entry: StepEntry) => ({
  ...renderStep(entry.step),
  value: entry.value,
  settled: entry.settled,
  required: entry.required,
});

export interface StateInput {
  readonly draft: ConciergeDraft | null;
  readonly context: ConciergeContext;
  readonly board: DashboardSpec | null;
}

/**
 * What to do next, written into the tool result itself.
 *
 * The knowledge block is rebuilt once per turn, so the field list for an
 * endpoint the assistant just chose does not exist yet from its point of view
 * — it would have to end the turn and wait to be spoken to again before it
 * could bind anything. That is how a single request turned into "starting
 * that now, I'll let you know", which is not a conversation, it is a receipt.
 *
 * So every result says what the next call is and names what may go in it. The
 * options come from the same derived sets everything else does; this is only
 * the covering note.
 */
const nextAction = (
  draft: ConciergeDraft,
  context: ConciergeContext,
  ready: boolean,
  missing: ReturnType<typeof readiness>["missing"],
): string => {
  if (ready) {
    return (
      "This is buildable and the user can see a live preview of it. Say briefly what you " +
      "made, in one sentence. Do not call confirm_setup until they say they want it."
    );
  }

  const piece = missing[0];
  if (!piece) return "Nothing more is needed.";

  if (piece.stepId === "read" || piece.stepId === "connect") {
    return "Handle this with answer_step — it is not something revise_setup can set.";
  }

  const names = piece.candidates.slice(0, 40).join(", ");
  const asRole = piece.stepId.startsWith("role:")
    ? `roles: [{ role: "${piece.stepId.slice("role:".length)}", fields: [...] }]`
    : `${piece.stepId === "endpoint" ? "endpoint" : piece.stepId}: "..."`;

  return (
    `CALL revise_setup NEXT, in this same turn — do not stop to report progress. ` +
    `Set ${asRole}. Valid values: ${names}. ` +
    (draft.op
      ? "Choose the field that answers what the user asked for; do not ask them which one."
      : "Pick the endpoint whose rows are the thing they described.") +
    " The result will tell you what is still needed after that."
  );
};

export const conciergeState = (input: StateInput) => {
  const { draft, context, board } = input;
  if (!draft) return { active: false as const };

  const taken = new Set((board?.widgets ?? []).map((widget) => widget.id));
  const step = nextStep(draft, context);
  const state = readiness(draft, context);

  /*
   * Built whenever it can be, not only when every question has been answered.
   *
   * This is the whole change: a widget that has its endpoint, its view and its
   * required roles is a real widget, and showing it is what turns the rest of
   * the decisions from a queue of questions into adjustments to something on
   * screen. `buildFromDraft` already refuses a draft that cannot produce one.
   */
  const built = state.ready ? buildFromDraft(draft, context, { taken }) : null;
  const widget: WidgetSpec | null = built?.widget ?? null;

  return {
    active: true as const,
    draftId: draft.id,
    mode: draft.mode,
    intent: draft.intent ?? null,
    /*
     * When this setup began.
     *
     * The card needs it to tell a setup that has just started from one somebody
     * walked away from yesterday — two states that look identical in a durable
     * draft, and which want opposite treatment: one should carry straight on,
     * and only the other is worth interrupting somebody to ask about.
     */
    startedAt: draft.startedAt ?? null,
    /** True once nothing is left that blocks a widget. */
    ready: state.ready,
    /** What still blocks one, so the assistant knows what to ask about. */
    missing: state.missing,
    /** The next call to make, named in the result so a turn does not end early. */
    nextAction: nextAction(draft, context, state.ready, state.missing),
    /** The next question. Null in assisted mode once nothing blocks a widget. */
    step: step ? renderStep(step) : null,
    /** Every decision, for the controls on the approval card. */
    controls: allSteps(draft, context).map(renderControl),
    /** Only meaningful while questions are being walked one at a time. */
    remaining: step ? remainingSteps(draft, context) : 0,
    /** The thing itself, for the live preview. */
    widget,
    summary: built?.authored
      ? {
          widgetId: built.authored.id,
          title: widget?.title ?? "",
          component: widget?.component ?? "",
          headline: built.authored.headline,
          why: built.authored.why,
          requests: built.authored.cost.requests,
          onOpen: built.authored.cost.onOpen,
        }
      : null,
    /*
     * Shown before the confirm, never after. A join that can repeat a row
     * turns a total into a number that is wrong and looks right, and reading
     * it once in good faith is the failure.
     */
    warnings: built?.warnings ?? [],
    errors: built?.errors ?? [],
    filters: (built?.requiresFilters ?? []).map((filter) => filter.key),
  };
};

export type ConciergeStatePayload = ReturnType<typeof conciergeState>;
