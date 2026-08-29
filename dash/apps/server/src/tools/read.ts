import type { LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import { MAX_RELATED_RECORDS } from "../context/related.js";
import type { Reference, ToolBinding, ToolDeps, ToolResult } from "./types.js";

/**
 * Open one record, whole.
 *
 * The verb the assistant was missing. A collection endpoint returns a summary
 * of each record — enough to draw a table — and the record's own endpoint
 * returns everything. Asked for the notes on a task it had already found, the
 * assistant re-read the same fifty summaries twice and twice reported that the
 * description "was not included in the available rows". It was one request
 * away and there was no path to it.
 *
 * Two things are the same act here, which is what keeps this one tool:
 *
 *   expand — the record in hand, with the fields the list left out.
 *   follow — a record it points at, opened with an id it already carries.
 *
 * Both are "call the endpoint that returns one record, with an identifier".
 * The only difference is where the identifier came from, so there is one
 * implementation and `Reference` supplies the field.
 *
 * Every read costs a request, so the fan-out is capped and counted and the
 * reply is expected to say it happened.
 */

/**
 * Records opened in one go.
 *
 * The same cap a related read uses, and the same number for the same reason:
 * enough to answer "what are the notes on those?" for a handful of matches,
 * small enough that it cannot eat a budget meant for a whole turn.
 */
export const MAX_RECORDS_OPENED = MAX_RELATED_RECORDS;

/** Read a dotted path, so a nested identifier is reachable by name. */
const at = (record: Record<string, unknown>, path: string): unknown => {
  if (path in record) return record[path];
  let value: unknown = record;
  for (const step of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  return value;
};

/** Case-insensitive `id`-ish key, for an object reference whose shape is unknown. */
const idKeyOf = (value: Record<string, unknown>): string | undefined =>
  Object.keys(value).find((key) => key.toLowerCase() === "id") ??
  Object.keys(value).find((key) => key.toLowerCase().endsWith("id"));

/**
 * The identifiers a field holds, whatever shape it holds them in.
 *
 * Three shapes, all ordinary, and two of them fail silently when handled as
 * the first: `PropertyIds: [42, 51]` never equals an id, and
 * `Property: { Id: 42 }` stringifies to `[object Object]`. Both read as a
 * record with nothing linked rather than as a mistake, which is why this
 * inspects the value rather than trusting what the map said it would be.
 */
export const identityValue = (
  record: Record<string, unknown>,
  field: string,
  idField?: string | undefined,
): string[] => {
  const value = at(record, field);
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      item !== null && typeof item === "object"
        ? identityValue({ item } as Record<string, unknown>, "item", idField)
        : [String(item)],
    );
  }

  if (typeof value === "object") {
    const inner = value as Record<string, unknown>;
    const key = (idField && idField in inner ? idField : undefined) ?? idKeyOf(inner);
    const found = key ? inner[key] : undefined;
    return found === null || found === undefined ? [] : [String(found)];
  }

  return [String(value)];
};

export interface ReadRecordsInput {
  readonly binding: ToolBinding;
  /** Identifiers to open. De-duplicated and capped here. */
  readonly ids: readonly string[];
  readonly deps: ToolDeps;
  /**
   * Answer from the cache or not at all.
   *
   * True when the browser has already drawn this record — talking about what
   * somebody is looking at must never quietly buy it a second time.
   */
  readonly cacheOnly?: boolean;
  readonly limit?: number;
}

/** What was opened, and the fuller records it produced. */
export interface ReadRecordsResult extends ToolResult {
  /** Ids asked for but not returned, so nothing is reported as absent wrongly. */
  readonly missed: readonly string[];
}

