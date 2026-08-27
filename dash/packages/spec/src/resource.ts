import { z } from "zod";
import { idSchema, pathParamNames } from "./primitives.js";

/**
 * The noun an API exposes, and the thing that makes endpoints relational
 * rather than a flat list of URLs.
 *
 * Nearly every REST API is the same handful of shapes wearing different words:
 * a collection, a by-id detail, and foreign keys between them. Buildium has
 * leases and work orders; Stripe has charges and customers; GitHub has issues
 * and repositories. Recording that structure once is what lets a row be
 * clicked, a record be opened, and two endpoints be joined — without any of
 * that logic knowing which vendor it is talking to.
 *
 * Nothing here is asserted as fact until a real request proves it. Everything
 * derived from a specification carries `verified: false`, on the same rule the
 * rest of discovery follows: documentation is a hypothesis, the live 200 is
 * the oracle.
 */

export const relationSchema = z.object({
  /** Stable handle for this link, e.g. `workOrders`. */
  id: idSchema,
  title: z.string().min(1).max(120),
  /** The resource on the other end. */
  resource: idSchema,
  cardinality: z.enum(["one", "many"]),
  /**
   * For `one`: the field on THIS row holding the target's id.
   * A lease row's `TenantId` points at one tenant.
   */
  localField: z.string().max(120).optional(),
  /**
   * For `many`: the field on the TARGET row pointing back here.
   * A work-order row's `LeaseId` points back at its lease.
   */
  foreignField: z.string().max(120).optional(),
  /**
   * Query parameter on the target's list op that filters by the foreign key.
   *
   * Its presence is the difference between one filtered request and one
   * request per row — see the fan-out cap in the widget plan.
   */
  filterParam: z.string().max(120).optional(),
  /**
   * How the other side is actually fetched. A consumer asks this and does not
   * care which signal found the relation.
   *
   * - `path`   — a scoped endpoint, `/leases/{leaseId}/transactions`. One
   *              request per parent, so it belongs in a drill-down.
   * - `filter` — the child's own collection, narrowed by a query parameter.
   *              One request for all of them.
   * - `fanOut` — neither is available, so it is one request per row. Capped,
   *              and the cap is reported rather than quietly truncating.
   */
  via: z.enum(["path", "filter", "fanOut"]).default("fanOut"),
  /** The endpoint returning the other side. */
  op: idSchema.optional(),
  /** The input on `op` that this row's identity feeds. Path or query. */
  param: z.string().max(120).optional(),
  /**
   * What the linking field on this row actually holds.
   *
   * The three shapes a foreign key comes in, and the reason a relation that
   * reads perfectly can still match nothing:
   *
   * - `scalar`    — `PropertyId: 42`. Compared directly.
   * - `array`     — `PropertyIds: [42, 51]`. An id is compared against the
   *                 list, never against the list itself: `[42,51] == "42"` is
   *                 false for every row, and the section renders empty rather
   *                 than erroring, so nothing says why.
   * - `objectRef` — `Property: { Id: 42, Href: "..." }`. The id is one level
   *                 in; comparing the object stringifies it to
   *                 `[object Object]`, which is equally false and equally
   *                 silent.
   *
   * Recorded rather than re-derived because it is a fact about the API, and
   * because the two wrong readings are indistinguishable from an account that
   * simply has no children.
   *
   * Optional rather than defaulted: a relation the URL declared has no linking
   * field at all — the id goes in the path — so stating a kind for it would be
   * inventing a fact about a field that does not exist. Absent means unknown,
   * and a reader holding the actual fields should always prefer those.
   */
  linkKind: z.enum(["scalar", "array", "objectRef"]).optional(),
  /**
   * Why this link exists, in a sentence somebody could disagree with.
   *
   * The shareable half of understanding an API. A title says what the link is
   * called; this says what made it believable — which field names lined up,
   * which section of the API both sides live in, or a convention the API
   * follows that no schema states. It travels with the map, so the next person
   * to connect this API inherits the reasoning rather than the conclusion
   * alone, and can tell a solid link from a plausible one.
   */
  notes: z.string().max(400).optional(),
  /**
   * How the relation was found, not whether it works.
   *
   * `declared` means the API stated it — the URL contains the parent. That is
   * structurally certain in a way a name match never is. Orthogonal to
   * `verified`, which means a real request proved it: declared-but-unverified
   * is the normal state right after import.
   */
  confidence: z.enum(["declared", "inferred"]).default("inferred"),
  verified: z.boolean().default(false),
});

