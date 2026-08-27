import type { ColumnMeta, ResolvedParams, WidgetShape, WidgetSpec } from "@freebirdai/dash-spec";
import { resolveRange } from "@freebirdai/dash-spec";
import type { Row } from "@freebirdai/dash-runtime";
import { executeWidget } from "@freebirdai/dash-runtime";
import { type InferredShape, inferShape } from "./infer.js";
import type { LlmAdapter } from "./llm.js";
import { mapProposal } from "./map.js";
import { type Proposal, SYSTEM_PROMPT, buildUserPrompt, proposalSchema, proposeWidgetTool } from "./tool.js";

export interface Ambiguity {
  readonly field: string;
  readonly question: string;
  readonly options: readonly string[];
}

export interface ProposalResult {
  readonly ok: boolean;
  readonly widget: WidgetSpec | null;
  /**
   * What the widget measures, as a shape.
   *
   * Carried out of the proposal so the draft can store the same decision the
   * preview was built from — which is what stops "count the rows, bucket them
   * by month" being something that happened once during a conversation and
   * makes it a property of the thing that was built.
   *
   * Named `measurement` rather than `shape` because `shape` below is already
   * the inferred field list.
   */
  readonly measurement: WidgetShape | null;
  /** Rendered against the very sample it was built from, before anything is saved. */
  readonly preview: {
    readonly rows: readonly Row[];
    readonly columns: readonly ColumnMeta[];
    readonly bindingOk: boolean;
    readonly warnings: readonly string[];
  } | null;
  readonly shape: InferredShape;
  readonly ambiguities: readonly Ambiguity[];
  readonly errors: readonly string[];
  /** Whether the model had to be asked a second time. Useful telemetry. */
  readonly repaired: boolean;
}

export interface ProposeInput {
  readonly llm: LlmAdapter;
  /**
   * A real response to build from, and the only thing that can be previewed.
   *
   * Optional because a mapped API can describe an endpoint's fields without
   * anybody having called it. Supply this, or `shape`, or both.
   */
  readonly sample?: unknown;
  /**
   * A field list prepared elsewhere — the API map's, read from the spec.
   *
   * This is what lets a widget be proposed for an endpoint that has never
   * been sampled, which is the whole of "keys and go": what can be built is a
   * property of the API, not of whether this account happens to have rows.
   *
   * Given without a sample there is nothing to render, so the result carries
   * no preview. That is the honest outcome and not a degraded one — a preview
   * drawn from a schema would be a picture of data nobody has seen.
   */
  readonly shape?: InferredShape;
  readonly connection: string;
  readonly connectionTitle: string;
  readonly op: string;
  readonly opTitle: string;
  readonly widgetId?: string;
  readonly intent?: string;
  readonly model?: string;
  readonly now?: number;
  readonly signal?: AbortSignal;
}

/** Anthropic's adapter defaults this to 1024, which silently truncates. */
const MAX_OUTPUT_TOKENS = 4096;

/** Reported when the caller supplied neither a sample nor a shape. */
const EMPTY_SHAPE: InferredShape = { rowsPath: "$", rowCount: 0, schemaHash: "", fields: [] };

