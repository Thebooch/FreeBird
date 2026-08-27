import type { RelationSpec, ResourceSpec } from "./resource.js";
import { nounFromPathParam, singularNoun } from "./resource.js";
import { pathParamNames } from "./primitives.js";

/**
 * The relationship graph, resolved once, for everybody who needs to traverse it.
 *
 * The pattern this exists to serve is the most ordinary thing a dashboard
 * does, and it is the same on every API: you list some records, you click one,
 * and the things belonging to that record are fetched by its id. Properties
 * and their units, customers and their invoices, repositories and their
 * issues. Nothing about it is domain knowledge — it is a parent, an id, and a
 * collection that accepts one.
 *
 * That pattern was being re-derived in five places, each with its own idea of
 * which side a field lived on and its own gaps. This is the single reading.
 * Callers ask three questions and get answers they can execute without
 * knowing how the graph is stored:
 *
 *   childrenOf(op)      what hangs off one of this endpoint's rows
 *   joinablePeers(op)   what can be fetched wholesale and matched to it
 *   recordOf(op)        how to open one row on its own
 *
 * Two things make this more than a convenience wrapper.
 *
 * **Both directions are walked here, once.** A relation is stored on whichever
 * side carries the field, which is frequently the child: units are listed at
 * `/rentals/units`, so nothing in any URL says a property has units — what
 * says so is that a unit row carries a `PropertyId`, recorded on the unit,
 * pointing at the property. Turned around, that is exactly a child collection.
 * Because both readings happen in one place they can be **de-duplicated**, and
 * a graph that records the same fact from both ends — which the mapping pass
 * routinely does — stops producing four sections for one relationship.
 *
 * **A link is checked against the fields before it is offered.** A relation
 * that reads perfectly can still match nothing: an array compared to an id, or
 * an object compared to an id, is false for every row on every API. That does
 * not error — it renders an empty section, which looks exactly like a parent
 * that genuinely has no children. Those are refused here and reported through
 * `unusable`, on the rule the rest of this codebase follows: a missing link is
 * visible and can be fixed, a wrong one is invisible and cannot.
 */

/** The endpoint facts this reads. Structural, so any op record satisfies it. */
export interface GraphOp {
  readonly id: string;
  readonly path: string;
  /** Declared inputs. Absent means unknown, which is not the same as none. */
  readonly params?: readonly { readonly name: string; readonly in: string }[] | undefined;
}

/** One field a set of rows carries, declared or sampled. */
export interface GraphField {
  readonly name: string;
  readonly kinds: readonly string[];
}

export interface RelationGraphInput {
  readonly resources: readonly ResourceSpec[];
  readonly ops: readonly GraphOp[];
  /**
   * What each endpoint's rows contain, keyed by op id.
   *
   * Optional, and its absence is treated as ignorance rather than as absence:
   * an op with no entry has its links offered on the map's word alone, because
   * refusing everything an unsampled endpoint claims would make a fresh
   * connection relationless. An op that *has* an entry is taken at that entry's
   * word — a field not in a known list is a field the rows do not carry.
   */
  readonly fields?: Readonly<Record<string, readonly GraphField[]>> | undefined;
}

/**
 * How a related collection is actually fetched, with nothing left to work out.
 *
 * - `path`   — the endpoint's URL has a slot for the parent's id.
 * - `filter` — the endpoint declares a query parameter that narrows by it. One
 *              request for every parent's children rather than one per parent.
 * - `match`  — neither, so the collection is read and its rows are matched on
 *              a field. Always available, and always the expensive option.
 *
 * `filter` is only ever emitted for a parameter the endpoint *declares*. An
 * API answers 200 to a parameter it does not recognise and returns the whole
 * collection, so an invented one puts every record in the account under every
 * parent while looking completely healthy — the worst failure available here,
 * because nothing about it appears wrong.
 */
export type LinkFetch =
  | { readonly mode: "path"; readonly param: string }
  | { readonly mode: "filter"; readonly param: string }
  | { readonly mode: "match"; readonly field: string; readonly kind: "scalar" | "array" };

export interface ChildLink {
  readonly id: string;
  readonly title: string;
  /** Why this link is believed, where the map recorded a reason. */
  readonly notes?: string | undefined;
  /** The endpoint whose rows are the parents. */
  readonly parentOp: string;
  /** The endpoint listing the children. */
  readonly op: string;
  readonly resource: string;
  /** The field on a parent row supplying the id, where one is known. */
  readonly parentIdField?: string | undefined;
  readonly fetch: LinkFetch;
  readonly confidence: "declared" | "inferred";
  readonly verified: boolean;
}