export type RelationSpec = z.infer<typeof relationSchema>;

export const resourceSchema = z.object({
  /** Singular and lowercase by convention, e.g. `lease`. */
  id: idSchema,
  title: z.string().min(1).max(120),
  /**
   * The primary key *in the row*, e.g. `Id`.
   *
   * Cannot be known from a path — a URL says `{leaseId}` while the response
   * says `Id`. It comes from sampling a real response, which is why it is
   * optional and why a resource is not `verified` until one has been seen.
   */
  idField: z.string().max(120).optional(),
  /** Human-readable label for a row, e.g. `PropertyName`. */
  labelField: z.string().max(120).optional(),
  /** The collection endpoint. */
  listOp: idSchema.optional(),
  /** The by-id endpoint. Its path parameter is fed from `idField`. */
  detailOp: idSchema.optional(),
  /** The path parameter `detailOp` expects, e.g. `leaseId`. */
  detailParam: z.string().max(120).optional(),
  relations: z.array(relationSchema).max(40).default([]),
  verified: z.boolean().default(false),
});

export type ResourceSpec = z.infer<typeof resourceSchema>;

/** The resource a given op belongs to, by either role. */
export const resourceForOp = (
  resources: readonly ResourceSpec[],
  opId: string,
): ResourceSpec | undefined =>
  resources.find((resource) => resource.listOp === opId || resource.detailOp === opId);

/**
 * Can a row from this resource be expanded into a detail view?
 *
 * Both halves are required: an endpoint to call, and the field on the row that
 * feeds it. Having one without the other is the common half-derived state, and
 * silently rendering a click target that cannot resolve is worse than none.
 */
export const canDrillDown = (
  resource: ResourceSpec | undefined,
): resource is ResourceSpec & { detailOp: string; idField: string; detailParam: string } =>
  Boolean(resource?.detailOp && resource.idField && resource.detailParam);

/* ── Shape rules ──────────────────────────────────────────────────────────
 *
 * The vocabulary for reading structure out of a set of endpoints, owned here
 * because two callers need it: the OpenAPI importer derives resources at
 * import time, and the capabilities layer re-derives them for a connection
 * that predates the resource model or had endpoints added by hand.
 *
 * It lived in both files, separately, with a silent difference in how they
 * treated a missing `archetype`. Two copies of a rule that decides what a
 * resource *is* is how an importer and an analyser come to disagree about the
 * same API.
 *
 * Every rule here is about shape or universal naming convention. None of it
 * knows any vendor.
 */

/** The op fields these rules read. Structural, so both op types satisfy it. */
export interface ShapeOp {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly archetype?: string | undefined;
}

/** `/v1/leases` → `v1/leases`, so paths compare regardless of slashes or case. */
export const collectionKey = (path: string): string =>
  path.replace(/^\/+|\/+$/g, "").toLowerCase();

/** The literal segments of a path, with `{{param.x}}` tokens dropped. */
export const pathSegments = (path: string): string[] =>
  collectionKey(path)
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.includes("{{"));

/**
 * Singularise for a readable resource id: `leases` → `lease`.
 *
 * Deliberately does not strip `-es` after a bare `s`. English is ambiguous
 * there — `addresses` loses `es` but `leases` loses only the `s` — and the
 * second pattern is far more common among API nouns (leases, purchases,
 * invoices). Getting it wrong produces `leas`, so the narrow rule wins.
 */
