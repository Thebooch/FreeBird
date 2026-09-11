import { proposalPatch } from "./proposal-patch.js";
import type {
  ConciergeContext,
  DraftPatch,
  InferredShape,
  LlmAdapter,
  PickCandidate,
} from "@freebirdai/dash-agent";
import { pickEndpoints, proposeWidget } from "@freebirdai/dash-agent";
import type { WidgetShape } from "@freebirdai/dash-spec";
import { inferIdField, pathSegments, singularNoun } from "@freebirdai/dash-spec";

/**
 * Turning a sentence into a proposed widget, with the model called twice.
 *
 * Both calls happen here, on the server, and that is forced rather than
 * chosen. FreeBird's `ChatEngine` runs an inner loop that exits the moment a
 * step produces prose, and from the first step injects a hint telling the
 * model to answer in text rather than emit another tool call — so a design
 * needing "pick, then bind" as two chat turns cannot work. It was tried: the
 * model called `start_setup` and stopped.
 *
 * Splitting the work rather than merging it is what keeps the prompt small.
 * Call A sees every endpoint and no fields; call B sees every field of the one
 * or two endpoints A chose. Neither input grows with the size of the API in
 * the way a combined one would, and the shared chat prompt — paid for on every
 * turn, including the turns that have nothing to do with widgets — carries
 * neither.
 */