/** Two bare collections that can be fetched whole and matched on a field. */
export interface PeerLink {
  readonly id: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly fromOp: string;
  readonly toOp: string;
  readonly leftField: string;
  readonly rightField: string;
  /** A declared parameter that would narrow the right-hand fetch, if any. */
  readonly filterParam?: string | undefined;
  readonly confidence: "declared" | "inferred";
  readonly verified: boolean;
}

/** How to open one row of a collection on its own. */
export interface RecordLink {
  readonly resource: string;
  readonly op: string;
  readonly param: string;
  readonly idField: string;
  readonly labelField?: string | undefined;
  /**
   * Whether `idField` was seen in a real response or read off a convention.
   *
   * Callers that are about to write something shared should care; callers
   * rendering a record view should not. A conventional reading is right
   * overwhelmingly often and wrong visibly — the detail request 404s — which
   * is the failure this is allowed to risk. Silently offering nothing, which
   * is what happened before, is the failure it is not.
   */
  readonly idFieldObserved: boolean;
}

/** A link the map records that cannot be executed, and the reason in words. */
export interface UnusableLink {
  readonly from: string;
  readonly to: string;
  readonly field: string;
  readonly reason: string;
}

export interface RelationGraph {
  /** Collections belonging to one row of `opId`. */
  readonly childrenOf: (opId: string) => readonly ChildLink[];
  /** Endpoints one of whose rows this one's rows belong to. */
  readonly parentsOf: (opId: string) => readonly ChildLink[];
  /** Bare collections joinable to `opId` wholesale. */
  readonly joinablePeers: (opId: string) => readonly PeerLink[];
  readonly recordOf: (opId: string) => RecordLink | undefined;
  readonly children: readonly ChildLink[];
  readonly peers: readonly PeerLink[];
  readonly unusable: readonly UnusableLink[];
}

/** Match the same way the runtime does, so ids compare regardless of case. */
const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The field on a row that holds its own identity.
 *
 * A path says `{unitId}` and the response says `Id`, and no specification
 * states the correspondence — which is why `deriveResourceGraph` leaves
 * `idField` unset and why a sampled report was the only way to learn it. The
 * consequence was worse than it sounds: across a 109-collection API, *nothing*
 * could open a record until somebody had paid for a read, so a freshly mapped
 * connection had relations it could not use.
 *
 * So where a real response has not settled it, the convention is read instead.
 * Only from names the endpoint actually declares — a guess at a field that is
 * not there would produce `{{row.Id}}` interpolating to nothing, which is a
 * 404 that reads like a bad key. And only from the two spellings that mean
 * identity and nothing else:
 *
 *   1. a bare `Id` / `id`
 *   2. `<noun>Id`, where the noun is the one the collection or its detail
 *      parameter already names — `UnitId` on a unit
 *
 * Deliberately not `Key`, `Code`, `Number` or `Uuid`. Each is an identifier on
 * some APIs and a business value on others, and pairing a record view to a
 * check number instead of a check is exactly the confidently-wrong outcome the
 * rest of this file exists to avoid.
 */
export const inferIdField = (
  fields: readonly GraphField[] | undefined,
  nouns: readonly string[],
): string | undefined => {
  if (!fields || fields.length === 0) return undefined;

  // An identity is a single value. An object or a list is something else.
  const usable = fields.filter(
    (field) => !field.kinds.includes("object") && !field.kinds.includes("array"),
  );

  const bare = usable.find((field) => normalise(field.name) === "id");
  if (bare) return bare.name;

  const wanted = new Set(nouns.filter(Boolean).map((noun) => `${normalise(noun)}id`));
  return usable.find((field) => wanted.has(normalise(field.name)))?.name;
};

/**
 * A declared query parameter on this endpoint that filters by the given field.
 *
 * The plural form is checked because filtering by a set is how most APIs spell
 * it — `propertyids` takes the property ids you want — and the dotted form
 * normalises to the same thing, so a link that had to reach through an object
 * to find its id still finds the parameter.
 */