export const singularNoun = (word: string): string => {
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/sses$/i.test(word)) return word.slice(0, -2); // addresses → address
  if (/(x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2); // boxes → box
  if (/ss$/i.test(word)) return word; // address stays address
  if (/s$/i.test(word)) return word.slice(0, -1); // leases → lease
  return word;
};

/**
 * The noun a path parameter names: `leaseId` → `lease`, `unit_id` → `unit`.
 *
 * A parameter is the API stating which record it wants, so its name is a
 * second, independent declaration of the noun the path segment already
 * implies. Where the two agree the reading is certain; where they disagree
 * that disagreement is itself worth reporting.
 */
export const nounFromPathParam = (name: string): string | undefined => {
  const stripped = name.replace(/[_-]?(id|ids)$/i, "");
  if (stripped === "" || stripped.toLowerCase() === name.toLowerCase()) return undefined;
  return singularNoun(stripped.toLowerCase());
};

/** A path ending in exactly one `{{param.x}}` — the record form. */
/** Path segments two URLs share from the left. `/v1/a/b` vs `/v1/a/c` is 2. */
export const sharedPathPrefix = (left: string, right: string): number => {
  const a = pathSegments(left);
  const b = pathSegments(right);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared;
};

/**
 * How many leading segments every path in an API shares.
 *
 * Almost always the version — `/v1` — but it is read rather than assumed,
 * because plenty of APIs have no version in the path and plenty of others are
 * mounted under something longer like `/api/v2`. Whatever it is, it is common
 * to everything and therefore evidence of nothing, which is exactly what
 * `resolveSameNoun` needs to discount.
 */
export const commonPathPrefix = (paths: readonly string[]): number => {
  const split = paths.map((path) => pathSegments(path)).filter((segments) => segments.length > 0);
  if (split.length < 2) return 0;

  const [first, ...rest] = split as [string[], ...string[][]];
  let shared = 0;
  while (shared < first.length && rest.every((segments) => segments[shared] === first[shared])) {
    shared++;
  }
  return shared;
};

/**
 * Which of several same-named resources a reference means, or none of them.
 *
 * APIs reuse nouns across sections. Buildium has two endpoints called
 * "Retrieve all units" — `/v1/rentals/units` and `/v1/associations/units` —
 * and they are different kinds of unit. A `UnitId` on a lease row means the
 * rentals one; on an ownership account it means the associations one. Neither
 * the field name nor the title says which, and the endpoint titles are
 * identical.
 *
 * The path says, when the two live in different sections: an ownership
 * account at `/v1/associations/ownershipaccounts` shares two segments with
 * `/v1/associations/units` and one with `/v1/rentals/units`, so the
 * association units win on their own merits.
 *
 * When the source is equidistant — a lease at `/v1/leases` is one segment
 * from both — this returns null and the caller must drop the link. That is
 * the intended outcome and not a failure to try harder. **A wrong join
 * silently pairs unrelated records and looks exactly like a right one**,
 * whereas a missing one is visible and can be added by hand. This feeds the
 * catalog entry, which is the artifact the whole design shares — map an API
 * once, everyone downloads the map — so a wrong link here is not one person's
 * local mistake, it is everyone's.
 */
export const resolveSameNoun = <T extends { readonly path?: string | undefined }>(
  rivals: readonly T[],
  sourcePath: string | undefined,
  /**
   * Leading segments to discount, from `commonPathPrefix`.
   *
   * Required rather than defaulted, because either default is wrong somewhere
   * and both fail quietly: guess too low and every tie in a versioned API
   * resolves arbitrarily, which is the bug this exists to prevent; guess too
   * high and an unversioned API can never resolve anything.
   */
  ignorePrefix: number,
): T | null => {
  if (rivals.length === 1) return rivals[0] ?? null;
  if (!sourcePath) return null;

  let best: T | null = null;
  let bestScore = 0;
  let tied = false;

  for (const rival of rivals) {
    if (!rival.path) continue;
    const score = sharedPathPrefix(rival.path, sourcePath);
    if (score > bestScore) {
      best = rival;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && best) {
      tied = true;
    }
  }

  /*
   * The winner has to share something the whole API does not already share.
   * On `/v1/...` that means beating one segment; on an API with no version in
   * the path it means beating none, so a single shared section is decisive
   * there and is not here. Reading the floor off the API rather than fixing it
   * at a number is what keeps this from being a rule about one vendor's URLs.
   */
  return tied || bestScore <= ignorePrefix ? null : best;
};

