import type { ChildCollection, ConciergeContext, LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { Focus } from "./focus.js";
import { focusIds } from "./focus.js";
import type { Evidence, OpReader } from "./types.js";

/**
 * The things hanging off a record, reached by its identifier.
 *
 * "Any notes on that task?" is not a search. The record is already in hand and
 * so is its id; what is missing is a collection the API only exposes *under*
 * that id — its history, its documents, whatever belongs to it. Searching the
 * collections again cannot find those, because they are not in any collection.
 *
 * Which collections exist under a record is not knowledge about any particular
 * API: `ConciergeContext.children` is derived from the relation graph, which
 * worked it out from paths and foreign keys. An API with a different shape
 * offers different children and this reads the same.
 *
 * Every read here costs a request per record, so it is capped and counted, and
 * the reply is expected to say it happened — a lookup nobody asked for and
 * nobody was told about is the kind of cost that erodes trust in the feature
 * that made it.
 */

/**
 * How many focused records a related read will fan out over.
 *
 * One request each. Three is enough to answer "any notes on those?" for a
 * handful of matches and small enough that it cannot eat a budget meant for a
 * whole turn.
 */
export const MAX_RELATED_RECORDS = 3;

/**
 * Which field on a record carries its identity.
 *
 * Never assumed to be called `Id`. Two sources, both derived rather than
 * conventional: the relation graph recorded `parentIdField` when it *proved* a
 * link from this endpoint to something else, and the capability report
 * recorded an `idField` when it worked out that a record could be opened.
 * The first is preferred because a proven link is stronger evidence than an
 * inferred drill-down.
 *
 * Null when neither knows. An API whose records have no reachable identity
 * simply cannot do related lookups, and saying so is better than picking a
 * field that looks like an id and building a wrong URL from it.
 */
export const identityFor = (context: ConciergeContext, op: string): string | null => {
  const proven = context.children.find(
    (child) => child.parentOp === op && child.parentIdField,
  );
  if (proven?.parentIdField) return proven.parentIdField;
  const drillDown = context.drillDowns.find(
    (candidate) => candidate.listOp === op || candidate.detailOp === op,
  );
  return drillDown?.idField ?? null;
};

export const relatedFor = (
  context: ConciergeContext,
  op: string,
): readonly ChildCollection[] => context.children.filter((child) => child.parentOp === op);

/**
 * One thing that can be opened from a record in hand.
 *
 * Deliberately not a `ChildCollection`. A record's own fuller version, a
 * collection attached to it, and another record it points at are three
 * mechanisms serving one decision — "where does what they asked for live?" —
 * and different APIs model the same information as different ones of the
 * three. Notes are a subcollection on one API and a field on the record on the
 * next, so a picker that could only see collections could only ever find half
 * of them.
 */
export interface LookupOption {
  /** Resolved back against the list by the caller. Never approximated. */
  readonly id: string;
  readonly title: string;
  /** What choosing it would get, in plain words. */
  readonly note: string;
}

export const PICK_RELATED_PROMPT = [
  "A record is in hand and something it does not itself contain has been asked for. Choose",
  "which of the things below holds it.",
  "",
  "Answer with one id from the list, or leave it empty when none of them is what was asked",
  "for. An empty answer is a real answer — the reply will say the API does not expose it,",
  "which is more useful than opening the wrong thing and reporting what it happened to",
  "contain.",
].join("\n");

const pickSchema = z.object({
  collection: z
    .string()
    .max(200)
    .default("")
    .describe("Id of the one to open, or empty if none of them fits."),
  reason: z.string().max(300).default(""),
});

const pickTool: LlmTool = {
  name: "pick_related",
  description: "Choose which of these holds what was asked for.",
  schema: pickSchema,
};

export const buildRelatedPrompt = (input: {
  readonly wants: string;
  readonly options: readonly LookupOption[];
}): string =>
  [
    `Wanted: ${input.wants}`,
    "",
    "What can be opened from this record:",
    ...input.options.map(
      (option) => `- ${option.id}: ${option.title}${option.note ? ` — ${option.note}` : ""}`,
    ),
  ].join("\n");

/** Describe a child collection as something that can be opened. */
export const asOption = (child: ChildCollection): LookupOption => ({
  id: child.id,
  title: child.title,
  note:
    (child.resource ? `records of ${child.resource}` : "a collection attached to this record") +
    (child.path ? ` (${child.path})` : ""),
});

/**
 * Which of them holds it, or none of them.
 *
 * Returns the option itself, resolved against the list that was offered — the
 * same boundary every model-chosen id in this codebase is held to, because an
 * approximated id is a request against the wrong endpoint.
 */
export const pickOption = async <T extends LookupOption>(
  llm: LlmAdapter,
  input: { readonly wants: string; readonly options: readonly T[] },
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<T | null> => {
  if (input.options.length === 0) return null;

  try {
    const result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 300,
      messages: [
        { role: "system" as const, content: PICK_RELATED_PROMPT },
        { role: "user" as const, content: buildRelatedPrompt(input) },
      ],
      tools: { pick_related: pickTool },
      toolChoice: { name: "pick_related" as const },
    });
    const call = result.toolCalls.find((candidate) => candidate.name === "pick_related");
    const parsed = call ? pickSchema.safeParse(call.args) : null;
    if (!parsed?.success || !parsed.data.collection) return null;
    return input.options.find((option) => option.id === parsed.data.collection) ?? null;
  } catch {
    return null;
  }
};

export interface RelatedRead {
  readonly evidence: Evidence | null;
  readonly requests: number;
  /** What was read, in words, so the reply can say it happened. */
  readonly note: string;
}