const declaredFilterParam = (op: GraphOp | undefined, field: string): string | undefined => {
  const wanted = normalise(field);
  return op?.params?.find((param) => {
    if (param.in !== "query") return false;
    const name = normalise(param.name);
    return name === wanted || name === `${wanted}s` || name === `filterby${wanted}`;
  })?.name;
};

/**
 * What a field is worth as a link: the name to compare on, and what it holds.
 *
 * `null` means the link cannot be honoured. Three ways that happens, and the
 * distinction between the first and the other two matters: not knowing an
 * endpoint's fields is ignorance and is allowed through, while knowing them
 * and not finding the field is evidence and is refused.
 */
const resolveLink = (
  fields: readonly GraphField[] | undefined,
  name: string,
): { readonly field: string; readonly kind: "scalar" | "array" } | { readonly reason: string } => {
  // Nothing is known about this endpoint's rows, so nothing contradicts the
  // map. Refusing here would leave a freshly imported API with no relations.
  if (!fields || fields.length === 0) return { field: name, kind: "scalar" };

  const found = fields.find((field) => field.name === name);
  if (!found) {
    return { reason: `the rows do not carry a field called ${name}` };
  }

  if (found.kinds.includes("array")) return { field: name, kind: "array" };

  /*
   * An object holds the id one level in. Shapes are flattened one level by
   * both the inferrer and the importer, so the readable half is usually right
   * there as `Property.Id` — and where it is not, there is genuinely nothing
   * to compare and the link is refused rather than compared against
   * `[object Object]`, which is false for every row and says so to nobody.
   */
  if (found.kinds.includes("object")) {
    const nested = fields.find(
      (field) => field.name === `${name}.Id` || field.name === `${name}.id`,
    );
    if (!nested) {
      return {
        reason: `${name} is an object and no ${name}.Id was found to compare on`,
      };
    }
    return {
      field: nested.name,
      kind: nested.kinds.includes("array") ? "array" : "scalar",
    };
  }

  return { field: name, kind: "scalar" };
};

/**
 * How the map says the field is shaped, when the fields themselves are silent.
 *
 * The mapping pass records `linkKind` from the response schema, which covers
 * the endpoints nobody can sample because they need an id. Only consulted
 * where the field list could not answer, so a real observation always wins.
 */
const kindFromRelation = (relation: RelationSpec): "scalar" | "array" =>
  relation.linkKind === "array" ? "array" : "scalar";

/** Whichever record of this link is better evidence. Declared beats inferred. */
const stronger = <T extends { confidence: "declared" | "inferred"; verified: boolean }>(
  a: T,
  b: T,
): T => {
  if (a.verified !== b.verified) return a.verified ? a : b;
  if (a.confidence !== b.confidence) return a.confidence === "declared" ? a : b;
  return a;
};