const DETAIL_PATH = /^(.*)\/\{\{\s*param\.([A-Za-z0-9_]+)\s*\}\}$/;

/** Treated as a collection unless the archetype says otherwise. */
const isList = (op: ShapeOp): boolean => (op.archetype ?? "list") === "list";

/** A collection whose path carries a parent's id: `/leases/{leaseId}/notes`. */
const CHILD_PATH = /^(.*)\/\{\{\s*param\.([A-Za-z0-9_]+)\s*\}\}\/(.+)$/;

export interface ResourceModel {
  readonly resources: readonly ResourceSpec[];
  /** Readings that were uncertain, in the words a person would use. */
  readonly notes: readonly string[];
}

/**
 * Read the resource graph out of a set of endpoint paths.
 *
 * Four shapes, and keeping them apart is the whole job:
 *
 *   /leases                              a collection
 *   /leases/{leaseId}                    one record from it
 *   /leases/{leaseId}/transactions       a collection *inside* one record
 *   /leases/{leaseId}/transactions/{id}  one record from that
 *
 * The third line is the one that matters. A path carrying a parent's id is the
 * API declaring a parent-child relation in the URL itself — the most reliable
 * relational signal there is, because nothing was inferred from a name. It is
 * also near-universal: GitHub writes `/repos/{owner}/{repo}/issues`, Stripe
 * writes `/customers/{id}/subscriptions`.
 *
 * `idField` is deliberately left unset throughout. A path says `{leaseId}`
 * while the response says `Id`, and no specification states the
 * correspondence — it comes from sampling a real response. A resource without
 * it cannot drill down yet, which `canDrillDown` reports honestly.
 */
export const deriveResourceModel = (ops: readonly ShapeOp[]): ResourceSpec[] =>
  deriveResourceGraph(ops).resources as ResourceSpec[];

