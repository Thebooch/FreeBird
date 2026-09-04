import type { FinalReplyContext } from "@freebirdai/core";
import { fitRows } from "../context/judge.js";

/**
 * Every reply the user reads is written here, on purpose.
 *
 * Before this, most turns ended in text nobody generated: a canned phase
 * summary, a template wrapped around a tool error, or a floor sentence
 * ("I processed your request…") printed when nothing else applied. Each was
 * defensible on its own and together they made the assistant sound like a
 * status bar — and worse, they were *indistinguishable* from a real answer, so
 * a turn that quietly did nothing read exactly like one that worked.
 *
 * So the engine's deterministic conclusions become inputs instead of output.
 * Whatever happened this turn — an answer found in the data, an action
 * confirmed, an endpoint that refused, nothing at all — is handed to one final
 * call whose whole job is to say it like a person would.
 *
 * The one thing not written here is the case where there is no model to write
 * with. That stays a plainly-labelled state of the app rather than a sentence
 * pretending to be the assistant.
 */

/** Which situation the turn ended in. Chooses the instructions, not the words. */
export type Flow =
  | "answered"
  | "recalled"
  | "opened"
  | "across"
  | "deep"
  | "partial"
  | "nothing-found"
  | "unreadable"
  | "exhausted"
  | "built"
  | "deciding"
  | "changed"
  | "error"
  | "plain";

/**
 * The rules that hold whatever happened, stated once.
 *
 * Kept separate from the per-flow prompts so a change of tone in one situation
 * cannot quietly drop a rule about honesty in all the others.
 */
const ALWAYS = [
  "You are the assistant inside a dashboard over the user's own APIs. Write the reply they read.",
  "",
  "- Sound like a person who just looked. Short, specific, no preamble, no sign-off, and",
  "  never a status report about your own process.",
  "- Use the numbers and names in front of you. Never round a figure you were given exactly,",
  "  and never supply one you were not given at all.",
  "- Coverage is part of the truth. If only some records were read, say so in the same breath",
  "  as the number, in your own words - not as a disclaimer bolted on the end.",
  "- When something could not be read or did not answer the question, say which and what that",
  "  leaves unknown. A stated gap is worth more than a confident guess.",
  "- Never say a widget shows something unless you were told it does. Describing a widget is",
  "  not a free sentence: the user is looking at it, so inventing a second set of records in",
  "  it is caught immediately and costs you every other claim in the reply. If the draft or",
  "  the system's conclusion says an endpoint was dropped, or that fewer sources were used",
  "  than were asked for, that is the first thing you say and you say it plainly.",
  "- Cite a widget you drew on by appending [[cite:<id>]] at the end of your reply. Only ids",
  "  you were given. Never mention the marker itself.",
  "- Do not offer to do things nobody asked for, and do not end with a question unless you",
  "  genuinely need an answer to continue.",
].join("\n");

/**
 * Several phrasings per flow, cycled.
 *
 * Not decoration. The same instruction produces the same shape of sentence,
 * and a user who asks three questions in a row gets three replies with the
 * same skeleton — which reads as a template even when every word is generated.
 * Rotating the instruction moves the shape, so the variation is real rather
 * than a synonym swap.
 */