export const readRecords = async (input: ReadRecordsInput): Promise<ReadRecordsResult> => {
  const { binding, deps } = input;
  const wanted = [...new Set(input.ids.filter((id) => id !== ""))];
  const cap = input.limit ?? MAX_RECORDS_OPENED;
  const ids = wanted.slice(0, cap);

  if (!binding.idParam) {
    return {
      records: [],
      requests: 0,
      missed: wanted,
      warnings: [],
      note:
        `"${binding.title}" has no endpoint that takes an identifier, so a single ` +
        "record cannot be opened from it.",
    };
  }
  if (ids.length === 0) {
    return {
      records: [],
      requests: 0,
      missed: [],
      warnings: [],
      note: `No identifier was available, so no ${binding.resource} could be opened.`,
    };
  }

  const rowsPath = deps.rowsPathFor(binding.op);
  const records: Record<string, unknown>[] = [];
  const missed: string[] = [];
  let requests = 0;
  let refused = "";

  for (const id of ids) {
    const outcome = await deps.read({
      connection: binding.connection,
      op: binding.op,
      params: { [binding.idParam]: id },
      resolved: deps.resolved,
      cacheOnly: input.cacheOnly ?? false,
    });
    if (!outcome) {
      missed.push(id);
      continue;
    }
    if (!outcome.ok) {
      // The API's own words. A 403 says the key works and lacks a scope, which
      // is the one part of this somebody can act on.
      refused = outcome.reason;
      missed.push(id);
      continue;
    }
    requests += outcome.requests;
    const rows = deps.rowsOf(outcome.body, rowsPath);
    const record = rows[0];
    if (record) records.push(record);
    else missed.push(id);
  }

  const warnings: string[] = [];
  if (refused) warnings.push(refused);
  else if (missed.length > 0 && records.length > 0) {
    warnings.push(`${missed.length} of the ${ids.length} records could not be opened`);
  }

  const covered = wanted.length > ids.length ? ` (${ids.length} of ${wanted.length})` : "";
  const note =
    records.length === 0
      ? refused
        ? `Could not open the full ${binding.resource} record: ${refused}`
        : `The full ${binding.resource} record could not be opened.`
      : `Opened the full ${binding.resource} record${records.length > 1 ? "s" : ""}${covered} — ` +
        `${requests} request(s).`;

  return {
    records,
    requests,
    missed,
    warnings,
    note,
    ...(refused ? { refused } : {}),
  };
};

/**
 * Open the records a held record points at.
 *
 * The identifier comes off the record already in hand, which is what makes
 * this a lookup rather than a second search — and what makes it work on an API
 * that offers no way to search for the thing at all.
 */
export const readReferenced = async (input: {
  readonly reference: Reference;
  readonly from: readonly Record<string, unknown>[];
  readonly deps: ToolDeps;
  readonly cacheOnly?: boolean;
  readonly limit?: number;
}): Promise<ReadRecordsResult> => {
  const ids = input.from.flatMap((record) =>
    identityValue(record, input.reference.field, input.reference.to.idField),
  );
  return readRecords({
    binding: input.reference.to,
    ids,
    deps: input.deps,
    ...(input.cacheOnly !== undefined ? { cacheOnly: input.cacheOnly } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
};

/* ── the chat-facing tool ──────────────────────────────────────────────── */

export const readToolSchema = z.object({
  resource: z
    .string()
    .min(1)
    .max(120)
    .describe("Which kind of record to open. Use one of the names you were shown."),
  id: z
    .string()
    .min(1)
    .max(200)
    .describe("The record's own identifier, exactly as it appeared in the data."),
});

export type ReadToolArgs = z.infer<typeof readToolSchema>;

export const READ_TOOL_NAME = "read_record";

/**
 * The tool as the model sees it.
 *
 * Static, because the engine takes its tool schemas once and connections come
 * and go afterwards. What can actually be opened is therefore *not* listed
 * here — it goes in the workspace knowledge, which is rebuilt every turn (see
 * `readRoster`). Splitting it this way is what keeps a newly connected API
 * usable without a restart.
 */
export const READ_TOOL: LlmTool = {
  name: READ_TOOL_NAME,
  description:
    "Open one record in full, by its identifier. A collection shows a summary of each " +
    "record; this returns the whole thing - descriptions, notes, and every field the " +
    "summary left out. Call it whenever an answer needs a field the rows in hand do not " +
    "carry, rather than saying the field is not available: it usually is, one request " +
    "away. Also call it to open a record that another record points at. The kinds of " +
    "record you can open, and what identifies each, are listed in what you know about " +
    "this workspace. Costs one request.",
  schema: readToolSchema,
};