export const deriveResourceGraph = (ops: readonly ShapeOp[]): ResourceModel => {
  const notes: string[] = [];
  const resources: ResourceSpec[] = [];
  const taken = new Set<string>();
  /** Collection path → the resource that owns it, for parent lookup. */
  const byListPath = new Map<string, ResourceSpec>();

  const claim = (base: string): string => {
    const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "record";
    let id = cleaned;
    let suffix = 2;
    while (taken.has(id)) id = `${cleaned}-${suffix++}`;
    taken.add(id);
    return id;
  };

  /**
   * The by-id endpoint for a collection, if one is declared.
   *
   * "Exactly one more parameter than its collection" is what separates a
   * record of *this* collection from something further down the path — and it
   * is the generalisation of the old rule, which could only ever count to one
   * and so could not see anything nested.
   */
  const detailFor = (listPath: string): { op: ShapeOp; param: string } | undefined => {
    const wanted = collectionKey(listPath);
    const depth = pathParamNames(listPath).length;
    for (const op of ops) {
      const match = DETAIL_PATH.exec(op.path);
      if (!match) continue;
      const [, prefix, param] = match;
      if (!prefix || !param) continue;
      if (collectionKey(prefix) !== wanted) continue;
      if (pathParamNames(op.path).length !== depth + 1) continue;
      return { op, param };
    }
    return undefined;
  };

  /*
   * Top-level collections first, so a child can never take an id a top-level
   * resource would have used — and so every previously derived id stays
   * byte-identical, which the importer's tests depend on.
   */
  for (const op of ops) {
    if (!isList(op) || pathParamNames(op.path).length > 0) continue;
    const detail = detailFor(op.path);
    if (!detail) continue;

    const resource: ResourceSpec = {
      id: claim(singularNoun(pathSegments(op.path).pop() ?? "record")),
      title: op.title,
      listOp: op.id,
      detailOp: detail.op.id,
      detailParam: detail.param,
      relations: [],
      verified: false,
    };
    resources.push(resource);
    byListPath.set(collectionKey(op.path), resource);
  }

  /*
   * Then the collections that live inside a record. These often have no
   * top-level collection of their own, which is not a gap — it is the API
   * saying the noun only exists in context. There is no "all units" because a
   * unit belongs to a property.
   */
  /*
   * Shallowest first, so a child's own parent is always already registered.
   * `/a/{x}/b/{y}/c` needs `/a/{x}/b` to exist before it can find its owner,
   * and document order guarantees nothing.
   */
  const children = ops
    .filter((op) => CHILD_PATH.test(op.path))
    .sort((a, b) => pathSegments(a.path).length - pathSegments(b.path).length);

  for (const op of children) {
    // Deliberately not filtered to lists: a scoped endpoint returning one
    // object — `/units/{unitId}/listing` — is still a relation, just a
    // has-one. Requiring a list here is what would drop it.
    const match = CHILD_PATH.exec(op.path);
    if (!match) continue;
    const [, parentPrefix, param, tail] = match;
    if (!parentPrefix || !param || !tail) continue;
    // A further parameter in the tail means this is a record further down,
    // which some other collection will claim as its detail op.
    if (tail.includes("{{")) continue;

    const childNoun = singularNoun(pathSegments(tail).pop() ?? "record");

    // Reading 1: the parent's own collection is right there in the path.
    const declared = byListPath.get(collectionKey(parentPrefix));
    // Reading 2: the parameter names the noun — `unitId` means a unit.
    const paramNoun = nounFromPathParam(param);
    const named = paramNoun ? resources.find((item) => item.id === paramNoun) : undefined;

    const owner = declared ?? named;
    const confidence: "declared" | "inferred" = declared ? "declared" : "inferred";

    if (!declared && named) {
      /*
       * The parameter named a resource, but the path it came from is not that
       * resource's collection. `/rentals/units/{unitId}/listing` resolves to
       * "unit" — and if the only units collection is `/associations/units`,
       * those are two different kinds of unit, and binding them would produce
       * a confidently wrong join. Say so rather than guess.
       */
      const ownerPath = [...byListPath].find(([, item]) => item === named)?.[0] ?? "";
      if (ownerPath && !collectionKey(parentPrefix).startsWith(ownerPath)) {
        notes.push(
          `"${op.title}" needs a ${paramNoun} id, but the only ${paramNoun} collection here is a different endpoint — check they are the same kind of ${paramNoun}.`,
        );
      }
    }

    const detail = detailFor(op.path);
    const resource: ResourceSpec = {
      id: claim(owner ? `${owner.id}-${childNoun}` : childNoun),
      title: op.title,
      listOp: op.id,
      ...(detail ? { detailOp: detail.op.id, detailParam: detail.param } : {}),
      relations: [],
      verified: false,
    };
    resources.push(resource);
    byListPath.set(collectionKey(op.path), resource);

    if (!owner) {
      notes.push(
        `"${op.title}" is reached through an id this API does not list anywhere, so it can only be opened from a record that already supplies one.`,
      );
      continue;
    }

    /*
     * Only the downward link is declared. That a lease HAS transactions is
     * stated by the URL; that a transaction row carries a LeaseId is not, and
     * plenty of APIs omit the back-pointer precisely because the parent was in
     * the path. Writing that link anyway would put a field in the spec that no
     * row has, and `{{row.LeaseId}}` would interpolate to nothing — a 404 that
     * reads like a bad key. The upward link is added only when a sampled row
     * is actually seen to carry it.
     */
    owner.relations.push({
      id: claim(`${owner.id}-${childNoun}s`),
      title: op.title,
      resource: resource.id,
      // A scoped endpoint returning a single object is a has-one.
      cardinality: (op.archetype ?? "list") === "list" ? "many" : "one",
      via: "path",
      op: op.id,
      param,
      confidence,
      verified: false,
    });
  }

  return { resources, notes };
};