export const RESPONSE_PROMPTS: Record<Flow, readonly string[]> = {
  across: [
    "Several connected sources each hold part of this. Report them separately and name each one — a single combined total cannot be acted on, and one of them being the interesting one is exactly what they are trying to find out. Say how many sources were looked at, and if any could not be read, which.",
    "This was found in more than one place. Give the answer per source, named, so they can see where the weight is. Do not merge them into one figure, and be clear about which sources were covered and which were not.",
    "The answer is spread across sources. Take them one at a time, naming the source and what it holds, then say plainly how many places were checked in total.",
  ],
  recalled: [
    "This was answered from records already in hand — nothing was read. Answer plainly and do not mention where the records came from unless they ask; from their side it is the same conversation.",
    "The records were already held from the earlier question, so nothing was fetched. Give the answer directly.",
  ],
  opened: [
    "Something attached to the record had to be opened to answer this, and it cost extra requests. Give the answer, and say in the same breath what you opened — they are paying for it and should never find out from a bill.",
    "You went and read a collection hanging off the record. Answer, and name what you opened and what it cost. If it was empty, that is the answer: nothing is attached.",
  ],
  answered: [
    "You found the answer in their data. Lead with it - the number or the record, first sentence, no run-up. Then one clause on where it came from.",
    "You found the answer. State it plainly and name the widget or endpoint it came from in the same sentence, so they can go and look.",
    "You found the answer. Give it, then say what it is drawn from and over what span, in at most two sentences.",
  ],
  deep: [
    "Every record was read in chunks and the findings joined. Lead with the answer, then give the one pattern most worth knowing that they did not ask about - a concentration, a gap, a run of dates. Say how many records that is drawn from.",
    "This came from reading all of it, not a sample. Answer first, then surface what the reading turned up that they were not looking for. Do not list every observation; pick the one that would change what they do next.",
    "You read the whole set. Give the answer, name how many records it covers, and add the most useful thing nobody asked about. If the chunks disagreed or some were not read, that belongs in the same breath as the number.",
  ],
  partial: [
    "You found part of the answer. Say what you can see, then say plainly what would still change it - do not present a partial reading as a settled one.",
    "What you read is relevant but not the whole picture. Give what it does show, and be specific about the boundary: how much was read, and what lies past it.",
    "You have some of it. Lead with what is certain, then the limit, then what reading further would settle.",
  ],
  "nothing-found": [
    "Nothing you read answers the question. Say which sources you looked in and what they hold instead, so they can tell whether the data exists at all. If `couldCheck` is present you also went past the rows into what hangs off them — name those in its words too, so they can see the search was already taken further and need not ask you to.",
    "You could not find it. Name what you checked and why it did not fit - a specific dead end is more useful than an apology. Where `couldCheck` lists what else was opened or considered, say it: never leave them to guess at some further thing they should have asked for.",
    "The answer is not in what you read. Be direct about that, name where you looked - including anything in `couldCheck` that was reached from the records themselves - and suggest the nearest thing you did see. Use the names given there; the user does not know this product's endpoints and should never have to.",
  ],
  unreadable: [
    "The places that could have held this could not be read — a key is missing or the API refused. Say which ones and, in their own words, why. Never say the data does not exist: nobody was able to look, and that is a different sentence with a different fix.",
    "You could not get at the sources for this. Name them and give the reason each gave. Be explicit that this is not a statement about whether their data has what they asked for.",
  ],
  exhausted: [
    "You ran out of the budget for this question before checking everything. Say what you looked at, what you found, and that there is more that could be read.",
    "You stopped before exhausting the sources. Give what you have, then say plainly that the search was cut short rather than that nothing exists.",
  ],
  /*
   * Every one of these asks for a confident sentence about what the widget
   * shows, and that is right for the widget that got built. It is dangerous
   * for the one that half got built.
   *
   * Asked for properties *and* listings, the endpoints were joined, the join
   * had nothing to match on, the listings were dropped, and a note said so.
   * The reply said the widget showed "your properties alongside their
   * available listings, linking listing details to each property where the
   * records match." The user was looking at a table of properties.
   *
   * The shortfall cannot reach here as a field — an action's result is not
   * part of the final-reply context, only its name is — so the instruction is
   * to carry forward what the mid-turn draft already knows. The draft is
   * written by a model that did see the note, and it is passed in.
   */
  built: [
    "A live preview of the widget is ALREADY on screen in front of them, above your reply. Describe what it shows in one sentence, in the past or present tense. Never say you are building it, will build it, or will let them know when it is done - by the time they read this they are looking at it. If the draft says part of what they asked for was left out, lead with that instead and describe what was built second.",
    "The preview is already visible; it was built before you were asked to write this. Say what it is measuring and over what, in one sentence, and mention the one thing they are most likely to want to adjust. Do not announce, do not promise, do not use the future tense about the widget. Say only what it actually contains - if the draft reports a dropped endpoint or a source that could not be included, that is the sentence, not the description.",
    "They can see the widget already. Say what it turned out to show - a number from it if there is one - in one sentence. Nothing about building, nothing about waiting. If it turned out to show less than they asked for, say which part is missing before anything else; do not describe records that are not in it.",
  ],
  deciding: [
    "Something needs their decision before it can go ahead. Ask for exactly that, in their words, and nothing else.",
    "You need one thing from them. Ask for it directly - no summary of what you already know, no list of options they did not ask for.",
  ],
  changed: [
    "Something was changed or is waiting on their confirmation. Say what will happen or what did, concretely, in one sentence.",
    "State the change in the terms they used, not in the system's. If it is waiting on a confirmation card, say so once.",
  ],
  error: [
    "Something failed. Say what was being attempted and what went wrong in plain terms, then what they can do about it. Do not apologise more than once and do not paste raw error text at them.",
    "This did not work. Name the thing that failed and, if the cause is known, the cause - a rate limit and a wrong credential need different actions from them.",
  ],
  plain: [
    "Answer the question directly from what you know about their workspace. Short and concrete.",
    "Reply conversationally. Use what you were told about their tabs, widgets and connections, and do not pad.",
  ],
};

