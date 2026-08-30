import type { ConciergeContext, LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import type { DashboardSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { WidgetHandle } from "../chat/handles.js";
import { turnSpendSoFar } from "../llm.js";
import { buildCandidates, narrowTo, unreadableConnections } from "./candidates.js";
import { type Focus, type FocusStore, mergeRecords } from "./focus.js";
import { recallFromFocus } from "./recall.js";
import { identityFor, pickOption, readRelated } from "./related.js";
import { describeOpenables, openFrom, openableFrom } from "./reach.js";
import { bindingsFor } from "../tools/bindings.js";
import { identityValue, readRecords, readReferenced } from "../tools/read.js";
import type { ToolDeps } from "../tools/types.js";
import { CHUNK_SIZE, type DeepFinding, analyseDeep } from "./deep.js";
import { type Budget, DEFAULT_BUDGET, runContextHarness } from "./harness.js";
import { PAGE_SIZE, readEndpoint, readWidget } from "./read.js";
import type { Candidate, Evidence, HarnessResult, OpReader } from "./types.js";

/**
 * The one door between the conversation and the user's actual data.
 *
 * Exposed as a processing tool rather than an action, because an action's
 * result never re-enters the conversation — the model would call it and then
 * have nothing to say. A processing tool's result is pushed back as a
 * continuation message, which is the only mechanism that can answer a
 * question.
 *
 * It is also the router, at no extra cost: the chat model deciding whether to
 * call this IS the decision about whether the turn needs data, so a
 * conversational turn spends nothing here. That is why there is no separate
 * classification call in front of it.
 */

const answerSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "What to find out, in one self-contained sentence. Include what the user means by " +
        "their own words — this is read without the rest of the conversation.",
    ),
  source: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Set ONLY when the user named where to look — a platform, a connection, a tab or a " +
        "widget. It restricts the search to that place. Leave unset when they did not say, " +
        "because reading somewhere they did not ask about spends their API quota.",
    ),
  across: z
    .boolean()
    .optional()
    .describe(
      "Set when the question is whether something appears ANYWHERE — 'has anyone', 'any of " +
        "my', 'across everything'. Every connected source that could hold it is read and " +
        "reported separately, so the answer can say which platform has what. Costs more " +
        "than a single-source answer; leave unset for an ordinary question.",
    ),
  scanRecords: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Only when the user has asked to look past the default sample: how many records to " +
        "read. Setting this reads the records in chunks and reports patterns as well as the " +
        "answer, so it costs several model calls and more requests — do not set it to be " +
        "thorough, only because they asked. Leave unset otherwise.",
    ),
});

export const ANSWER_TOOL: LlmTool = {
  name: "answer_from_data",
  description:
    "Read the user's own data to answer a question about it - counts, totals, extremes, " +
    "specific records, what a widget is currently showing, or anything attached to a " +
    "record. Call this whenever the answer depends on values rather than on what exists. " +
    "Call it for FOLLOW-UPS too: it remembers the records the last question was about, so " +
    "'what was the issue?', 'when is it due?' and 'any notes on it?' are answered from " +
    "records already in hand, often for free - and when something attached to the record " +
    "is wanted, it opens that and reports what it cost. Never answer a follow-up from " +
    "field names alone. Showing somebody the widget as well is good and wanted - just " +
    "never instead of the answer, so ask here first and point afterwards. It searches " +
    "the widgets on every tab and the connected " +
    "endpoints, reads a bounded sample, and reports how much it read. Pass `scanRecords` " +
    "only when the user has asked to look deeper. Pass `source` when they named where to " +
    "look, and `across` when they asked whether something appears anywhere at all - that " +
    "reads every source that could hold it and reports each one separately.",
  schema: answerSchema,
};