const callModel = async (
  input: ProposeInput,
  shape: InferredShape,
  repairErrors: readonly string[],
): Promise<{ proposal: Proposal | null; error: string | null }> => {
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildUserPrompt({
        shape,
        connectionTitle: input.connectionTitle,
        opTitle: input.opTitle,
        intent: input.intent,
      }),
    },
  ];

  if (repairErrors.length > 0) {
    messages.push({
      role: "user" as const,
      content: `That proposal did not validate:\n${repairErrors
        .map((error) => `- ${error}`)
        .join("\n")}\n\nCall propose_widget again, fixing exactly these problems. Use only field names from the schema above.`,
    });
  }

  const result = await input.llm.generate({
    ...(input.model ? { model: input.model } : {}),
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    messages,
    tools: { propose_widget: proposeWidgetTool },
    toolChoice: { name: "propose_widget" },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const call = result.toolCalls.find((candidate) => candidate.name === "propose_widget");
  if (!call) {
    return { proposal: null, error: "the model did not call propose_widget" };
  }
  // Adapters surface a malformed tool payload as a sentinel rather than throwing.
  if (call.args && typeof call.args === "object" && "__parseError" in call.args) {
    return { proposal: null, error: "the model returned malformed tool arguments" };
  }

  const parsed = proposalSchema.safeParse(call.args);
  if (!parsed.success) {
    return {
      proposal: null,
      error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  return { proposal: parsed.data, error: null };
};

/**
 * Propose one widget for a sampled response.
 *
 * Three stages, and the LLM is only the middle one:
 *   1. infer the shape deterministically — no guessing at structure;
 *   2. one forced tool call to say what the fields *mean*;
 *   3. map, validate and run it against the sample, deterministically.
 *
 * Nothing is saved. The caller shows the preview, asks the ambiguity
 * questions, and only then writes the spec — the agent proposing something a
 * human visually confirms is a far better trust model than the agent quietly
 * writing config.
 */
export const proposeWidget = async (input: ProposeInput): Promise<ProposalResult> => {
  const now = input.now ?? Date.now();
  /*
   * A sample is still preferred where there is one: it is evidence, and the
   * shape it produces carries distinct counts and real values that a declared
   * schema cannot. `shape` is the fallback, not the override.
   */
  const sampled = input.sample !== undefined;
  const shape = sampled ? inferShape(input.sample) : input.shape;
  if (!shape) {
    return {
      ok: false,
      widget: null,
      measurement: null,
      preview: null,
      shape: EMPTY_SHAPE,
      ambiguities: [],
      errors: ["nothing to build from — pass a sample or a shape"],
      repaired: false,
    };
  }
  const widgetId = input.widgetId ?? `w_${shape.schemaHash.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;

  const empty = (errors: readonly string[], repaired: boolean): ProposalResult => ({
    ok: false,
    widget: null,
    measurement: null,
    preview: null,
    shape,
    ambiguities: [],
    errors,
    repaired,
  });

  let repaired = false;
  let attempt = await callModel(input, shape, []);
  if (!attempt.proposal) {
    repaired = true;
    attempt = await callModel(input, shape, [attempt.error ?? "unknown error"]);
    if (!attempt.proposal) return empty([attempt.error ?? "the model could not produce a proposal"], true);
  }

  let mapped = mapProposal({
    proposal: attempt.proposal,
    shape,
    connection: input.connection,
    op: input.op,
    widgetId,
  });

  // Exactly one repair round trip. A model that cannot fix a validation error
  // it was handed verbatim will not fix it on the third try either.
  if (!mapped.widget && !repaired) {
    repaired = true;
    const retry = await callModel(input, shape, mapped.errors);
    if (retry.proposal) {
      mapped = mapProposal({
        proposal: retry.proposal,
        shape,
        connection: input.connection,
        op: input.op,
        widgetId,
      });
    }
  }

  if (!mapped.widget) return empty(mapped.errors, repaired);

  /*
   * Built from a schema alone: valid, unrendered, and saying so.
   *
   * `ok` is true because the proposal itself is sound — it validated and its
   * bindings resolve against the declared fields. What has not happened is a
   * render, and `preview: null` is how the caller knows to fetch before
   * showing anything rather than displaying an empty table as a result.
   */
  if (!sampled) {
    return {
      ok: true,
      widget: mapped.widget,
      measurement: mapped.measurement,
      preview: null,
      shape,
      ambiguities: mapped.ambiguities,
      errors: [],
      repaired,
    };
  }

  const params: ResolvedParams = {
    range: resolveRange({ preset: "30d", now }),
    filters: {},
  };
  const executed = executeWidget(mapped.widget, input.sample, { now, params });

  return {
    ok: executed.ok,
    widget: mapped.widget,
    measurement: mapped.measurement,
    preview: {
      rows: executed.rows,
      columns: executed.columns,
      bindingOk: executed.ok,
      warnings: [
        ...(executed.meta?.warnings ?? []),
        ...(executed.binding?.warnings ?? []).map((issue) => issue.message),
      ],
    },
    shape,
    ambiguities: mapped.ambiguities,
    errors: [
      ...executed.errors,
      ...(executed.binding?.errors ?? []).map((issue) => issue.message),
    ],
    repaired,
  };
};