/** What the turn produced, in the terms the flow choice is made from. */
export interface TurnFacts {
  readonly harness?: {
    readonly outcome:
      | "found"
      | "partial"
      | "not-found"
      | "exhausted"
      | "no-sources"
      | "unreadable";
    /** Every record was read in chunks rather than a sample being taken. */
    readonly deep?: boolean;
    /** Answered from records already held, with nothing read. */
    readonly recalled?: boolean;
    /** A collection hanging off the record was opened, at a cost. */
    readonly opened?: boolean;
    /** More than one connected source held part of the answer. */
    readonly across?: number;
    /**
     * Something that might have held the answer could not be read at all.
     *
     * Kept apart from every verdict about the data, because it is not one. A
     * refused source says nothing about whether the records exist.
     */
    readonly couldNotRead?: boolean;
    /**
     * The search went past the rows it matched, into what hangs off them.
     *
     * True whether or not any of it answered — on a dead end it is what lets
     * the reply say where it went, which is the difference between ending the
     * question and inviting the user to ask for what was already tried.
     */
    readonly checkedFurther?: boolean;
  };
  readonly builtWidget?: boolean;
}

/**
 * Which situation this is.
 *
 * Read off what actually happened rather than guessed from the user's words:
 * an error is an error whatever they asked, and a turn that read data is
 * describable by its outcome and nothing else.
 */
export const flowOf = (ctx: FinalReplyContext, facts: TurnFacts = {}): Flow => {
  if (ctx.error) return "error";
  const failed = ctx.executedExtraTools.some(
    (tool) =>
      tool.result !== null &&
      typeof tool.result === "object" &&
      "error" in (tool.result as Record<string, unknown>),
  );
  if (failed) return "error";
  if (facts.harness) {
    /*
     * A deep read is its own flow whatever the verdict. It cost several times
     * an ordinary answer and it turned up things nobody asked for; a reply
     * that reports only the number wastes what was paid for.
     */
    if (facts.harness.deep) return "deep";
    /*
     * Both of these outrank the verdict. One cost nothing and should not be
     * dressed up as a search; the other cost real requests and the reply is
     * the only place that can say so.
     */
    if (facts.harness.opened) return "opened";
    if (facts.harness.recalled) return "recalled";
    /*
     * Several platforms each hold part of it. Answering with one combined
     * number here is not a summary, it is a loss: "seven mentions" cannot be
     * acted on, and "three in X, four in Y" can.
     */
    if ((facts.harness.across ?? 0) > 1) return "across";
    /*
     * Before every verdict about the data. "Nothing was found" and "nothing
     * could be looked at" send somebody to completely different places, and
     * the second one has an action attached to it.
     */
    if (facts.harness.outcome === "unreadable") return "unreadable";
    if (facts.harness.outcome === "found") return "answered";
    if (facts.harness.outcome === "partial") return "partial";
    if (facts.harness.outcome === "exhausted") return "exhausted";
    return "nothing-found";
  }
  if (facts.builtWidget) return "built";
  if (ctx.actionState.phase === "collecting" || ctx.clarificationQuestion) return "deciding";
  if (ctx.actionState.phase !== "idle") return "changed";
  return "plain";
};

/**
 * Rotate through a flow's prompts.
 *
 * Deliberately a counter rather than a random pick: random repeats, and two
 * identically-shaped replies in a row are exactly what this exists to avoid.
 * Keyed per session so two people are not locked in step.
 */
export const createPromptRotation = (): ((flow: Flow, sessionId: string) => string) => {
  const counters = new Map<string, number>();
  return (flow, sessionId) => {
    const options = RESPONSE_PROMPTS[flow];
    const key = `${sessionId}:${flow}`;
    const next = counters.get(key) ?? 0;
    counters.set(key, next + 1);
    return options[next % options.length]!;
  };
};