export const relationGraph = (input: RelationGraphInput): RelationGraph => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  const byId = new Map(input.resources.map((resource) => [resource.id, resource]));
  const fieldsOf = (opId: string): readonly GraphField[] | undefined => input.fields?.[opId];
  const isBare = (opId: string): boolean =>
    pathParamNames(opById.get(opId)?.path ?? "").length === 0;

  /*
   * Keyed by what the link *is* rather than by which side recorded it, so the
   * same fact arriving from both ends collapses to one entry. The mapping pass
   * routinely records both — `vendor → workorder on Id=VendorId` alongside
   * `workorder → vendor on VendorId=Id` — and without this each is then read
   * forwards and backwards, producing four sections for one relationship.
   */
  const children = new Map<string, ChildLink>();
  const peers = new Map<string, PeerLink>();
  const unusable: UnusableLink[] = [];

  const addChild = (link: ChildLink): void => {
    /*
     * An endpoint with a slot in its URL cannot be fetched without something
     * to put in it, and only `path` mode supplies one. A filter or a row match
     * leaves `{{param.announcementId}}` unresolved, so the request either 404s
     * or goes out with a literal placeholder in the path — an offer that
     * cannot be executed, which is worse than a missing one.
     */
    if (link.fetch.mode !== "path" && pathParamNames(opById.get(link.op)?.path ?? "").length > 0) {
      unusable.push({
        from: link.parentOp,
        to: link.op,
        field: link.fetch.mode === "match" ? link.fetch.field : link.fetch.param,
        reason: "that endpoint needs an id in its URL that nothing here supplies",
      });
      return;
    }

    const key = `${link.parentOp}|${link.op}|${link.fetch.mode === "match" ? link.fetch.field : link.fetch.param}`;
    const existing = children.get(key);
    children.set(key, existing ? stronger(existing, link) : link);
  };

  const addPeer = (link: PeerLink): void => {
    // Order-independent, because a join is symmetric and the two endpoints
    // recording it from opposite sides describe one relationship.
    const key = [`${link.fromOp}:${link.leftField}`, `${link.toOp}:${link.rightField}`]
      .sort()
      .join("|");
    const existing = peers.get(key);
    peers.set(key, existing ? stronger(existing, link) : link);
  };

  for (const source of input.resources) {
    for (const relation of source.relations) {
      const target = byId.get(relation.resource);
      if (!target) continue;

      const sourceOp = source.listOp;
      const targetOp = target.listOp;

      /*
       * Reading 1 — the API put the parent in the URL.
       *
       * The strongest signal there is, because nothing was inferred from a
       * name: `/leases/{leaseId}/notes` cannot mean anything else. The
       * endpoint needs an id and the parent row is what supplies it.
       */
      if (relation.via === "path" && relation.param && sourceOp && targetOp) {
        addChild({
          id: `${relation.resource}-of-${source.id}`,
          title: relation.title || target.title,
          notes: relation.notes,
          parentOp: sourceOp,
          op: targetOp,
          resource: target.id,
          parentIdField: source.idField,
          fetch: { mode: "path", param: relation.param },
          confidence: relation.confidence,
          verified: relation.verified,
        });
        continue;
      }

      /*
       * Reading 2 — the target's rows carry this resource's id.
       *
       * `foreignField` is a column on the *other* side, so the children are
       * the target and the parent is here.
       *
       * Gated on cardinality, which is the schema's own account of which field
       * carries the link: `many` means the other side points back, `one` means
       * this side points out. A relation that records both fields describes a
       * single fact, and reading it under both headings makes the child a
       * parent of its own parent — two sections, in opposite directions, for
       * one relationship.
       */
      if (relation.cardinality === "many" && relation.foreignField && sourceOp && targetOp) {
        const link = resolveLink(fieldsOf(targetOp), relation.foreignField);
        if ("reason" in link) {
          unusable.push({
            from: source.id,
            to: target.id,
            field: relation.foreignField,
            reason: link.reason,
          });
        } else {
          const param = declaredFilterParam(opById.get(targetOp), link.field);
          addChild({
            id: `${relation.resource}-of-${source.id}`,
            title: relation.title || target.title,
            notes: relation.notes,
            parentOp: sourceOp,
            op: targetOp,
            resource: target.id,
            parentIdField: source.idField,
            fetch: param
              ? { mode: "filter", param }
              : { mode: "match", field: link.field, kind: link.kind },
            confidence: relation.confidence,
            verified: relation.verified,
          });
        }
      }

      /*
       * Reading 3 — this resource's rows carry the target's id, so the target
       * is the parent and this is the child. The direction most children
       * actually arrive in, and the one that used to be missing: a unit row
       * carries `PropertyId`, which is recorded on the unit, and "these unit
       * rows name a property" is the same fact as "a property has units".
       */
      if (relation.cardinality === "one" && relation.localField && sourceOp && targetOp) {
        const link = resolveLink(fieldsOf(sourceOp), relation.localField);
        if ("reason" in link) {
          unusable.push({
            from: target.id,
            to: source.id,
            field: relation.localField,
            reason: link.reason,
          });
        } else {
          /*
           * The parameter is looked up on the *child's* endpoint, which is
           * this resource's. `relation.filterParam` names one on the target's
           * endpoint by definition, so reading it here would send a
           * `/rentals` parameter to `/rentals/units` — and an API ignores a
           * parameter it does not declare, answering 200 with everything.
           */
          const param = declaredFilterParam(opById.get(sourceOp), link.field);
          const kind = link.kind === "array" ? "array" : kindFromRelation(relation);
          addChild({
            id: `${source.id}-under-${target.id}`,
            title: source.title,
            notes: relation.notes,
            parentOp: targetOp,
            op: sourceOp,
            resource: source.id,
            parentIdField: relation.foreignField ?? target.idField,
            fetch: param
              ? { mode: "filter", param }
              : { mode: "match", field: link.field, kind },
            confidence: relation.confidence,
            verified: relation.verified,
          });
        }
      }

      /*
       * Reading 4 — a peer join.
       *
       * Both sides fetched whole and matched in memory, which needs both to be
       * callable with nothing: an endpoint that requires an id is a child, not
       * a peer, and the same relation has already been read as one above.
       */
      /*
       * The left-hand column, which a `many` relation does not name.
       *
       * It records only the field on the far side pointing back — "work order
       * rows carry a VendorId" — because the near side is simply the vendor's
       * own identity. Falling back to `idField` is what makes that relation
       * joinable at all; without it a map written entirely in the `many`
       * direction produces children and no joins, which is how the same graph
       * came to answer two questions inconsistently.
       */
      const nearField = relation.localField ?? (relation.cardinality === "many" ? source.idField : undefined);

      if (
        nearField &&
        relation.foreignField &&
        sourceOp &&
        targetOp &&
        sourceOp !== targetOp &&
        isBare(sourceOp) &&
        isBare(targetOp)
      ) {
        const left = resolveLink(fieldsOf(sourceOp), nearField);
        const right = resolveLink(fieldsOf(targetOp), relation.foreignField);
        // Both halves were already reported as unusable by the readings above,
        // so a join that cannot be built is simply not offered.
        if (!("reason" in left) && !("reason" in right)) {
          addPeer({
            id: `${sourceOp}:${left.field}:${targetOp}`,
            title: relation.title,
            notes: relation.notes,
            fromOp: sourceOp,
            toOp: targetOp,
            leftField: left.field,
            rightField: right.field,
            filterParam: declaredFilterParam(opById.get(targetOp), right.field),
            confidence: relation.confidence,
            verified: relation.verified,
          });
        }
      }
    }
  }

  /*
   * A scoped endpoint outranks any other route to the same rows.
   *
   * `/v1/leases/{leaseId}/transactions` and "transaction rows carry a LeaseId"
   * are the same collection reached two ways, and both were being offered:
   * one section fetching the lease's transactions, another fetching every
   * transaction in the account and filtering. Two tabs, the same rows, and the
   * expensive one indistinguishable from the cheap one by looking.
   *
   * Not folded into the de-duplication key, which deliberately keeps the link
   * field: two links between the same pair of endpoints on *different* fields
   * are two real sections — a record's "created by" and "last updated by" both
   * point at users and are not the same thing. What collapses here is
   * narrower: same pair, and one of them is the URL the API published.
   */
  const declaredPairs = new Set(
    [...children.values()]
      .filter((link) => link.fetch.mode === "path")
      .map((link) => `${link.parentOp}|${link.op}`),
  );

  const allChildren = [...children.values()].filter(
    (link) => link.fetch.mode === "path" || !declaredPairs.has(`${link.parentOp}|${link.op}`),
  );
  const allPeers = [...peers.values()];

  return {
    children: allChildren,
    peers: allPeers,
    unusable,
    childrenOf: (opId) => allChildren.filter((link) => link.parentOp === opId),
    parentsOf: (opId) => allChildren.filter((link) => link.op === opId),
    joinablePeers: (opId) =>
      allPeers
        .filter((link) => link.fromOp === opId || link.toOp === opId)
        .map((link) =>
          link.fromOp === opId
            ? link
            : // Reported from the asking endpoint's point of view, so a caller
              // never has to work out which end it is on.
              {
                ...link,
                fromOp: link.toOp,
                toOp: link.fromOp,
                leftField: link.rightField,
                rightField: link.leftField,
                filterParam: undefined,
              },
        ),
    recordOf: (opId) => {
      const resource = input.resources.find((item) => item.listOp === opId);
      if (!resource?.detailOp || !resource.detailParam) return undefined;

      /*
       * A sampled id always wins. It was seen in a response, and no convention
       * outranks having looked. Only where nothing has been read does the
       * naming get a turn — and it reads from the fields of the *list*
       * endpoint, because those are the rows whose ids will feed the request.
       */
      const nouns = [
        nounFromPathParam(resource.detailParam),
        singularNoun(resource.id.replace(/-\d+$/, "")),
      ].filter((noun): noun is string => Boolean(noun));

      const idField = resource.idField ?? inferIdField(fieldsOf(opId), nouns);
      if (!idField) return undefined;

      return {
        resource: resource.id,
        op: resource.detailOp,
        param: resource.detailParam,
        idField,
        labelField: resource.labelField,
        idFieldObserved: resource.idField !== undefined,
      };
    },
  };
};