export interface AnswerDeps {
  readonly llm: LlmAdapter | null;
  readonly model?: string | undefined;
  readonly context: ConciergeContext;
  readonly handles: readonly WidgetHandle[];
  readonly dashboards: readonly DashboardSpec[];
  readonly resolved: ResolvedParams;
  readonly timeZone: string;
  readonly now: () => number;
  readonly read: OpReader;
  readonly isCached: (key: string) => boolean;
  readonly rowsOf: (body: unknown, rowsPath: string) => Record<string, unknown>[];
  readonly rowsPathFor: (op: string) => string;
  readonly budget?: Budget;
  /** Records per chunk on a deep read. Defaults to the shipped size. */
  readonly chunkSize?: number;
  /** Which conversation this is, so its focus can be found and replaced. */
  readonly sessionId: string;
  /** Where the conversation's current records live. Absent disables recall. */
  readonly focus?: FocusStore;
  /**
   * The record they have open, when they have one.
   *
   * Takes precedence over what a previous question put in hand, because what
   * somebody is looking at is the strongest available statement of what "this"
   * means. Deliberately not persisted: it is true while they are on that page
   * and the stored focus should still be there when they navigate away.
   */
  readonly onScreen?: Focus | null;
}

/** What the model is handed back, and what the bubble renders from. */
export interface AnswerResult {
  readonly outcome: HarnessResult["outcome"];
  readonly looked: readonly string[];
  readonly missing: string;
  /** What the rows were read as saying. Empty when nothing was found. */
  readonly answer: string;
  /** True when this was answered from records already in hand. */
  readonly usedContext?: boolean;
  /**
   * What extra was opened, when anything was — the reply must say so.
   *
   * A record read in full, a collection attached to it, or a record it points
   * at. All three cost a request nobody explicitly asked for, and a lookup
   * nobody was told about is the kind of cost that gets a feature switched off.
   */
  readonly openedRelated?: string;
  /**
   * What could not be read, and why — the reply must say this too.
   *
   * `openedRelated` above exists because a cost nobody was told about erodes
   * trust in the feature. This is the same obligation for accuracy rather than
   * for money: a source that refused is the difference between "you have no
   * overdue invoices" and "I could not open your invoicing account", and only
   * one of those is something the user can act on. Both a connection skipped
   * before ranking and a source that refused when read land here, because from
   * the reply's side they are the same sentence.
   */
  readonly unreadable?: ReadonlyArray<{
    readonly source: string;
    readonly reason: string;
  }>;
  /**
   * What else was reachable from the records found, in the API's own words.
   *
   * Present when the search went past the rows it matched. The reply should
   * say what was checked — "its own record and its history" — because the
   * alternative is a user who has to guess at the product's plumbing to
   * unlock an answer, having been told only that something was not there.
   *
   * Never op ids and never the word "endpoint": these are the names the API
   * gives its own things, which is the closest thing to the user's vocabulary
   * that exists without inventing one.
   */
  readonly couldCheck?: ReadonlyArray<{
    readonly title: string;
    readonly note: string;
  }>;
  readonly findings: ReadonlyArray<{
    readonly source: string;
    readonly tab?: string;
    /** Which connection this source belongs to, so an answer can itemize. */
    readonly from?: string;
    /** The field carrying each record's identity, never narrowed away. */
    readonly idField?: string;
    /** What the judge read out of this source alone. */
    readonly answer?: string;
    /** How many of its records the question was about. */
    readonly matched?: number;
    readonly describes: string;
    readonly columns: readonly string[];
    /** The columns the tile draws, when it says. Used to narrow a big dump. */
    readonly shows?: readonly string[];
    readonly coverage: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly caveats: readonly string[];
  }>;
  readonly requests: number;
  /**
   * What reading every record turned up, when the user asked for that.
   *
   * Absent on the ordinary path. Present it carries the joined answer plus the
   * patterns nobody asked about — which is the point of paying for a deep
   * read rather than a wider sample.
   */
  readonly deep?: {
    readonly answer: string;
    readonly trends: string;
    readonly caveats: string;
    readonly scanned: number;
    readonly chunks: number;
    readonly notRead: number;
  };
  /** Merged into the assistant message's `toolPayload` by the chat engine. */
  readonly payload?: {
    readonly kind: "coverage";
    readonly scanned: number;
    readonly of: number | null;
    readonly orderedBy: string | null;
    readonly sources: readonly string[];
  };
  readonly componentIds?: readonly string[];
}