/** Read what the harness reported off this turn's tool results. */
/**
 * The setup actions, which put a live preview on screen.
 *
 * They carry no confirmation step, so they run, finish, and leave the action
 * phase idle — indistinguishable from a turn where nothing happened, unless
 * what ran is reported. Getting this wrong is not cosmetic: the reply then
 * announces that it is building something the user is already looking at.
 */
const SETUP_ACTIONS = new Set(["start_setup", "revise_setup", "answer_step"]);

export const factsFrom = (ctx: FinalReplyContext): TurnFacts => {
  const facts: { -readonly [K in keyof TurnFacts]: TurnFacts[K] } = {};
  if (ctx.actionsRun.some((action) => SETUP_ACTIONS.has(action.actionId))) {
    facts.builtWidget = true;
  }
  for (const tool of ctx.executedExtraTools) {
    const result = tool.result;
    const shaped = result as { outcome?: unknown; deep?: unknown } | null;
    if (
      tool.name === "answer_from_data" &&
      shaped &&
      typeof shaped === "object" &&
      typeof shaped.outcome === "string"
    ) {
      const extra = shaped as {
        usedContext?: unknown;
        openedRelated?: unknown;
        unreadable?: ReadonlyArray<unknown>;
        couldCheck?: ReadonlyArray<unknown>;
        findings?: ReadonlyArray<{ from?: string; matched?: number }>;
      };
      /*
       * Counted by connection, not by source. Two widgets over the same API
       * are one platform holding the answer twice, and reporting that as two
       * places would invent a spread the user does not have.
       */
      const across = new Set(
        (extra.findings ?? [])
          .filter((finding) => (finding.matched ?? 0) > 0 && finding.from)
          .map((finding) => finding.from as string),
      ).size;
      facts.harness = {
        outcome: shaped.outcome as NonNullable<TurnFacts["harness"]>["outcome"],
        ...(shaped.deep ? { deep: true } : {}),
        ...(extra.openedRelated ? { opened: true } : {}),
        ...(extra.usedContext && !extra.openedRelated ? { recalled: true } : {}),
        ...(across > 1 ? { across } : {}),
        ...((extra.unreadable?.length ?? 0) > 0 ? { couldNotRead: true } : {}),
        ...((extra.couldCheck?.length ?? 0) > 0 ? { checkedFurther: true } : {}),
      };
    }
  }
  return facts;
};

/**
 * What the turn's tools returned, rendered so none of it is a fragment.
 *
 * This was `JSON.stringify(result).slice(0, 9_000)`, and the bug it caused is
 * the reason the whole file cares: a data read returns fifty rows, serializes
 * to well past nine thousand characters, and the cut lands mid-object. The
 * model then had the judge's summary (early in the JSON, so intact) and a
 * broken tail — enough to name the right record and not enough to read its
 * fields, so it filled them in. It reported a task's due date as August 12th
 * and its creation as July 22nd; the record says the 17th and the 7th. Nothing
 * flagged it, because from the model's side the payload simply ended.
 *
 * So rows go through `fitRows`, which gives up width before breadth and says
 * what it gave up, and everything else is either whole or explicitly marked as
 * cut. A model told it is missing something asks; a model handed a fragment
 * guesses.
 */
const FINDING_ROW_CHARS = 20_000;
const OTHER_TOOL_CHARS = 4_000;

