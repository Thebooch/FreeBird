import { pathSegments, singularNoun } from "@freebirdai/dash-spec";
import { fieldsForRole } from "../bind.js";
import type { InferredShape } from "../infer.js";
import type { ConciergeDraft } from "./draft.js";
import { isRoleStep, partView, partsOf, withPart } from "./draft.js";
import { fieldPool, type ConciergeContext } from "./steps.js";
import { contractFor } from "@freebirdai/dash-spec";

/**
 * The ways several endpoints can be shown together, and which of them would
 * actually work.
 *
 * Every arrangement here already exists as a mechanism — a join merges rows, a
 * union interleaves them, a layout group frames separate widgets. What was
 * missing was anything that could say *which are possible for this particular
 * pair* and put them side by side as a choice. Offering one that cannot be
 * built is the failure this whole area started with: a widget confidently
 * described as showing two things while showing one.
 *
 * Pure, and deliberately: what is feasible is a fact about the endpoints, not
 * a judgement. The model picks among what this returns and never adds to it.
 */

export type Arrangement = "tabs" | "row" | "stack" | "list" | "merged";

export interface ArrangementOption {
  readonly id: Arrangement;
  readonly label: string;
  /** What choosing it means, in shape terms rather than domain terms. */
  readonly description: string;
  /** True of the one the setup is currently built as. */
  readonly applied: boolean;
  /**
   * Requests this costs beyond what the setup already spends.
   *
   * Stated on the option rather than discovered afterwards, the same rule
   * `joinOptions` follows. Every arrangement but a merge reads exactly the
   * same endpoints, so the honest answer for those is zero.
   */
  readonly extraRequests: number;
}

/** `UnitId` and the like, normalised for comparison. */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The field on each side that carries the same value, by name alone.
 *
 * Ported from the server's proposal path so the picker and the proposal agree
 * about what can be joined. They were about to disagree: the proposal falls
 * back to this convention when the map is silent, so a merge it would happily
 * build was one the picker — reading only the map — would have refused to
 * offer.
 *
 * Deliberately narrow. It looks for one convention — a field named for the
 * other endpoint's records plus an id suffix, matched against that endpoint's
 * own identity field — and reports nothing when it does not hold, rather than
 * reaching for the next most plausible pair.
 */
export const pairFields = (
  left: InferredShape | undefined,
  right: InferredShape | undefined,
  rightPath: string,
): { leftField: string; rightField: string } | null => {
  if (!left || !right) return null;

  const noun = key(singularNoun(pathSegments(rightPath).pop() ?? ""));
  if (!noun) return null;

  const leftField = left.fields.find(
    (field) => !field.name.includes(".") && key(field.name) === `${noun}id`,
  );
  if (!leftField) return null;

  const rightField =
    right.fields.find((field) => key(field.name) === "id") ??
    right.fields.find((field) => key(field.name) === `${noun}id`);
  if (!rightField) return null;

  return { leftField: leftField.name, rightField: rightField.name };
};

export interface JoinPairing {
  readonly leftField: string;
  readonly rightField: string;
  /** True when the map declared it, false when the field names implied it. */
  readonly declared: boolean;
  /** One request for the whole set, or one per row. */
  readonly perRow: boolean;
  readonly maxRows: number;
}

/**
 * How two endpoints could be joined, if they could.
 *
 * The map first, because a declared relation was proved rather than guessed.
 * The naming convention second, and only because both endpoints are already
 * pinned by this point — there is no second candidate to be wrong about, which
 * is the exact reasoning the proposal path uses to justify the same fallback.
 */
export const pairEndpoints = (
  context: ConciergeContext,
  leftOp: string,
  rightOp: string,
): JoinPairing | null => {
  const declared = context.joins.find(
    (join) => join.fromOp === leftOp && join.toOp === rightOp,
  );
  if (declared) {
    return {
      leftField: declared.leftField,
      rightField: declared.rightField,
      declared: true,
      perRow: declared.fetch.mode !== "filtered",
      maxRows: declared.fetch.mode === "filtered" ? 1 : (declared.fetch.maxRows ?? 25),
    };
  }

  const right = context.ops.find((op) => op.id === rightOp);
  const paired = pairFields(
    context.shapes[leftOp],
    context.shapes[rightOp],
    right?.path ?? rightOp,
  );
  if (!paired) return null;
  // A pair found by name is fetched whole and matched in memory: fanning out
  // on a guess would spend one request per row to test a hunch.
  return { ...paired, declared: false, perRow: false, maxRows: 1 };
};

/** Components whose roles are few enough to align two endpoints onto. */
const INTERLEAVABLE = ["list", "feed", "cards", "timeline"] as const;

/**
 * Whether every part could fill a shared list's required roles.
 *
 * Asks the contract rather than the parts' current bindings, because the
 * arrangement is what would *change* those bindings — a pair currently drawn
 * as two tables can still become one list, and refusing on the grounds that
 * neither has a `title` bound yet would hide the arrangement for the only
 * reason it is being offered.
 */
const canInterleave = (draft: ConciergeDraft, context: ConciergeContext): boolean => {
  const contract = contractFor(INTERLEAVABLE[0]);
  if (!contract) return false;
  const required = contract.roles.filter((role) => role.required && role.multi !== true);

  return partsOf(draft).every((_, index) => {
    const pool = fieldPool(partView(draft, index), context);
    return required.every((role) => fieldsForRole(role, pool).length > 0);
  });
};

/**
 * Every arrangement worth offering for this setup, with what it costs.
 *
 * Empty for a setup of one widget: there is nothing to arrange, and a picker
 * that appeared on every build would be the endpoint list this whole flow
 * exists to replace.
 */
