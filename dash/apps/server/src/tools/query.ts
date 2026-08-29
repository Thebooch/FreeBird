import type { LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import { PAGE_SIZE } from "../context/read.js";
import type { ToolBinding, ToolDeps, ToolResult } from "./types.js";

/**
 * Narrow a collection before reading it.
 *
 * The verb between "list everything" and "open one record". Without it the
 * only way to find something is to read a page and hope it is on it, which is
 * how a search over fifty rows comes to report that a record does not exist
 * when it is on page three.
 *
 * Written against **roles**, never names — the reason one implementation
 * serves every connected API. `paramDefSchema` states the case: every vendor
 * spells the same idea differently, `q` / `search` / `filter`, `since` /
 * `start_date` / `created[gte]`, and recording what an input *does* is what
 * lets a caller offer "narrow this to a date range" without knowing the
 * vendor's vocabulary.
 *
 * Two ways to narrow, and the difference is reported rather than smoothed
 * over, because only one of them is bounded by the API:
 *
 *   sent    — the endpoint accepted the filter. The API decided what matches,
 *             over everything it holds.
 *   matched — the endpoint accepts nothing that fits, so a page was read and
 *             matched here. That is a search over the page, not over the
 *             collection, and saying otherwise turns "not on this page" into
 *             "does not exist".
 */

export interface QueryInput {
  readonly binding: ToolBinding;
  readonly deps: ToolDeps;
  /** Free text. Sent when the endpoint declares a search input, else matched here. */
  readonly text?: string | undefined;
  /** Values for the endpoint's own filters, by parameter name. */
  readonly filters?: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined;
  readonly limit?: number | undefined;
  readonly cacheOnly?: boolean | undefined;
}

export interface QueryResult extends ToolResult {
  /** Which inputs the endpoint actually accepted, so the reply can be exact. */
  readonly sent: Readonly<Record<string, string | number | boolean>>;
  /** True when the text was matched here rather than by the API. */
  readonly matchedLocally: boolean;
  /** True when more records exist beyond what was read. */
  readonly partial: boolean;
}

/** Does this record contain the text anywhere? The honest local fallback. */
const contains = (record: Record<string, unknown>, text: string): boolean =>
  JSON.stringify(record).toLowerCase().includes(text.toLowerCase());

export const queryRecords = async (input: QueryInput): Promise<QueryResult> => {
  const { binding, deps } = input;
  const limit = input.limit ?? PAGE_SIZE;
  const text = input.text?.trim() ?? "";

  /*
   * Only what this endpoint declared. A filter the model invented is dropped
   * rather than sent: an unknown query parameter is ignored by some APIs and a
   * 400 on others, and both produce a result that looks like an answer.
   */
  const accepted = new Set((binding.filters ?? []).map((param) => param.name));
  const sent: Record<string, string | number | boolean> = {};
  const rejected: string[] = [];
  for (const filter of input.filters ?? []) {
    if (accepted.has(filter.name)) sent[filter.name] = filter.value;
    else rejected.push(filter.name);
  }

  const searchable = Boolean(binding.search) && text !== "";
  if (binding.search && searchable) sent[binding.search] = text;

  const outcome = await deps.read({
    connection: binding.connection,
    op: binding.op,
    params: sent,
    resolved: deps.resolved,
    cacheOnly: input.cacheOnly ?? false,
  });

  if (!outcome) {
    return {
      records: [],
      requests: 0,
      sent,
      matchedLocally: false,
      partial: false,
      warnings: [],
      note: `"${binding.title}" could not be read.`,
    };
  }
  if (!outcome.ok) {
    return {
      records: [],
      requests: 0,
      sent,
      matchedLocally: false,
      partial: false,
      warnings: [outcome.reason],
      refused: outcome.reason,
      note: `"${binding.title}" could not be read: ${outcome.reason}`,
    };
  }

  const all = deps.rowsOf(outcome.body, deps.rowsPathFor(binding.op));
  const matchedLocally = text !== "" && !searchable;
  const found = matchedLocally ? all.filter((record) => contains(record, text)) : all;
  const records = found.slice(0, limit);

  const warnings: string[] = [];
  if (rejected.length > 0) {
    warnings.push(
      `this endpoint does not accept ${rejected.join(", ")}, so ${
        rejected.length === 1 ? "that filter was" : "those filters were"
      } not applied`,
    );
  }
  /*
   * The distinction that stops a page being reported as a collection. A local
   * match over a page the API cut short proves nothing about what is beyond
   * it, and "no results" is exactly the claim that would be wrong.
   */
  if (matchedLocally && outcome.truncated) {
    warnings.push(
      `"${text}" was matched against the records that were read, and the endpoint stopped ` +
        "before the collection ran out, so this is not proof that nothing else matches",
    );
  }
  if (found.length > limit) {
    warnings.push(`${found.length - limit} more matched than are shown here`);
  }

  const how = matchedLocally
    ? `read ${all.length} record(s) from "${binding.title}" and matched "${text}" among them ` +
      "here, because this endpoint declares no search input"
    : searchable
      ? `asked "${binding.title}" to search for "${text}"`
      : `read "${binding.title}"`;
  const narrowed = Object.keys(sent).filter((name) => name !== binding.search);

  return {
    records,
    requests: outcome.requests,
    sent,
    matchedLocally,
    partial: outcome.truncated || found.length > limit,
    warnings,
    note:
      `${how}${narrowed.length > 0 ? `, narrowed by ${narrowed.join(", ")}` : ""} — ` +
      `${records.length} record(s), ${outcome.requests} request(s).`,
  };
};

/* ── the chat-facing tool ──────────────────────────────────────────────── */

export const queryToolSchema = z.object({
  resource: z
    .string()
    .min(1)
    .max(120)
    .describe("Which collection to narrow. Use one of the names you were shown."),
  text: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Words to look for. Sent to the API when the endpoint can search; otherwise a page " +
        "is read and matched here, and the result says which happened.",
    ),
  /*
   * Name/value pairs rather than an object, because the tool-schema subset is
   * deliberately flat — no records, no unions — so that there is no dependency
   * on a general zod-to-JSON-schema converter and none of its failure modes.
   * It also reads more explicitly to a model than a free-form object would.
   */
  filters: z
    .array(
      z.object({
        name: z.string().max(120).describe("The parameter name, exactly as you were shown it."),
        value: z.string().max(400).describe("The value to filter by."),
      }),
    )
    .optional()
    .describe(
      "Values for this endpoint's own filters. Only names the endpoint declares are sent; " +
        "anything else is reported as not applied.",
    ),
});

export type QueryToolArgs = z.infer<typeof queryToolSchema>;

export const QUERY_TOOL_NAME = "query_records";

/**
 * Static, like `read_record` and for the same reason: the engine takes tool
 * schemas once, and what is actually queryable is listed in the per-turn
 * workspace knowledge so a newly connected API needs no restart.
 */
export const QUERY_TOOL: LlmTool = {
  name: QUERY_TOOL_NAME,
  description:
    "Narrow a collection before reading it - by words, by a date range, or by the filters " +
    "the endpoint itself declares. Use this to find records rather than reading a page and " +
    "hoping what you want is on it. The collections you can narrow, and what each one " +
    "accepts, are listed in what you know about this workspace. The result says whether " +
    "the API did the filtering or whether a page was read and matched here, which matters: " +
    "only the first is a statement about the whole collection.",
  schema: queryToolSchema,
};