interface RowFinding {
  readonly source?: unknown;
  readonly tab?: unknown;
  readonly coverage?: unknown;
  readonly columns?: unknown;
  readonly shows?: unknown;
  /** The record's identity, protected from narrowing like the judge's is. */
  readonly idField?: unknown;
  readonly caveats?: unknown;
  readonly rows?: unknown;
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const renderFinding = (finding: RowFinding): string => {
  const rows = Array.isArray(finding.rows)
    ? (finding.rows as Record<string, unknown>[])
    : [];
  const idField = typeof finding.idField === "string" ? [finding.idField] : [];
  const fitted = fitRows(rows, FINDING_ROW_CHARS, idField);
  const lines = [
    `  source: ${String(finding.source ?? "unknown")}` +
      (finding.tab ? ` [tab: ${String(finding.tab)}]` : ""),
    `  coverage: ${String(finding.coverage ?? "unknown")}`,
    `  columns: ${asStrings(finding.columns).join(", ") || "(none)"}`,
  ];
  for (const caveat of asStrings(finding.caveats)) lines.push(`  caveat: ${caveat}`);
  if (fitted.droppedFields.length > 0) {
    lines.push(
      "  these rows were too large to hand over whole, so the biggest fields were left " +
        `out: ${fitted.droppedFields.slice(0, 20).join(", ")}`,
    );
  }
  /*
   * What the tile actually draws, stated separately from what was handed over.
   *
   * The two are no longer the same: the model is given the fullest record that
   * fits, so it can answer from a field nobody can see on screen. That is the
   * right trade — being unable to answer is worse than quoting an unseen
   * field — but the reply should not imply the user is looking at something
   * they are not.
   */
  const onScreen = asStrings(finding.shows);
  if (onScreen.length > 0) {
    lines.push(
      `  of these, the tile displays only: ${onScreen.join(", ")} — if you use anything ` +
        "else, say where it came from rather than implying it is on screen",
    );
  }
  if (fitted.droppedRows > 0) {
    lines.push(
      `  ${fitted.shown.length} of ${rows.length} rows are below; ${fitted.droppedRows} did ` +
        `not fit and you have NOT seen them — do not state anything about all of them`,
    );
  } else {
    lines.push(`  all ${fitted.shown.length} rows that were read are below`);
  }
  lines.push(`  rows: ${fitted.json}`);
  return lines.join("\n");
};

const renderToolResult = (tool: { name: string; result: unknown }): string => {
  const result = tool.result as { findings?: unknown } | null;
  const findings = Array.isArray(result?.findings) ? (result.findings as RowFinding[]) : null;
  if (!findings) {
    const whole = JSON.stringify(tool.result);
    return whole.length <= OTHER_TOOL_CHARS
      ? `- ${tool.name}: ${whole}`
      : `- ${tool.name}: ${whole.slice(0, OTHER_TOOL_CHARS)}\n` +
          `  (cut here — this result was longer than could be shown, so do not treat ` +
          `the end of it as the end of what was found)`;
  }
  const head = { ...(result as Record<string, unknown>) };
  delete head["findings"];
  return [
    `- ${tool.name}: ${JSON.stringify(head)}`,
    ...findings.map((finding) => renderFinding(finding)),
  ].join("\n");
};

export interface RenderFinalReplyOptions {
  readonly sessionId: string;
  readonly rotate: (flow: Flow, sessionId: string) => string;
}

export const renderDashReply = (
  ctx: FinalReplyContext,
  options: RenderFinalReplyOptions,
): string => {
  const facts = factsFrom(ctx);
  const flow = flowOf(ctx, facts);
  const parts: string[] = [ALWAYS, "", options.rotate(flow, options.sessionId), ""];

  parts.push(`They asked: ${JSON.stringify(ctx.userText)}`);

  /*
   * The draft is offered as material, never as something to preserve. It was
   * written before the tool results came back on most turns, so treating it as
   * a first draft to polish would carry its guesses into the reply.
   */
  if (ctx.draft) {
    parts.push(
      "",
      "A draft was written mid-turn and never shown to anyone. Use anything in it that is " +
        "still true and discard the rest:",
      ctx.draft,
    );
  }

  if (ctx.executedExtraTools.length > 0) {
    parts.push("", "What was found:");
    for (const tool of ctx.executedExtraTools) parts.push(renderToolResult(tool));
  }

  if (ctx.actionState.pending) {
    const pending = ctx.actionState.pending;
    parts.push(
      "",
      `An action is ${ctx.actionState.phase}: ${pending.componentId}:${pending.actionId}.`,
    );
    if (pending.missing.length > 0) {
      parts.push(`Still needed from them: ${pending.missing.join(", ")}.`);
    }
    if (pending.blockedMessage) parts.push(`It is blocked: ${pending.blockedMessage}`);
  }

  if (ctx.actionsRun.length > 0) {
    parts.push(
      "",
      `Actions that ran this turn: ${ctx.actionsRun
        .map((action) => action.actionId)
        .join(", ")}.`,
    );
  }

  if (ctx.clarificationQuestion) {
    parts.push("", `Something needs clarifying: ${ctx.clarificationQuestion}`);
  }

  if (ctx.error) parts.push("", `The turn failed with: ${ctx.error}`);

  /*
   * The engine's own conclusion, passed in rather than printed. It is often
   * accurate and always flat; this is the material it was drawn from, so the
   * reply can be both.
   */
  if (ctx.deterministic) {
    parts.push("", `The system concluded: ${ctx.deterministic}`);
  }

  parts.push("", "Write the reply now. Plain text. Do not call any tools.");
  return parts.join("\n");
};
