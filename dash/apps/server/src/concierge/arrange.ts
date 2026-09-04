import type {
  Arrangement,
  ConciergeContext,
  ConciergeDraft,
  InferredShape,
  LlmAdapter,
} from "@freebirdai/dash-agent";
import {
  applyArrangement,
  fieldPool,
  partView,
  partsOf,
  preferredForRole,
  proposeWidget,
  withPart,
} from "@freebirdai/dash-agent";
import { contractFor } from "@freebirdai/dash-spec";

/**
 * Changing how several widgets are shown together, and re-reading the fields
 * when that changes what a widget is.
 *
 * Two halves, split along the line this codebase always splits on. The pure
 * half — moving parts into the right shape — lives in the agent. This is the
 * half that needs a model, and it needs one for a specific reason: a swap can
 * change what a widget *is*, not just how it looks. A pair of tables becoming
 * one list needs somebody to say which field is the title, and the answer is
 * in the records rather than in any schema.
 *
 * The frames are the common case and cost nothing. Tabs, a row and a stack
 * change no widget at all — the same endpoints, the same bindings, the same
 * requests — so they never reach a model and swap instantly.
 */

export interface RearrangeInput {
  readonly llm?: LlmAdapter | undefined;
  readonly draft: ConciergeDraft;
  readonly context: ConciergeContext;
  readonly arrangement: Arrangement;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RearrangeResult {
  readonly draft: ConciergeDraft;
  /** Why this is thinner than it should be. Never thrown, always reported. */
  readonly notes: readonly string[];
  readonly error?: string;
}

/** Arrangements that change nothing about any widget. */
const FRAMES = new Set<Arrangement>(["tabs", "row", "stack"]);

const INTERLEAVABLE = new Set(["list", "feed", "cards", "timeline"]);

/**
 * The joined rows, as something a binding call can read.
 *
 * `fieldPool` already knows what columns a join produces — including the right
 * side's, prefixed — so this is that list wearing the shape the model's prompt
 * expects. Synthesised rather than fetched: the columns are known statically
 * and re-reading the API to describe them would spend a request to learn
 * something already in hand.
 */
const joinedShape = (
  draft: ConciergeDraft,
  context: ConciergeContext,
  index: number,
): InferredShape => {
  const view = partView(draft, index);
  return {
    rowsPath: view.rowsPath || "$",
    rowCount: 0,
    schemaHash: context.shapes[view.op ?? ""]?.schemaHash ?? "",
    fields: [...fieldPool(view, context)],
  };
};

/**
 * Fill any role the model left unbound, from the fields that are there.
 *
 * The model is asked for a list and usually gives one, but it is asked in its
 * own words and may answer with a component whose roles do not fit — and a
 * list with no title does not build. Falling back to `preferredForRole` is the
 * same ranking the wizard's own questions recommend, so the result is a
 * binding somebody could have chosen rather than a guess of a different kind.
 */
const filled = (
  roles: Record<string, readonly string[]>,
  component: string,
  draft: ConciergeDraft,
  context: ConciergeContext,
  index: number,
): Record<string, readonly string[]> => {
  const contract = contractFor(component);
  if (!contract) return roles;
  const pool = fieldPool(partView(draft, index), context);
  const next: Record<string, readonly string[]> = { ...roles };

  for (const role of contract.roles) {
    if (role.multi === true) continue;
    if ((next[role.role]?.length ?? 0) > 0) continue;
    if (!role.required) continue;
    const pick = preferredForRole(role, pool);
    if (pick) next[role.role] = [pick.name];
  }
  return next;
};

export const rearrangeSetup = async (input: RearrangeInput): Promise<RearrangeResult> => {
  const { context, arrangement } = input;

  const reshaped = applyArrangement(input.draft, arrangement, context);
  if (reshaped.error) return { draft: input.draft, notes: [], error: reshaped.error };
  let draft = reshaped.draft;

  /*
   * A frame is free. Nothing about any widget changed — same endpoints, same
   * bindings, same requests — so there is nothing to re-read and no reason to
   * spend a call or make somebody wait for one.
   */
  if (FRAMES.has(arrangement)) return { draft, notes: [] };

  const notes: string[] = [];
  if (!input.llm) {
    /*
     * No model configured. The reshape still stands and the build will fill
     * the roles deterministically — worse bindings, and a working widget,
     * which is the right side of that trade to land on.
     */
    return {
      draft,
      notes: ["no model is configured, so the fields for this were chosen by convention"],
    };
  }

  const parts = partsOf(draft);
  const proposals = await Promise.all(
    parts.map(async (part, index) => {
      const op = part.op;
      if (!op) return null;
      const shape = arrangement === "merged" ? joinedShape(draft, context, index) : context.shapes[op];
      if (!shape || shape.fields.length === 0) return null;

      const known = context.ops.find((candidate) => candidate.id === op);
      const connection = context.connections.find(
        (candidate) => candidate.id === (part.connection ?? known?.connection),
      );
      return proposeWidget({
        llm: input.llm!,
        shape,
        connection: part.connection ?? known?.connection ?? "",
        connectionTitle: connection?.title ?? part.connection ?? "",
        op,
        opTitle: known?.title ?? op,
        intent:
          arrangement === "merged"
            ? `${draft.intent ?? ""} — these two sets of records have been joined into one row ` +
              "each; choose columns from both sides"
            : `${draft.intent ?? ""} — shown as one list beside other kinds of record, so pick ` +
              "a list-shaped view and say which field is the title",
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }),
  );

  /*
   * Every part of a list has to share one component, because they share one
   * dataset. Taken from the first proposal that named a list-shaped one, so
   * the model's judgement is used where it applies and overridden only when
   * it answered with something that cannot hold two kinds of record.
   */
  const component =
    arrangement === "merged"
      ? (proposals[0]?.widget?.component ?? parts[0]?.component)
      : (proposals.map((entry) => entry?.widget?.component).find(
          (id): id is string => id !== undefined && INTERLEAVABLE.has(id),
        ) ?? "list");

  parts.forEach((_, index) => {
    const proposal = proposals[index];
    const roles = Object.fromEntries(
      Object.entries(proposal?.widget?.roles ?? {}).map(([role, bound]) => [
        role,
        Array.isArray(bound) ? bound.map(String) : [String(bound)],
      ]),
    );
    if (!proposal?.widget) {
      notes.push(
        `${parts[index]?.title ?? parts[index]?.op ?? "one widget"} could not be re-read for ` +
          "this arrangement, so its fields were chosen by convention",
      );
    }
    draft = withPart(draft, index, {
      ...partView(draft, index),
      ...(component ? { component } : {}),
      roles: Object.fromEntries(
        Object.entries(filled(roles, component ?? "list", draft, context, index)).map(
          ([role, bound]) => [role, [...bound]],
        ),
      ),
    });
  });

  return { draft, notes };
};