/**
 * Read what is attached to the focused records.
 *
 * Two shapes of relation, and both are ordinary. The API either exposes the
 * collection *under* the record — `/things/{id}/notes`, one request per record
 * — or it exposes one flat collection whose rows carry the parent's id, and
 * the matching is done here. The relation graph works out which; nothing in
 * this file knows what a task or a work order is.
 *
 * The second shape is the cheaper one (a single request however many records
 * are in focus) and the one that can be quietly wrong: a match against a
 * collection the page cap stopped early finds nothing and looks exactly like
 * a record with nothing attached. That is reported rather than smoothed over.
 */
export const readRelated = async (input: {
  readonly focus: Focus;
  readonly child: ChildCollection;
  readonly read: OpReader;
  readonly resolved: Parameters<OpReader>[0]["resolved"];
  readonly rowsOf: (body: unknown, rowsPath: string) => Record<string, unknown>[];
  readonly rowsPath: string;
  readonly limit?: number;
}): Promise<RelatedRead> => {
  const ids = focusIds(input.focus).slice(0, MAX_RELATED_RECORDS);
  if (ids.length === 0) {
    return {
      evidence: null,
      requests: 0,
      note:
        `No identifier was established for these records, so "${input.child.title}" ` +
        "cannot be looked up from them.",
    };
  }

  const limit = input.limit ?? 50;
  const rows: Record<string, unknown>[] = [];
  let requests = 0;
  let failed = 0;
  let truncated = false;
  let refused = "";

  const stamp = (row: Record<string, unknown>, id: string): Record<string, unknown> => ({
    ...row,
    // Which record this belongs to, written in. Without it a set fanned out
    // over three records is one undifferentiated list, and an answer about
    // "the second one" has nothing to attach to.
    [input.focus.idField ?? "record"]: id,
  });

  if (input.child.param) {
    // Under the record: one request each, so the fan-out is what is capped.
    const param = input.child.param;
    for (const id of ids) {
      const outcome = await input.read({
        connection: input.focus.connection,
        op: input.child.op,
        params: { [param]: id },
        resolved: input.resolved,
        cacheOnly: false,
      });
      if (!outcome) {
        failed += 1;
        continue;
      }
      if (!outcome.ok) {
        refused = outcome.reason;
        failed += 1;
        continue;
      }
      requests += outcome.requests;
      if (outcome.truncated) truncated = true;
      for (const row of input.rowsOf(outcome.body, input.rowsPath)) rows.push(stamp(row, id));
    }
  } else if (input.child.linkField) {
    /*
     * One flat collection whose rows point back. Read once, match here — the
     * same thing a record view does for this shape, and the reason it is worth
     * doing rather than refusing: it costs a single request for every record
     * in focus at once.
     */
    const linkField = input.child.linkField;
    const wanted = new Set(ids);
    const outcome = await input.read({
      connection: input.focus.connection,
      op: input.child.op,
      params: {},
      resolved: input.resolved,
      cacheOnly: false,
    });
    if (!outcome) {
      return {
        evidence: null,
        requests: 0,
        note: `"${input.child.title}" could not be read.`,
      };
    }
    if (!outcome.ok) {
      // The API's own words. A 403 says the key works and lacks a scope, which
      // is the one part of this somebody can do something about.
      return {
        evidence: null,
        requests: 0,
        note: `"${input.child.title}" could not be read: ${outcome.reason}`,
      };
    }
    requests += outcome.requests;
    truncated = outcome.truncated;

    for (const row of input.rowsOf(outcome.body, input.rowsPath)) {
      const value = row[linkField];
      if (value === null || value === undefined) continue;
      if (input.child.linkKind === "array") {
        // A list-valued foreign key: `PropertyIds: [42, 51]` never equals an
        // id, so membership is the comparison and it is done as strings.
        if (!Array.isArray(value)) continue;
        const hit = value.map((item) => String(item)).find((item) => wanted.has(item));
        if (hit) rows.push(stamp(row, hit));
        continue;
      }
      const asText = String(value);
      if (wanted.has(asText)) rows.push(stamp(row, asText));
    }
  } else {
    return {
      evidence: null,
      requests: 0,
      note:
        `"${input.child.title}" is recorded as related but neither takes the record's id ` +
        "nor carries it, so there is no way to ask for it.",
    };
  }

  const total = focusIds(input.focus).length;
  const covered =
    ids.length < total
      ? ` for ${ids.length} of the ${total} records in hand`
      : ids.length > 1
        ? ` for all ${ids.length} records in hand`
        : "";

  const warnings: string[] = [];
  if (refused) warnings.push(refused);
  else if (failed > 0) {
    warnings.push(`${failed} of the ${ids.length} records could not be read`);
  }
  if (truncated && rows.length === 0) {
    warnings.push(
      "the collection was cut short by its page cap before anything matched, so this is " +
        "not proof that nothing is attached",
    );
  } else if (truncated) {
    warnings.push("the collection was cut short by its page cap, so there may be more");
  }

  return {
    evidence: {
      candidate: {
        kind: "endpoint",
        id: input.child.op,
        title: input.child.title,
        describes: input.child.resource ? `records of ${input.child.resource}` : "",
        connection: input.focus.connection,
        op: input.child.op,
        fields: [],
        cached: false,
      },
      rows: rows.slice(0, limit),
      columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
      coverage: {
        scanned: Math.min(rows.length, limit),
        of: truncated ? null : rows.length,
        orderedBy: null,
        partial: rows.length > limit || truncated,
      },
      warnings,
      requests,
    },
    requests,
    note:
      `Opened "${input.child.title}"${covered} — ${requests} extra request(s).` +
      (rows.length === 0
        ? truncated
          ? " Nothing matched in the part that was read."
          : " Nothing is attached."
        : ` ${rows.length} record(s) found.`),
  };
};