export interface ProposeSetupInput {
  readonly llm: LlmAdapter;
  readonly intent: string;
  readonly context: ConciergeContext;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ProposedSetup {
  /** What to apply to a fresh draft. Empty when nothing could be proposed. */
  readonly patch: DraftPatch;
  /** The model's sentence about what it picked, for the user to read. */
  readonly reason: string;
  /** Why this is thinner than it should be. Never thrown, always reported. */
  readonly notes: readonly string[];
  /**
   * What the model was unsure of, in its own words.
   *
   * These were produced and discarded, which turned out to be the most
   * expensive line in this file. Asked for listings-per-month against
   * applications-per-month, the binding call answered: "the API response
   * contains listings but no application count data — do you have access to
   * application data from a different endpoint?" That is the correct
   * diagnosis, arrived at unprompted, and it went nowhere. The card then
   * derived its own question about which field to plot, so the user was asked
   * to choose between rent and deposit for a widget that was never going to
   * answer what they asked.
   *
   * A doubt the model states is worth more than any question derived from the
   * schema, because it is about the request rather than about the data.
   */
  readonly ambiguities: readonly {
    readonly field: string;
    readonly question: string;
    readonly options: readonly string[];
  }[];
}

const EMPTY: ProposedSetup = { patch: {}, reason: "", notes: [], ambiguities: [] };

/** `UnitId` and the like, normalised for comparison. */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The field on each side that carries the same value, by name alone.
 *
 * Deliberately narrow. It looks for one convention — a field named for the
 * other endpoint's records plus an id suffix, matched against that endpoint's
 * own identity field — and reports nothing when it does not hold, rather than
 * reaching for the next most plausible pair. A join nobody asked for that
 * quietly matches on the wrong column is the failure worth avoiding; being
 * told no link was found is recoverable in one sentence.
 */
const pairFields = (
  left: InferredShape,
  right: InferredShape | undefined,
  rightPath: string,
): { leftField: string; rightField: string } | null => {
  if (!right) return null;

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

const proposeSingle = async (input: ProposeSetupInput): Promise<ProposedSetup> => {
  const { context } = input;

  /*
   * Only endpoints something can actually be built from.
   *
   * A field list is the bar, and it is now usually met by the API map rather
   * than by this account having been sampled — which is the point of the map:
   * what can be built is a property of the API, not of whether these
   * particular credentials have rows today.
   */
  const candidates: PickCandidate[] = context.ops
    .filter((op) => (context.shapes[op.id]?.fields.length ?? 0) > 0)
    .map((op) => ({
      id: op.id,
      title: op.title,
      path: op.path ?? "",
      ...(op.resource ? { resource: op.resource } : {}),
      ...(op.description ? { description: op.description } : {}),
    }));

  /*
   * The collections that only exist under a parent record.
   *
   * These are excluded from `context.ops` for a good reason — nobody has an id
   * yet, so they cannot be a widget's starting point — and that exclusion was
   * silently deciding they could never appear in a widget at all. Asked to
   * compare listings against applications, the only endpoint listing
   * applications needs an applicant's id, so it was not a candidate and the
   * request was answered from listings alone.
   *
   * They are reachable: once per parent record, capped. Offered here so the
   * model can name one, and priced before anything is fetched — the cost is
   * stated in the candidate's own description so the choice is informed rather
   * than discovered afterwards.
   */
  const expandable = new Map<string, { child: (typeof context.children)[number]; field: string }>();
  for (const child of context.children) {
    if (expandable.has(child.op)) continue;
    if ((context.shapes[child.op]?.fields.length ?? 0) === 0) continue;
    if (!child.param) continue;
    // The parent has to be readable on its own, or there is nothing to drive
    // the expansion with.
    if ((context.shapes[child.parentOp]?.fields.length ?? 0) === 0) continue;
    /*
     * The parent's identity field, which is what fills the child's parameter.
     *
     * The relation graph knows it — it worked it out when it proved the link —
     * so that is the first source. A recorded drill-down is the second, and
     * `inferIdField` the third: requiring any one of them would make reaching a
     * nested collection depend on whether some *other* feature happened to be
     * derived for its parent.
     */
    const parentShape = context.shapes[child.parentOp];
    const identity =
      child.parentIdField ??
      context.drillDowns.find((offer) => offer.listOp === child.parentOp)?.idField ??
      inferIdField(
        parentShape?.fields.map((field) => ({ name: field.name, kinds: field.kinds })),
        [
          singularNoun(
            pathSegments(context.ops.find((op) => op.id === child.parentOp)?.path ?? "").pop() ??
              "",
          ),
        ],
      );
    if (!identity) continue;

    expandable.set(child.op, { child, field: identity });
    /*
     * Shown exactly like a bare endpoint: id, path, and one line saying what
     * the records are.
     *
     * It used to carry an empty path and a description that led with the
     * price, in an index where the prompt tells the model the path
     * disambiguates. That reads as a lesser entry, and a model reading it that
     * way substitutes something cheaper and adjacent — counting the parents of
     * a thing rather than the thing. The cost is real, and it is put to the
     * *user* before anything is fetched; it is not the model's to weigh, and
     * the description is truncated in the index anyway.
     */
    candidates.push({
      id: child.op,
      title: child.title,
      path: child.path ?? "",
      ...(child.resource ? { resource: child.resource } : {}),
      description: `${child.title} — the records themselves, one set per parent record.`,
    });
  }

  if (candidates.length === 0) return EMPTY;

  let picked = await pickEndpoints(
    input.llm,
    { intent: input.intent, candidates },
    {
      ...(input.model ? { model: input.model } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!picked.primary) return { ...EMPTY, notes: picked.error ? [picked.error] : [] };
  if (picked.alternatives.some((entry) => entry.role === "secondary"))
    picked = { ...picked, relationship: "alongside" };
  const primaryOwner = context.ops.find((op) => op.id === picked.primary)?.connection;
  const secondaryOwner = context.ops.find((op) => op.id === picked.secondary)?.connection;
  if (primaryOwner && secondaryOwner && primaryOwner !== secondaryOwner)
    picked = { ...picked, relationship: "alongside" };

  const op = context.ops.find((candidate) => candidate.id === picked.primary);
  const shape = context.shapes[picked.primary!];
  if (!op || !shape) return { ...EMPTY, reason: picked.reason };

  const connection = context.connections.find((candidate) => candidate.id === op.connection);

  const proposal = await proposeWidget({
    llm: input.llm,
    shape,
    connection: op.connection,
    connectionTitle: connection?.title ?? op.connection,
    op: op.id,
    opTitle: op.title,
    opDescription: op.description,
    intent: input.intent,
    ...(input.model ? { model: input.model } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const notes: string[] = [];
  const ambiguities = proposal.ambiguities.map((entry) => ({
    ...entry,
    field: `${op.title}: ${entry.field}`,
  }));
  const patch: {
    connection: string;
    endpoint: string;
    model?: string;
    component?: string;
    roles?: Record<string, readonly string[]>;
    shape?: WidgetShape;
    title?: string;
    joinWith?: { endpoint: string; leftField: string; rightField: string };
    seriesWith?: Array<{
      coercions?: DraftPatch["coercions"];
      format?: DraftPatch["format"];
      inputs?: DraftPatch["inputs"];
      endpoint: string;
      label: string;
      shape: WidgetShape;
    }>;
    offerSeries?: {
      coercions?: DraftPatch["coercions"];
      format?: DraftPatch["format"];
      inputs?: DraftPatch["inputs"];
      endpoint: string;
      label: string;
      shape: WidgetShape;
      fanOut: { from: string; field: string; as?: string; maxRows?: number };
    };
    parts?: Array<{
      choiceBetween?: DraftPatch["choiceBetween"];
      connection: string;
      endpoint: string;
      component?: string;
      title?: string;
      roles?: Record<string, readonly string[]>;
      shape?: WidgetShape;
    }>;
    group?: { title: string; display: "tabs" | "row" | "stack" };
    choiceBetween?: {
      role: "primary" | "secondary";
      options: Array<{
        op: string;
        label: string;
        whatItIs: string;
        series?: {
          op: string;
          rowsPath: string;
          label: string;
          shape: WidgetShape;
          fanOut?: { from: string; field: string; as?: string; maxRows: number };
        };
      }>;
    };
  } = { connection: op.connection, endpoint: op.id };

  if (proposal.widget) {
    Object.assign(patch, proposalPatch(proposal));
  } else {
    /*
     * The endpoint survives a failed binding, and should.
     *
     * Half a proposal puts the user on a card showing the right records with
     * the view still to choose, which is a far better place to be than back at
     * an empty prompt — and every remaining decision already has a control.
     */
    notes.push(...proposal.errors);
  }

  /*
   * A second endpoint becomes a join: from the map where it knows, and from
   * the field names where it does not.
   *
   * The falling back is the point, and it is not a relaxation of the rule the
   * mapping pass follows. That pass refuses a contested link because the map
   * is *shared* — one guess there is everybody's guess, forever, and nothing
   * downstream can tell it was a guess. Here both endpoints have already been
   * named for this one request, so nothing is being chosen between: not which
   * units collection, only which field on each side carries the same value.
   * The user sees the result in a preview with the number of rows that
   * actually matched, and nothing is written to the shared artifact.
   *
   * Without this, "show each lease alongside its unit" became unanswerable the
   * moment the map stopped claiming to know how leases and units relate —
   * which is a true thing for the map to stop claiming and a useless place to
   * leave the person asking.
   */
  /*
   * Two things somebody wants to see together, built as two widgets.
   *
   * "All my properties and also my available listings" used to arrive here as
   * "enrich", because that was the only word available for it — so a join was
   * attempted, found nothing to match on, degraded to the properties alone,
   * and the reply announced the listings anyway.
   *
   * They are not one dataset and forcing them into one was the original sin.
   * They are two: two endpoints, two bindings, two caches, drawn inside one
   * frame. So the second endpoint gets its own binding call — it has its own
   * fields and its own idea of what a good view of them is, and reusing the
   * first's answer would bind the listings to the properties' columns.
   *
   * The frame is recorded, not built. Widgets do not exist until confirm, and
   * there is nothing to group before then.
   */
  if (picked.secondary && picked.relationship === "alongside") {
    const other = context.ops.find((candidate) => candidate.id === picked.secondary);
    const otherShape = context.shapes[picked.secondary];
    const otherConnection = other
      ? context.connections.find((candidate) => candidate.id === other.connection)
      : undefined;

    if (other && otherShape && otherShape.fields.length > 0) {
      const second = await proposeWidget({
        llm: input.llm,
        shape: otherShape,
        connection: other.connection,
        connectionTitle: otherConnection?.title ?? other.connection,
        op: other.id,
        opTitle: other.title,
        opDescription: other.description,
        intent: input.intent,
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (second.widget) {
        patch.parts = [
          { ...proposalPatch(second), connection: other.connection, endpoint: other.id },
        ];
        ambiguities.push(
          ...second.ambiguities.map((entry) => ({
            ...entry,
            field: `${other.title}: ${entry.field}`,
          })),
        );

        /*
         * Named from the two widgets' own titles, which the model wrote for a
         * person to read. Building it from the endpoint titles instead would
         * put "Retrieve all properties and Retrieve all listings" above the
         * frame, which is the API's vocabulary rather than anybody's.
         */
        const first = proposal.widget?.title ?? op.title;
        patch.group = {
          title: `${first} and ${second.widget.title}`.slice(0, 120),
          display: "tabs",
        };
      } else {
        notes.push(
          `${other.title} could not be bound to a view, so this is built from ${op.title} ` +
            `alone: ${second.errors.join("; ")}`,
        );
      }
    } else {
      notes.push(
        `${op.title} and ${other?.title ?? picked.secondary} are two separate sets of records, ` +
          `but nothing has been read from ${other?.title ?? "the second endpoint"} — so there ` +
          `are no fields to build it from and this is ${op.title} alone.`,
      );
    }
  } else if (picked.secondary && picked.relationship === "compare") {
    const nested = expandable.get(picked.secondary);
    const other =
      context.ops.find((candidate) => candidate.id === picked.secondary) ??
      (nested ? { id: nested.child.op, title: nested.child.title } : undefined);
    const rightShape = context.shapes[picked.secondary];
    if (other && rightShape) {
      const second = await proposeWidget({
        llm: input.llm,
        shape: rightShape,
        connection: op.connection,
        connectionTitle: connection?.title ?? op.connection,
        op: other.id,
        opTitle: other.title,
        intent: input.intent,
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const secondPatch = proposalPatch(second);
      ambiguities.push(
        ...second.ambiguities.map((entry) => ({
          ...entry,
          field: other.title + ": " + entry.field,
        })),
      );
      const left = patch.shape;
      const right = secondPatch.shape;
      const firstFormat = proposal.widget?.format[left?.measures[0]?.as ?? ""];
      const secondFormat = second.widget?.format[right?.measures[0]?.as ?? ""];
      const knownUnit =
        left?.measures[0]?.agg === "count" ||
        (firstFormat &&
          (firstFormat.unit ||
            (firstFormat.semantic === "currency" && firstFormat.currency) ||
            ["percent", "bytes", "duration"].includes(firstFormat.semantic)));
      const compatible =
        knownUnit &&
        left &&
        right &&
        left.groupBy.length === 1 &&
        right.groupBy.length === 1 &&
        left.measures.length === 1 &&
        right.measures.length === 1 &&
        left.groupBy[0]?.bucket === right.groupBy[0]?.bucket &&
        left.measures[0]?.agg === right.measures[0]?.agg &&
        JSON.stringify(firstFormat) === JSON.stringify(secondFormat);
      if (compatible) {
        if (nested)
          patch.offerSeries = {
            coercions: secondPatch.coercions,
            format: secondPatch.format,
            inputs: secondPatch.inputs,
            endpoint: picked.secondary,
            label: other.title,
            shape: right,
            fanOut: {
              from: nested.child.parentOp,
              field: nested.field,
              ...(nested.child.param ? { as: nested.child.param } : {}),
            },
          };
        else
          patch.seriesWith = [
            {
              endpoint: picked.secondary,
              label: other.title,
              shape: right,
              coercions: secondPatch.coercions,
              format: secondPatch.format,
              inputs: secondPatch.inputs,
            },
          ];
        delete patch.roles;
      } else if (second.widget && !nested) {
        patch.parts = [{ ...secondPatch, connection: op.connection, endpoint: other.id }];
        patch.group = { title: (op.title + " and " + other.title).slice(0, 120), display: "row" };
        notes.push(
          "These measurements keep their own units and transformations in separate views. A shared axis has not been established.",
        );
      } else {
        notes.push(
          ...second.errors,
          "The second measurement needs a compatible grouping and unit before it can be combined.",
        );
      }
    } else notes.push("The second endpoint has no field evidence to plan a comparison.");
  } else if (picked.secondary) {
    const relation = context.joins.find(
      (join) =>
        (join.fromOp === picked.primary && join.toOp === picked.secondary) ||
        (join.fromOp === picked.secondary && join.toOp === picked.primary),
    );
    if (relation && relation.fromOp === picked.primary) {
      patch.joinWith = {
        endpoint: relation.toOp,
        leftField: relation.leftField,
        rightField: relation.rightField,
      };
    } else {
      const other = context.ops.find((candidate) => candidate.id === picked.secondary);

      /*
       * The near miss is worth naming, because it is usually a real one.
       *
       * APIs reuse titles — Buildium has two endpoints called "Retrieve all
       * units", one under /v1/rentals and one under /v1/associations — and the
       * relation detector matches a foreign key against a *resource*, so with
       * two equally-named candidates it can record the link against the wrong
       * one. Joining anyway would silently pair leases with unrelated records,
       * so this refuses; saying only "nothing relates them" would then be
       * confusing to somebody who can see a relation in the map.
       */
      const sameName = context.joins.find(
        (join) =>
          join.fromOp === picked.primary &&
          join.toOp !== picked.secondary &&
          context.ops.find((candidate) => candidate.id === join.toOp)?.title === other?.title,
      );
      const alternative = sameName
        ? context.ops.find((candidate) => candidate.id === sameName.toOp)
        : null;

      /*
       * Nothing declared, so read the field names of the two endpoints in
       * hand. A row carrying `UnitId` beside a collection whose rows are keyed
       * `Id` is the near-universal convention, and both sides are already
       * pinned, so there is no second candidate to be wrong about.
       */
      const paired =
        other && picked.secondary
          ? pairFields(shape, context.shapes[picked.secondary], other.path ?? other.id)
          : null;

      if (paired && picked.secondary) {
        patch.joinWith = { endpoint: picked.secondary, ...paired };
        notes.push(
          `Nothing in the map says how ${op.title} relates to ${other?.title ?? picked.secondary}, ` +
            `so these were matched on ${paired.leftField} = ${paired.rightField}. Check the row ` +
            "count on the preview — if few rows matched, they may not line up.",
        );
      } else {
        notes.push(
          alternative
            ? `The map links ${op.title} to ${alternative.path ?? alternative.id} rather than to ` +
                `${other?.path ?? picked.secondary}, and those are different records despite the ` +
                "shared name — so this is built from the first alone rather than joined to the wrong one."
            : `Nothing in the map says how ${op.title} relates to ${other?.title ?? picked.secondary}, ` +
                "and no field on either side obviously carries the other's identity, so this is " +
                "built from the first alone.",
        );
      }
    }
  }

  /*
   * A comparison discards the binding call's widget, so its doubts go with it.
   *
   * That call only ever saw one endpoint, so on this path it reliably worries
   * that the other one's data is missing — true of what it was shown, and
   * false of what is being built. Passing that on would have the assistant
   * warn the user about the exact gap the widget closes. Its doubts are about
   * the roles it proposed, and those roles are not being used.
   */
  /*
   * A second reading of the request, prepared in full and put to the user.
   *
   * Prepared here rather than at answer time because this is where the shapes
   * are in hand: switching to a different endpoint needs that endpoint's own
   * date field, and looking one up later would mean the pure step machine
   * reaching for something only the server has.
   *
   * The option already applied is included, so the question reads as "did you
   * mean this instead" rather than as a decision somebody has to make before
   * anything works — the widget on screen is what happens if nobody answers.
   */
  for (const role of ["primary", "secondary"] as const) {
    const alternatives = picked.alternatives.filter((entry) => entry.role === role);
    if (!alternatives.length) continue;
    const appliedId = role === "primary" ? op.id : patch.parts?.[0]?.endpoint;
    if (!appliedId) continue;
    const options = [
      { id: appliedId, whatItIs: "What this is built from now." },
      ...alternatives,
    ].flatMap((entry) => {
      const known = context.ops.find((candidate) => candidate.id === entry.id);
      return known && context.shapes[entry.id]
        ? [{ op: entry.id, label: known.title, whatItIs: entry.whatItIs }]
        : [];
    });
    if (options.length < 2) continue;
    const choice = { role: "primary" as const, options: options.slice(0, 3) };
    if (role === "primary") patch.choiceBetween = choice;
    else if (patch.parts?.[0]) patch.parts[0].choiceBetween = choice;
  }

  /*
   * Which model designed this, carried through to the built widget.
   *
   * Read off the adapter rather than from `input.model`, which is an override
   * that is usually absent — the adapter knows what it was constructed for,
   * and that is what actually ran.
   */
  patch.model = input.model ?? input.llm.defaultModel;

  return {
    patch,
    reason: picked.reason,
    notes,
    /*
     * Doubts from a call that only saw one endpoint, discarded when a second
     * is being built.
     *
     * The comment further up says exactly this about a comparison, and the
     * same trap caught `alongside`: the primary binding call is shown the
     * properties and nothing else, so it reliably reports that the listings
     * are not in this response — true of what it was shown, and false of what
     * is being built. Passed on, it had the assistant announce "available
     * listings have not been included yet" above a widget that included them.
     */
    ambiguities: ambiguities.filter(
      (entry) =>
        entry.kind !== "missing_endpoint" ||
        !entry.endpoint ||
        ![
          patch.endpoint,
          ...(patch.parts ?? []).map((part) => part.endpoint),
          ...(patch.seriesWith ?? []).map((side) => side.endpoint),
        ].includes(entry.endpoint),
    ),
  };
};

/** Qualify endpoint identity during planning, then restore local ids at the draft boundary. */
export const proposeSetup = async (input: ProposeSetupInput): Promise<ProposedSetup> => {
  const { context } = input;
  if (!context.byConnection || context.connections.length < 2) return proposeSingle(input);
  const references = new Map<string, { connection: string; op: string }>();
  const qualified: ConciergeContext[] = Object.entries(context.byConnection).map(
    ([connection, local], index) => {
      const ids = new Map<string, string>();
      const ref = (op: string) => {
        const id = ids.get(op) ?? `c${index}-op${ids.size}`;
        ids.set(op, id);
        references.set(id, { connection, op });
        return id;
      };
      return {
        ...local,
        ops: local.ops.map((op) => ({ ...op, id: ref(op.id) })),
        shapes: Object.fromEntries(
          Object.entries(local.shapes).map(([op, shape]) => [ref(op), shape]),
        ),
        joins: local.joins.map((join) => ({
          ...join,
          fromOp: ref(join.fromOp),
          toOp: ref(join.toOp),
        })),
        children: local.children.map((child) => ({
          ...child,
          op: ref(child.op),
          parentOp: ref(child.parentOp),
        })),
        drillDowns: local.drillDowns.map((detail) => ({
          ...detail,
          listOp: ref(detail.listOp),
          detailOp: ref(detail.detailOp),
        })),
      };
    },
  );
  const combined: ConciergeContext = {
    ...context,
    ops: qualified.flatMap((local) => local.ops),
    shapes: Object.assign({}, ...qualified.map((local) => local.shapes)),
    joins: qualified.flatMap((local) => local.joins),
    children: qualified.flatMap((local) => local.children),
    drillDowns: qualified.flatMap((local) => local.drillDowns),
  };
  const result = await proposeSingle({ ...input, context: combined });
  const localId = (id: string) => references.get(id)?.op ?? id;
  const restore = (patch: DraftPatch): DraftPatch => ({
    ...patch,
    ...(patch.endpoint
      ? {
          endpoint: localId(patch.endpoint),
          connection: references.get(patch.endpoint)?.connection ?? patch.connection,
        }
      : {}),
    ...(patch.joinWith
      ? { joinWith: { ...patch.joinWith, endpoint: localId(patch.joinWith.endpoint) } }
      : {}),
    ...(patch.seriesWith
      ? {
          seriesWith: patch.seriesWith.map((side) => ({
            ...side,
            endpoint: localId(side.endpoint),
            ...(side.fanOut ? { fanOut: { ...side.fanOut, from: localId(side.fanOut.from) } } : {}),
          })),
        }
      : {}),
    ...(patch.offerSeries
      ? {
          offerSeries: {
            ...patch.offerSeries,
            endpoint: localId(patch.offerSeries.endpoint),
            fanOut: { ...patch.offerSeries.fanOut, from: localId(patch.offerSeries.fanOut.from) },
          },
        }
      : {}),
    ...(patch.parts ? { parts: patch.parts.map(restore) } : {}),
    ...(patch.choiceBetween
      ? {
          choiceBetween: {
            ...patch.choiceBetween,
            options: patch.choiceBetween.options.map((option, index) => ({
              ...option,
              value: `option-${index}`,
              op: localId(option.op),
              connection: references.get(option.op)?.connection,
              label:
                `${option.label} (${context.connections.find((entry) => entry.id === references.get(option.op)?.connection)?.title ?? "API"})`.slice(
                  0,
                  120,
                ),
            })),
          },
        }
      : {}),
  });
  return { ...result, patch: restore(result.patch) };
};