export const feasibleArrangements = (
  draft: ConciergeDraft,
  context: ConciergeContext,
): readonly ArrangementOption[] => {
  const parts = partsOf(draft);
  if (parts.length < 2) return [];

  const display = draft.group?.display ?? "tabs";
  const interleaved = draft.interleave === true;

  const options: ArrangementOption[] = [
    {
      id: "tabs",
      label: "Tabs",
      description: "One at a time, behind a strip. Both are read either way.",
      applied: !interleaved && display === "tabs",
      extraRequests: 0,
    },
    {
      id: "row",
      label: "Side by side",
      description: "Both at once, in one frame. Narrow screens stack them.",
      applied: !interleaved && display === "row",
      extraRequests: 0,
    },
    {
      id: "stack",
      label: "Stacked",
      description: "One above the other, in one frame.",
      applied: !interleaved && display === "stack",
      extraRequests: 0,
    },
  ];

  if (canInterleave(draft, context)) {
    options.push({
      id: "list",
      label: "One list",
      description:
        "Every record in one list, each row badged with where it came from. Only the " +
        "fields all of them have are drawn.",
      applied: interleaved,
      extraRequests: 0,
    });
  }

  /*
   * A merge is only offered for two endpoints that really carry each other's
   * identity, and only for exactly two — three sets of rows joined on one key
   * is a question about the data that nobody asked.
   */
  const primary = parts[0]?.op;
  const second = parts[1]?.op;
  if (parts.length === 2 && primary && second) {
    const pairing = pairEndpoints(context, primary, second);
    if (pairing) {
      options.push({
        id: "merged",
        label: "Merged rows",
        description: pairing.declared
          ? `Matched on ${pairing.leftField}, which the API map says links them.`
          : `Matched on ${pairing.leftField} = ${pairing.rightField}, from the field names. ` +
            "Check the row count — if few matched, they may not line up.",
        applied: !interleaved && draft.parts.length <= 1 && parts[0]?.join !== undefined,
        /*
         * A filtered join reads the second endpoint once, which the two-widget
         * arrangement was already doing — so it costs nothing more. A per-row
         * join is the one arrangement that does, and says so.
         */
        extraRequests: pairing.perRow ? pairing.maxRows - 1 : 0,
      });
    }
  }

  return options;
};

/**
 * Reshape a draft into a chosen arrangement.
 *
 * The deterministic half. It moves the parts into the right shape — a merge
 * collapses two into one joined part, a list sets the flag, a frame sets its
 * display — and deliberately does *not* re-bind anything: which field becomes
 * the list's title, or which of the joined columns are worth showing, is a
 * judgement about the data that the caller makes with a model in hand.
 *
 * Separated for the usual reason: this is pure and testable, and the part that
 * needs a model is the part that cannot be.
 */
export const applyArrangement = (
  draft: ConciergeDraft,
  arrangement: Arrangement,
  context: ConciergeContext,
): { draft: ConciergeDraft; error?: string } => {
  const parts = partsOf(draft);
  if (parts.length < 2) return { draft, error: "there is only one widget to arrange" };

  if (arrangement === "tabs" || arrangement === "row" || arrangement === "stack") {
    return {
      draft: {
        ...draft,
        interleave: false,
        group: {
          title: draft.group?.title ?? parts.map((part) => part.title ?? part.op ?? "").join(" and "),
          display: arrangement,
        },
      },
    };
  }

  if (arrangement === "list") {
    if (!canInterleave(draft, context)) {
      return { draft, error: "these endpoints have nothing in common to list them by" };
    }
    /*
     * The component has to become one that can hold two kinds of record. Left
     * on `table`, the build refuses — correctly, and confusingly, since the
     * arrangement the user just picked is the thing that made it wrong.
     */
    const listed = parts.reduce<ConciergeDraft>(
      (carried, part, index) =>
        INTERLEAVABLE.includes((part.component ?? "") as (typeof INTERLEAVABLE)[number])
          ? carried
          : withPart(carried, index, {
              ...partView(carried, index),
              component: "list",
              // Bindings for the old component name columns this one does not
              // have. Cleared so the re-bind has a clean slate rather than a
              // half-translated one.
              roles: {},
              answered: partView(carried, index).answered.filter(
                (id) => !isRoleStep(id) && id !== "component",
              ),
            }),
      draft,
    );
    return { draft: { ...listed, interleave: true } };
  }

  // A merge: two parts become one, joined.
  if (parts.length !== 2) {
    return { draft, error: "only two sets of records can be merged into one" };
  }
  const primary = parts[0]?.op;
  const second = parts[1]?.op;
  if (!primary || !second) return { draft, error: "both widgets need an endpoint first" };

  const pairing = pairEndpoints(context, primary, second);
  if (!pairing) {
    return { draft, error: `nothing on ${primary} carries ${second}'s identity, so they cannot be merged` };
  }

  const merged: ConciergeDraft = {
    ...withPart(draft, 0, {
      ...partView(draft, 0),
      join: {
        op: second,
        rowsPath: context.shapes[second]?.rowsPath ?? "$",
        leftField: pairing.leftField,
        rightField: pairing.rightField,
        kind: "left",
        needsFanOut: pairing.perRow,
        maxRows: pairing.maxRows,
      },
      /*
       * The pool is about to gain the second endpoint's columns, so anything
       * bound against the old one is stale — the same reasoning `applyOpenJoin`
       * follows, and the same clearing.
       */
      roles: {},
      answered: partView(draft, 0).answered.filter(
        (id) => !isRoleStep(id) && id !== "component",
      ),
    }),
    interleave: false,
    group: undefined,
  };

  // One widget now, so the second part is not merely unused — it is gone.
  return { draft: { ...merged, parts: [partsOf(merged)[0]!] } };
};
