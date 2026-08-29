import type { ConciergeContext, LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import type { DashboardSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { WidgetHandle } from "../chat/handles.js";
import { buildCandidates } from "./candidates.js";
import type { Focus, FocusStore } from "./focus.js";
import { recallFromFocus } from "./recall.js";
import { identityFor, pickRelated, readRelated, relatedFor } from "./related.js";
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
    "only when the user has asked to look deeper.",
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
  /** What extra collection was opened, when one was — the reply must say so. */
  readonly openedRelated?: string;
  readonly findings: ReadonlyArray<{
    readonly source: string;
    readonly tab?: string;
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

  const candidates = buildCandidates({
    handles: deps.handles,
    context: deps.context,
    resolved: deps.resolved,
    isCached: deps.isCached,
  });

  const limit = parsed.data.scanRecords ?? PAGE_SIZE;
  const widgetOf = new Map(deps.handles.map((entry) => [entry.handle, entry]));

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
      const options = relatedFor(deps.context, focus.op);
      const child = await pickRelated(
        deps.llm,
        { wants: recalled.wants, options },
        { ...(deps.model ? { model: deps.model } : {}) },
      );
      if (!child) {
        return {
          outcome: "not-found",
          looked: [focus.source],
          missing:
            options.length === 0
              ? `nothing is recorded as attached to these records, so ${recalled.wants} cannot be looked up`
              : `none of what is attached to these records holds ${recalled.wants}`,
          answer: "",
          usedContext: true,
          findings: [],
          requests: 0,
        };
      }

      const related = await readRelated({
        focus,
        child,
        read: deps.read,
        resolved: deps.resolved,
        rowsOf: deps.rowsOf,
        rowsPath: deps.rowsPathFor(child.op),
        limit,
      });

      return {
        outcome: related.evidence && related.evidence.rows.length > 0 ? "found" : "not-found",
        looked: [focus.source, child.op],
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
    ...(deps.budget ? { budget: deps.budget } : { budget: DEFAULT_BUDGET }),
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

  return {
    outcome: result.outcome,
    looked: result.tried,
    missing: result.missing,
    answer: result.answer,
    findings: result.evidence.map((evidence) => ({
      source: evidence.candidate.title,
      ...(evidence.candidate.tab ? { tab: evidence.candidate.tab } : {}),
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