/** Human-readable coverage, phrased so it cannot overclaim. */
export const coverageSentence = (evidence: Evidence): string => {
  const { coverage } = evidence;
  if (!coverage.partial) return `read in full — all ${coverage.scanned} record(s)`;
  /*
   * "the 50 most recent" is only true when something really sorted them. With
   * no sort the honest phrase names the order the source happened to return,
   * which is what the user will see if they go and look.
   */
  return coverage.orderedBy
    ? `read the first ${coverage.scanned} in order of ${coverage.orderedBy}` +
        (coverage.of !== null ? ` of ${coverage.of} available here` : "")
    : `read the first ${coverage.scanned} this source lists, in no particular order` +
        (coverage.of !== null ? ` of ${coverage.of} available here` : "");
};

export const answerFromData = async (
  args: unknown,
  deps: AnswerDeps,
): Promise<AnswerResult | { error: string }> => {
  const parsed = answerSchema.safeParse(args);
  if (!parsed.success) return { error: "that question could not be read" };
  if (!deps.llm) {
    return { error: "there is no AI key configured, so the data cannot be searched" };
  }
  // Captured after the guard: narrowing a property does not survive into the
  // callbacks below, and `reach` is one.
  const llm = deps.llm;

  const everywhere = buildCandidates({
    handles: deps.handles,
    context: deps.context,
    resolved: deps.resolved,
    isCached: deps.isCached,
  });
  /*
   * Where they said to look, when they said. A hard constraint rather than an
   * inference: reading a platform nobody named spends their quota on a
   * question they did not ask.
   */
  const candidates = parsed.data.source
    ? narrowTo(everywhere, parsed.data.source, deps.context.connections)
    : everywhere;

  const limit = parsed.data.scanRecords ?? PAGE_SIZE;
  const widgetOf = new Map(deps.handles.map((entry) => [entry.handle, entry]));

  /*
   * What every connected API can be asked to do, derived from its map.
   *
   * Nothing below knows which API it is talking to: a binding says which
   * endpoint returns one record, which input takes its identifier and which
   * field on a row supplies it, and those facts are true of every API that has
   * records at all.
   */
  const bindings = bindingsFor({ context: deps.context });
  const toolDeps: ToolDeps = {
    read: deps.read,
    resolved: deps.resolved,
    rowsOf: deps.rowsOf,
    rowsPathFor: deps.rowsPathFor,
  };

  /*
   * What the conversation is already about, before anything is read.
   *
   * Three futures, cheapest first, and the ordering is the whole point: a
   * follow-up about the record just discussed should not spend a request or a
   * search to arrive back where the conversation already was.
   */
  const stored = deps.focus ? await deps.focus.get(deps.sessionId) : null;
  const focus = deps.onScreen ?? stored;
  if (focus) {
    const recalled = await recallFromFocus(
      deps.llm,
      { question: parsed.data.question, focus },
      { ...(deps.model ? { model: deps.model } : {}) },
    );

    if (recalled.decision === "answer") {
      return {
        outcome: "found",
        looked: [focus.source],
        missing: "",
        answer: recalled.answer,
        usedContext: true,
        findings: [
          {
            source: focus.sourceTitle || focus.source,
            describes: "records already in hand from earlier in this conversation",
            columns: [...new Set(focus.records.flatMap((row) => Object.keys(row)))],
            coverage: `${focus.records.length} record(s) held from the earlier question`,
            rows: focus.records,
            caveats: [],
          },
        ],
        requests: 0,
        componentIds: [focus.source],
      };
    }

    if (recalled.decision === "related") {
      /*
       * Which of the held records this is about.
       *
       * The gap this closes: two tasks are found, the follow-up names one of
       * them, and opening whichever happened to sort first spends a request to
       * describe the *other* one — which reads exactly like a correct answer.
       * Empty means all of them, which is a real answer for "any notes on
       * those?".
       */
      const subject =
        recalled.records.length > 0
          ? recalled.records
              .map((index) => focus.records[index])
              .filter((record): record is Record<string, unknown> => record !== undefined)
          : focus.records;

      /*
       * Everything that can be opened from the records in hand, as one list.
       *
       * Built by `openableFrom`, which the SEARCH path also calls. They were
       * two separate walks of the same relation graph and the search's was the
       * poorer one — it saw only the record's own detail — so whether a
       * question could be answered depended on whether it arrived as a
       * follow-up or as a fresh search. One function, so that cannot recur.
       */
      const options = openableFrom({ context: deps.context, bindings, op: focus.op });

      const chosen = await pickOption(
        deps.llm,
        { wants: recalled.wants, options },
        { ...(deps.model ? { model: deps.model } : {}) },
      );
      if (!chosen) {
        return {
          outcome: "not-found",
          looked: [focus.source],
          missing:
            options.length === 0
              ? `this API exposes nothing further about these records, so ${recalled.wants} cannot be looked up`
              : `none of what can be opened from these records holds ${recalled.wants}`,
          answer: "",
          usedContext: true,
          // What was on offer, so the reply can name it rather than leaving
          // the user to guess what else there might have been.
          ...(options.length > 0 ? { couldCheck: describeOpenables(options) } : {}),
          findings: [],
          requests: 0,
        };
      }

      /*
       * Opening the record itself.
       *
       * The fuller records replace what the conversation is about, which is
       * the compounding part: a list row was kept because it was all there
       * was, and every later question about this record is now answered from
       * the whole thing for nothing.
       */
      if (chosen.kind === "record") {
        const ids = subject.flatMap((record) =>
          identityValue(record, chosen.binding.idField ?? focus.idField ?? "", chosen.binding.idField),
        );
        const opened = await readRecords({ binding: chosen.binding, ids, deps: toolDeps });

        /*
         * Merged, not replaced.
         *
         * The opened record supersedes the summary it was read from, but the
         * others stay: "any dishwasher or washing machine tasks?" followed by
         * "notes on the dishwasher one?" must not throw away the washing
         * machine, because "and the other one?" is the next thing anybody asks.
         */
        if (deps.focus && opened.records.length > 0) {
          await deps.focus.put(deps.sessionId, {
            ...focus,
            idField: chosen.binding.idField ?? focus.idField,
            records: mergeRecords(
              focus.records,
              opened.records,
              chosen.binding.idField ?? focus.idField,
            ).slice(0, 50),
            savedAt: new Date(deps.now()).toISOString(),
          });
        }

        return {
          outcome: opened.records.length > 0 ? "found" : "not-found",
          looked: [focus.source, chosen.binding.op],
          missing: opened.records.length > 0 ? "" : recalled.wants,
          answer: "",
          usedContext: true,
          openedRelated: opened.note,
          findings:
            opened.records.length > 0
              ? [
                  {
                    source: focus.sourceTitle || focus.source,
                    describes: `the full ${chosen.binding.resource} record`,
                    columns: [...new Set(opened.records.flatMap((row) => Object.keys(row)))],
                    coverage: `read in full — all ${opened.records.length} record(s)`,
                    rows: opened.records,
                    caveats: opened.warnings,
                  },
                ]
              : [],
          requests: opened.requests,
          componentIds: [focus.source],
        };
      }

      /* A record this one points at, opened with an id it already carries. */
      if (chosen.kind === "reference") {
        const opened = await readReferenced({
          reference: chosen.reference,
          from: subject,
          deps: toolDeps,
        });
        return {
          outcome: opened.records.length > 0 ? "found" : "not-found",
          looked: [focus.source, chosen.reference.to.op],
          missing: opened.records.length > 0 ? "" : recalled.wants,
          answer: "",
          usedContext: true,
          openedRelated: opened.note,
          findings:
            opened.records.length > 0
              ? [
                  {
                    source: chosen.reference.to.title,
                    describes: chosen.reference.to.describes,
                    columns: [...new Set(opened.records.flatMap((row) => Object.keys(row)))],
                    coverage: `read in full — all ${opened.records.length} record(s)`,
                    rows: opened.records,
                    caveats: opened.warnings,
                  },
                ]
              : [],
          requests: opened.requests,
          componentIds: [focus.source],
        };
      }

      const related = await readRelated({
        // Narrowed to what the follow-up is about, so a fan-out of one request
        // per record is spent on the records that were actually asked about.
        focus: { ...focus, records: subject },
        child: chosen.child,
        read: deps.read,
        resolved: deps.resolved,
        rowsOf: deps.rowsOf,
        rowsPath: deps.rowsPathFor(chosen.child.op),
        limit,
      });

      return {
        outcome: related.evidence && related.evidence.rows.length > 0 ? "found" : "not-found",
        looked: [focus.source, chosen.child.op],
        missing: related.evidence?.rows.length ? "" : recalled.wants,
        answer: "",
        usedContext: true,
        openedRelated: related.note,
        findings: related.evidence
          ? [
              {
                source: related.evidence.candidate.title,
                describes: related.evidence.candidate.describes,
                columns: related.evidence.columns,
                coverage: coverageSentence(related.evidence),
                rows: related.evidence.rows,
                caveats: related.evidence.warnings,
              },
            ]
          : [],
        requests: related.requests,
        componentIds: [focus.source],
      };
    }
  }


  const readCandidate = async (candidate: Candidate): Promise<Evidence | null> => {
    /*
     * Cached sources are read cache-only, so a source the ranker chose BECAUSE
     * it was free cannot quietly turn into a request when the entry expires
     * between ranking and reading. It comes back null and the loop moves on.
     */
    const cacheOnly = candidate.cached;
    if (candidate.kind === "widget") {
      const entry = widgetOf.get(candidate.id);
      if (!entry) return null;
      return readWidget({
        candidate,
        widget: entry.widget,
        resolved: deps.resolved,
        read: deps.read,
        cacheOnly,
        now: deps.now(),
        timeZone: deps.timeZone,
        limit,
      });
    }
    return readEndpoint({
      candidate,
      resolved: deps.resolved,
      read: deps.read,
      cacheOnly,
      rowsPath: deps.rowsPathFor(candidate.op),
      rowsOf: deps.rowsOf,
      limit,
    });
  };

  const result = await runContextHarness(parsed.data.question, {
    llm: deps.llm,
    ...(deps.model ? { model: deps.model } : {}),
    candidates,
    readCandidate,
    /*
     * The rows named the record and did not carry the answer.
     *
     * Everything reachable from them is offered, and the model chooses against
     * what the judge said was still missing. This used to open the record's own
     * detail and nothing else, which could only find what an API happens to
     * model as a field — so a user asking about notes an API keeps in a
     * subcollection was told they did not exist, and had to name the mechanism
     * themselves to get them. See `reach.ts` for the transcript.
     */
    reach: async ({ matched, from, missing }) => {
      const options = openableFrom({
        context: deps.context,
        bindings,
        op: from.candidate.op,
      });
      if (options.length === 0) return null;

      const considered = describeOpenables(options);
      /*
       * Steered by what is still missing rather than by the question. The
       * judge has just read the rows and said what they did not carry, and
       * that sentence is a far better brief than the original wording — "the
       * notes are not in these rows" picks a notes collection; "any correlating
       * issue?" does not.
       */
      const chosen = await pickOption(
        llm,
        { wants: missing || parsed.data.question, options },
        { ...(deps.model ? { model: deps.model } : {}) },
      );
      // Nothing on offer fits. Still worth reporting what was on offer — that
      // is the difference between a dead end and a silent one.
      if (!chosen) return { evidence: null, note: "", considered };

      const reached = await openFrom({
        chosen,
        subject: matched,
        from: from.candidate,
        fallbackIdField: identityFor(deps.context, from.candidate.op),
        deps: toolDeps,
        read: deps.read,
        resolved: deps.resolved,
        rowsOf: deps.rowsOf,
        rowsPath: deps.rowsPathFor(
          chosen.kind === "collection" ? chosen.child.op : from.candidate.op,
        ),
        limit,
      });
      return { evidence: reached.evidence, note: reached.note, considered };
    },
    /*
     * "Has anyone mentioned running late?" is a different question from "what
     * is the highest rent?" — the first is answered by every source that could
     * hold it, itemized, and stopping at the first hit would report one
     * platform's three and never mention the other's four.
     */
    ...(parsed.data.across ? { scope: { mode: "all" as const } } : {}),
    ...(deps.budget ? { budget: deps.budget } : { budget: DEFAULT_BUDGET }),
    /*
     * The request's money ceiling, alongside its source and request budgets.
     * Null outside a metered request — every existing caller, including the
     * tests and the eval harness — where it reads as "no ceiling" and the loop
     * behaves exactly as it did.
     */
    overBudget: () => {
      const turn = turnSpendSoFar();
      return turn !== null && turn.usd >= turn.ceilingUsd;
    },
  });

  /*
   * What the conversation is now about.
   *
   * Saved only when the search actually identified records — a question about
   * a set as a whole ("how many are there?") matches no particular row and
   * must not displace whatever the conversation was about before. Saved whole
   * and unnarrowed, so a follow-up on any field of them costs nothing.
   */
  if (deps.focus && result.matched.length > 0 && result.matchedFrom) {
    const from = result.matchedFrom;
    const saved: Focus = {
      question: parsed.data.question,
      source: from.candidate.id,
      sourceTitle: from.candidate.title,
      connection: from.candidate.connection,
      op: from.candidate.op,
      idField: identityFor(deps.context, from.candidate.op),
      records: result.matched.slice(0, 50) as Record<string, unknown>[],
      savedAt: new Date(deps.now()).toISOString(),
    };
    await deps.focus.put(deps.sessionId, saved);
  }

  const widest = [...result.evidence].sort(
    (a, b) => Number(b.coverage.partial) - Number(a.coverage.partial),
  )[0];

  /*
   * A deep read is a different act, not a bigger sample.
   *
   * One model call over fifty rows answers "how many"; it cannot answer "why
   * did that change" over four hundred, because the rows do not fit and the
   * middle gets summarised away. So when the user has asked for more than a
   * sample, the records are cut into chunks, each read on its own, and the
   * findings joined. It runs on the biggest thing that was read — going deep
   * into two sources at once doubles the cost to answer one question.
   */
  let deep: DeepFinding | null = null;
  const deepest = [...result.evidence].sort((a, b) => b.rows.length - a.rows.length)[0];
  const chunkSize = deps.chunkSize ?? CHUNK_SIZE;
  if (parsed.data.scanRecords !== undefined && deepest && deepest.rows.length > chunkSize) {
    deep = await analyseDeep(
      deps.llm,
      { question: parsed.data.question, evidence: deepest },
      { chunkSize },
    );
  }

  /*
   * What the reply has to admit it could not see.
   *
   * The two halves are reported on different terms, on purpose:
   *
   *   A source that REFUSED was chosen — the ranker looked at the question and
   *   judged this the likeliest place for the answer — so its failure is part
   *   of the story of this question whatever else was found.
   *
   *   A connection SKIPPED for having no key was never about this question.
   *   Naming it on a turn that was answered perfectly well is noise, and noise
   *   attached to every reply is how a caveat stops being read. It earns its
   *   place only when the search came back without an answer, where "one of
   *   your accounts is not connected" is very often the actual reason.
   */
  const unreadable = [
    ...result.unreadable.map((entry) => ({
      source: entry.candidate.title,
      reason: entry.reason,
    })),
    ...(result.outcome === "found"
      ? []
      : unreadableConnections(deps.context).map((entry) => ({
          source: entry.title,
          reason: entry.reason,
        }))),
  ];

  return {
    outcome: result.outcome,
    looked: result.tried,
    /*
     * The harness says "there is nothing connected to read" when it is handed
     * no candidates, which was the only way that could happen until connections
     * without a key started being filtered out before ranking. Now it can be
     * flatly untrue — there may be several connections, all of them unreadable
     * — and it would contradict the `unreadable` list in the same payload. The
     * harness has no business knowing about credentials, so the correction is
     * made here, where both facts are in hand.
     */
    missing:
      result.outcome === "no-sources" && unreadable.length > 0
        ? "nothing that is connected can currently be read"
        : result.missing,
    answer: result.answer,
    // Anything that cost a request nobody explicitly asked for. The reply is
    // required to say it happened.
    ...(result.notes.length > 0 ? { openedRelated: result.notes.join(" ") } : {}),
    /*
     * Sources that refused when read, plus connections that were never offered
     * to the ranker because they hold no key. Merged deliberately: the user
     * does not care which side of the read the obstacle sat on, only that a
     * place the answer might have been was not looked at, and why.
     */
    ...(unreadable.length > 0 ? { unreadable } : {}),
    /*
     * Where the search went beyond the rows it matched. Carried on every
     * outcome — on a hit it names the thing the answer came out of, and on a
     * miss it is the difference between "neither its record nor its history
     * carries notes" and "I don't have notes", which is the sentence that sent
     * a real user back to ask for what had already been tried.
     */
    ...(result.considered.length > 0 ? { couldCheck: result.considered } : {}),
    findings: result.evidence.map((evidence) => ({
      source: evidence.candidate.title,
      ...(evidence.candidate.tab ? { tab: evidence.candidate.tab } : {}),
      /*
       * Which API this came from, and what it said on its own. Both are what
       * an itemized answer is made of: "platform X has three" cannot be
       * written from a combined total.
       */
      from: evidence.candidate.connection,
      // So the reply's own narrowing cannot drop the field every follow-up
      // needs — the same protection the judge gets.
      ...(evidence.candidate.idField ? { idField: evidence.candidate.idField } : {}),
      ...(evidence.answer ? { answer: evidence.answer } : {}),
      ...(evidence.matched !== undefined ? { matched: evidence.matched } : {}),
      describes: evidence.candidate.describes,
      columns: evidence.columns,
      ...(evidence.shows ? { shows: evidence.shows } : {}),
      coverage: coverageSentence(evidence),
      rows: evidence.rows,
      caveats: evidence.warnings,
    })),
    requests: result.spent.requests,
    ...(deep
      ? {
          deep: {
            answer: deep.answer,
            trends: deep.trends,
            caveats: deep.caveats,
            scanned: deep.scanned,
            chunks: deep.chunkCount,
            notRead: deep.skipped,
          },
        }
      : {}),
    /*
     * Carried to the bubble so the "dig deeper" note states what was really
     * read rather than a constant. Only present when going deeper could
     * actually find more.
     */
    ...(result.canGoDeeper && widest
      ? {
          payload: {
            kind: "coverage" as const,
            scanned: widest.coverage.scanned,
            of: widest.coverage.of,
            orderedBy: widest.coverage.orderedBy,
            sources: result.evidence.map((evidence) => evidence.candidate.title),
          },
        }
      : {}),
    /*
     * Every widget that was actually read, so the reply can cite it and the
     * user can click through to the tile the number came from.
     */
    ...(result.evidence.length > 0
      ? {
          componentIds: result.evidence
            .filter((evidence) => evidence.candidate.kind === "widget")
            .map((evidence) => evidence.candidate.id),
        }
      : {}),
  };
};
