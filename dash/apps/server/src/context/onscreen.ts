import type { ConciergeContext } from "@freebirdai/dash-agent";
import type { ResolvedParams } from "@freebirdai/dash-spec";
import type { WidgetHandle } from "../chat/handles.js";
import type { Focus } from "./focus.js";
import { readWidget } from "./read.js";
import { identityFor } from "./related.js";
import type { OpReader } from "./types.js";

/**
 * What the person is actually looking at.
 *
 * Showing somebody the widget and letting them click around is a good way to
 * work — some people would far rather do that than read a paragraph — and the
 * assistant should be able to hold a conversation about whatever it lands
 * them on. Without this, opening a record and asking "what is this?" is
 * unanswerable: the chat knows which board is open and nothing finer, so the
 * question has no subject.
 *
 * The client says what it is showing; this turns that into the same shape a
 * search produces, so one record on screen and one record found are the same
 * kind of thing to everything downstream.
 *
 * It never spends a request. The widget is read cache-only — the browser has
 * just drawn this record, so the rows are already there, and a chat turn that
 * quietly bought data to work out what somebody was looking at would be
 * exactly the invisible cost this codebase refuses everywhere else.
 */

export interface OpenRecord {
  readonly widgetId: string;
  readonly recordId: string;
}

/**
 * Parse the view the client reported.
 *
 * `board`, or `record:<widgetId>:<recordId>`. Anything unrecognised is treated
 * as the board rather than an error: a newer client, a hand-edited header or a
 * stale tab should cost the conversation nothing more than this extra context.
 */
export const parseView = (header: unknown): OpenRecord | null => {
  if (typeof header !== "string") return null;
  const parts = header.split(":");
  if (parts[0] !== "record" || parts.length < 3) return null;
  try {
    const widgetId = decodeURIComponent(parts[1] ?? "");
    const recordId = decodeURIComponent(parts.slice(2).join(":"));
    if (!widgetId || !recordId) return null;
    return { widgetId, recordId };
  } catch {
    return null;
  }
};

export interface OnScreenInput {
  readonly open: OpenRecord;
  readonly handles: readonly WidgetHandle[];
  readonly context: ConciergeContext;
  readonly resolved: ResolvedParams;
  readonly read: OpReader;
  readonly now: () => number;
  readonly timeZone: string;
  /** Turns a detail response into rows, the way the rest of the product does. */
  readonly rowsOf: (body: unknown) => Record<string, unknown>[];
}

/**
 * The record on screen, as a focus.
 *
 * Returns null when it cannot be established for free — a cold cache, a widget
 * that no longer exists, an identifier the rows do not carry. The reply then
 * simply does not know which record is open, which is where it was before.
 */
export const focusFromScreen = async (
  input: OnScreenInput,
): Promise<Focus | null> => {
  /*
   * The DOM carries the widget's own id; the registry addresses widgets by a
   * handle that is only qualified when two tabs share an id. Match on the
   * widget id, preferring the tab being looked at.
   */
  const entry =
    input.handles.find(
      (candidate) => candidate.widgetId === input.open.widgetId && candidate.current,
    ) ?? input.handles.find((candidate) => candidate.widgetId === input.open.widgetId);
  if (!entry) return null;

  const sources = entry.widget.sources.length > 0 ? entry.widget.sources : [];
  const op = sources[0]?.op ?? entry.widget.source?.op;
  const connection = sources[0]?.connection ?? entry.widget.source?.connection;
  if (!op || !connection) return null;

  const idField = identityFor(input.context, op);
  if (!idField) return null;

  /*
   * The record's own fetch first, because that is what the page made.
   *
   * A record page does not read the list — it calls the endpoint for that one
   * record, `/things/{id}`, and that is the request sitting in the cache. The
   * first version scanned the widget's rows instead, missed every time
   * somebody arrived by link, and reported that it could not tell what was on
   * screen while the record sat in the cache under a different key.
   *
   * It is also the better record: a detail endpoint returns everything, where
   * a list row carries whatever the collection chose to include.
   */
  const drilldown = entry.widget.drilldown;
  if (drilldown?.op) {
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(drilldown.params ?? {})) {
      // The drill-down states which input carries the row's identity, as a
      // `{{row.<field>}}` token. The value is the id from the address bar.
      params[name] = /\{\{\s*row\./.test(value) ? input.open.recordId : value;
    }
    const outcome = await input.read({
      connection,
      op: drilldown.op,
      params,
      resolved: input.resolved,
      cacheOnly: true,
    });
    if (outcome?.ok) {
      const rows = input.rowsOf(outcome.body);
      const record = rows[0];
      if (record) {
        return {
          question: "the record they have open",
          source: entry.handle,
          sourceTitle: entry.widget.title,
          connection,
          op,
          idField,
          records: [record],
          savedAt: new Date(input.now()).toISOString(),
        };
      }
    }
  }

  const evidence = await readWidget({
    candidate: {
      kind: "widget",
      id: entry.handle,
      title: entry.widget.title,
      describes: "",
      connection,
      op,
      fields: [],
      cached: true,
    },
    widget: entry.widget,
    resolved: input.resolved,
    read: input.read,
    // Free or not at all: the rows were drawn a moment ago.
    cacheOnly: true,
    now: input.now(),
    timeZone: input.timeZone,
  });
  if (!evidence) return null;

  const record = evidence.rows.find(
    (row) => String(row[idField] ?? "") === input.open.recordId,
  );
  if (!record) return null;

  return {
    question: "the record they have open",
    source: entry.handle,
    sourceTitle: entry.widget.title,
    connection,
    op,
    idField,
    records: [record],
    savedAt: new Date(input.now()).toISOString(),
  };
};

/** One line for the prompt, so the assistant can talk about what is on screen. */
export const describeScreen = (input: {
  readonly tab: string;
  readonly open: OpenRecord | null;
  readonly record: Focus | null;
}): string => {
  if (!input.open) {
    return `ON SCREEN — the "${input.tab}" tab, showing its widgets.`;
  }
  if (input.record) {
    return (
      `ON SCREEN — they have one record open from "${input.record.sourceTitle}" on the ` +
      `"${input.tab}" tab. It is in hand, so "this", "it" and "that one" mean that record ` +
      "and questions about it can be answered without searching."
    );
  }
  return (
    `ON SCREEN — they have a record open (${input.open.recordId}) from a widget on the ` +
    `"${input.tab}" tab, but its rows are not loaded here, so its fields are not in hand. ` +
    "Read it rather than guessing at what it says."
  );
};
