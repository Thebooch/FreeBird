import type { FieldInfo, InferredShape } from "@freebirdai/dash-agent";
import type {
  CapabilityReport,
  ConnectionSpec,
  EnumerationOutcome,
  OpDef,
  ResourceSpec,
} from "@freebirdai/dash-spec";
import {
  capabilityReportSchema,
  commonPathPrefix,
  deriveResourceGraph,
  deriveResourceModel,
  fingerprintOps,
  pathParamNames,
  pathSegments,
  requiredInputs,
  resolveSameNoun,
  singularNoun,
} from "@freebirdai/dash-spec";

/**
 * What a connection can actually do, worked out from its own endpoints.
 *
 * The product should offer rather than interrogate: everything derivable is
 * derived and presented for approval, and the only thing a person is ever
 * asked to supply is a credential, because that is the one thing no amount of
 * inspection can produce.
 *
 * Every rule here is about *shape* — a path that ends in one parameter, a
 * field whose name is the singular of a collection — never about a particular
 * vendor. An API either has these shapes or it does not.
 */

export interface DrillDownOffer {
  readonly resource: string;
  readonly title: string;
  readonly listOp: string;
  readonly detailOp: string;
  /** Row field carrying the record's identity, learned from a sample. */
  readonly idField: string;
  /** The detail endpoint's path parameter that identity feeds. */
  readonly detailParam: string;
  readonly labelField?: string;
  /** True once a real response has shown the id field exists. */
  readonly sampled: boolean;
}

export interface JoinOffer {
  readonly from: string;
  readonly to: string;
  readonly title: string;
  /** Field on the `from` rows holding the other resource's identity. */
  readonly foreignField: string;
  /** Field on the `to` rows it matches. */
  readonly targetField: string;
  /**
   * Query parameter on the target's list endpoint that filters by the key.
   *
   * Its absence is what forces one request per row, so it is reported rather
   * than discovered at run time.
   */
  readonly filterParam?: string;
  readonly needsFanOut: boolean;
}

/**
 * Everything readable from the endpoints alone, with no requests at all.
 *
 * Separated from the sampled half because the two have wildly different costs
 * and the split is what lets this scale. An API with 230 endpoints has a
 * relation graph that can be handed over instantly; only identity — which
 * field on a row is its id — needs a real response, and only for the
 * resources someone actually cares about.
 */
export interface StructuralCapabilities {
  readonly connection: string;
  readonly resources: readonly ResourceSpec[];
  /** Endpoints declaring a free-text search parameter. */
  readonly searchable: ReadonlyArray<{ op: string; param: string }>;
  /** Endpoints declaring a date range. */
  readonly rangeFilterable: ReadonlyArray<{ op: string; start: string; end?: string }>;
  readonly notes: readonly string[];
}

export interface Capabilities extends StructuralCapabilities {
  readonly drillDowns: readonly DrillDownOffer[];
  readonly joins: readonly JoinOffer[];
  /** Resources whose identity is still unknown, each with a reason. */
  readonly unknowns: readonly UnknownResource[];
  /**
   * Field names seen on each sampled resource, by resource id.
   *
   * Report data, not spec data — deliberately not folded into `ResourceSpec`,
   * which is persisted and should carry conclusions rather than observations.
   * It exists so a caller can bind columns to what a response actually
   * contained without sampling the same endpoint a second time.
   */
  readonly fieldsByResource: Readonly<Record<string, readonly string[]>>;
  /** How the pass ended. `complete` and `budget` are both successes. */
  readonly outcome: EnumerationOutcome;
  /** Real requests this pass cost, so "look deeper" can be priced honestly. */
  readonly requestsSpent: number;
  /** The upstream's `Retry-After`, when a rate limit is what stopped us. */
  readonly retryAfter?: string;
}

/** Knobs on a pass. Defaults reproduce the behaviour these replaced. */
export interface AnalyseOptions {
  readonly maxSamples?: number;
  readonly maxChildSamples?: number;
  readonly maxChildrenPerParent?: number;
  /** Wall-clock target the requests are spread across. */
  readonly targetMs?: number;
  /** Injected so tests never actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called after each request, for a progress bar that reflects reality. */
  readonly onProgress?: (progress: { spent: number; planned: number }) => void;
}

/**
 * What a pass will cost, without making a single request.
 *
 * Everything here is read off the endpoints, so it can be shown to someone
 * *before* they agree to it. The child figure is an upper bound — a child is
 * only opened when its parent turned out to have a usable id — so the estimate
 * errs high, which is the right direction for a number someone is consenting to.
 */
export const estimateEnumeration = (
  connection: ConnectionSpec,
  options: AnalyseOptions = {},
): {
  collections: number;
  estimatedRequests: number;
  estimatedMs: number;
  willSampleChildren: boolean;
} => {
  const maxSamples = options.maxSamples ?? MAX_SAMPLES;
  const maxChildSamples = options.maxChildSamples ?? MAX_CHILD_SAMPLES;
  const { resources } = deriveResourceGraph(connection.ops);
  const byOp = new Map(connection.ops.map((op) => [op.id, op]));

  const callable = resources.filter((resource) => {
    const op = resource.listOp ? byOp.get(resource.listOp) : undefined;
    return op !== undefined && requiredInputs(op).length === 0;
  });
  const collections = Math.min(callable.length, maxSamples);

  const reachableChildren = resources.reduce(
    (total, resource) =>
      total +
      resource.relations.filter((relation) => relation.via === "path" && relation.op).length,
    0,
  );
  const children = Math.min(reachableChildren, maxChildSamples);
  const estimatedRequests = collections + children;

  return {
    collections,
    estimatedRequests,
    // Gaps sit *between* requests, so there is one fewer of them than there
    // are calls — the progress bar is animated against this figure and would
    // lag a whole gap behind if it counted one too many.
    estimatedMs: Math.max(0, estimatedRequests - 1) * paceGapMs(estimatedRequests, options.targetMs),
    willSampleChildren: children > 0,
  };
};

/**
 * Re-derive this connection's resources from the ops it currently has.
 *
 * The importer does this at import time; doing it here too means a connection
 * created before the resource model existed — or one whose endpoints were
 * added by hand — gets the same treatment without being rebuilt. Both call the
 * same rules, so they cannot drift.
 */
export const deriveResourcesFromOps = (ops: readonly OpDef[]): ResourceSpec[] =>
  deriveResourceModel(ops);

/**
 * Which sampled field carries the record's identity.
 *
 * No specification states this — a path says `{leaseId}` while the response
 * says `Id` — so it can only come from a real response. Preference order is
 * exact `id`, then `<resource>Id`, then any single trailing-`id` field.
 */
export const pickIdField = (fields: readonly FieldInfo[], resourceId: string): string | undefined => {
  const flat = fields.filter((field) => !field.name.includes("."));
  const named = (predicate: (name: string) => boolean): string | undefined =>
    flat.find((field) => predicate(field.name.toLowerCase()))?.name;

  const resource = resourceId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    named((name) => name === "id") ??
    named((name) => name === `${resource}id`) ??
    named((name) => name === "uuid" || name === "guid" || name === "key") ??
    named((name) => name === `${resource}_id`) ??
    flat.filter((field) => /(^|_)id$/i.test(field.name)).map((field) => field.name)[0]
  );
};

/** A human-readable name for a row, so a picker shows words rather than ids. */
export const pickLabelField = (fields: readonly FieldInfo[]): string | undefined => {
  const flat = fields.filter((field) => !field.name.includes("."));
  const texty = flat.filter((field) => field.kinds.includes("string"));
  const preferred = ["name", "title", "label", "displayname", "description", "subject", "summary"];

  for (const want of preferred) {
    const hit = texty.find((field) => field.name.toLowerCase().replace(/[^a-z]/g, "") === want);
    if (hit) return hit.name;
  }
  // Fall back to the first string field that is not obviously an identifier.
  return texty.find((field) => !/(^|_)(id|uuid|guid)$/i.test(field.name))?.name;
};

/** A resource a foreign key might point at. */
export interface ForeignKeyTarget {
  readonly id: string;
  readonly idField: string;
  /**
   * What this resource's rows are called, when that differs from its id.
   *
   * Ids are unique and nouns are not, so the graph suffixes a duplicate —
   * two `units` collections become `unit` and `unit-2`. That suffix is a
   * storage concern and matching on it is a bug: `unit-2` normalises to
   * `unit2` and so can never match a `UnitId` field, which quietly made one
   * of the two collections unreachable by every foreign key in the API.
   */
  readonly noun?: string | undefined;
  /**
   * The collection's own path, used only to break a tie between rivals.
   *
   * A target without one cannot win a contested match — refusing is the
   * correct outcome when there is nothing to decide on.
   */
  readonly path?: string | undefined;
}

/**
 * Whether a target can be listed without already holding some other id.
 *
 * A target with no path is treated as bare because there is nothing to judge
 * it on — and because the single-target callers here pass none. Only a path
 * that visibly demands a parameter disqualifies one.
 */
const isBare = (target: ForeignKeyTarget): boolean =>
  target.path === undefined || pathParamNames(target.path).length === 0;

/** The noun a target is matched on, with the disambiguating suffix removed. */
const nounOf = (target: ForeignKeyTarget): string =>
  (target.noun ?? target.id.replace(/-\d+$/, "")).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Fields on one resource that look like they hold another resource's identity.
 *
 * The convention is near-universal: a field named for the target resource plus
 * an id suffix — `LeaseId`, `customer_id`, `repoId`. Matching on that shape
 * rather than on a configured mapping is what makes this work on an API nobody
 * has described to us.
 *
 * Where two resources answer to the same noun the match is contested, and is
 * resolved by path affinity or refused. Both halves matter: this feeds the
 * *catalog entry*, which is the artifact the whole design shares — map an API
 * once and everyone downloads the map — so a wrong link here is not one
 * person's local mistake, it is everyone's.
 */
export const findForeignKeys = (
  fields: readonly FieldInfo[],
  targets: readonly ForeignKeyTarget[],
  options: {
    /** The path of the endpoint whose rows these fields came from. */
    readonly sourcePath?: string | undefined;
    /**
     * Leading path segments every endpoint in this API shares, from
     * `commonPathPrefix` — usually a version, sometimes nothing at all.
     * Discounted when judging affinity, since what everything shares is
     * evidence of nothing. Zero when the caller has no view of the whole API,
     * which is right: it should not invent a prefix it cannot see.
     */
    readonly mountDepth?: number | undefined;
    /** Contested matches that were refused are explained here. */
    readonly notes?: string[] | undefined;
  } = {},
): Array<{ resource: string; foreignField: string; targetField: string }> => {
  const found: Array<{ resource: string; foreignField: string; targetField: string }> = [];
  /** Nouns already explained, so one ambiguity is reported once. */
  const explained = new Set<string>();

  for (const target of targets) {
    const noun = nounOf(target);
    const hit = fields.find((field) => {
      if (field.name.includes(".")) return false;
      const name = field.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      // `leaseid`, but not the resource's own `id`.
      return name === `${noun}id` && name !== "id";
    });
    if (!hit) continue;
    /*
     * A field holding a bare id cannot point at a collection that must be
     * scoped by some *other* id first. `/v1/rentals/{propertyId}/vendors` is
     * not "all vendors" and there is no property in hand to ask about, so it
     * is not a candidate — not a contested one, not one at all.
     */
    if (!isBare(target)) continue;

    /*
     * Only collections callable on their own compete for a bare foreign key.
     *
     * Buildium has three collections ending in `/vendors`, two of which are
     * `/v1/rentals/{propertyId}/vendors` and
     * `/v1/associations/{associationId}/vendors`. A `VendorId` cannot mean
     * either — there is no property or association in hand to scope them by,
     * and neither is "all vendors". Counting them made an unambiguous link
     * look contested and dropped it.
     */
    const rivals = targets.filter(
      (candidate) => nounOf(candidate) === noun && isBare(candidate),
    );
    if (rivals.length > 1) {
      const winner = resolveSameNoun(rivals, options.sourcePath, options.mountDepth ?? 0);
      if (!winner) {
        if (!explained.has(noun)) {
          explained.add(noun);
          options.notes?.push(
            `"${hit.name}" could point at ${rivals.length} different kinds of ${noun} ` +
              `(${rivals.map((rival) => rival.path ?? rival.id).join(", ")}), and nothing here ` +
              "says which — so no link was recorded. Joining them by hand still works.",
          );
        }
        continue;
      }
      // The winner emits on its own turn; every rival stands down.
      if (winner.id !== target.id) continue;
    }

    found.push({ resource: target.id, foreignField: hit.name, targetField: target.idField });
  }
  return found;
};

/**
 * A query parameter on this endpoint that filters by the given foreign key.
 *
 * One filtered request instead of one request per row — the difference
 * between a widget that loads and one that burns a rate limit.
 *
 * Typed structurally rather than against `OpDef`, because the two places that
 * need it hold different records of the same endpoint: the enumeration pass
 * has the connection's resolved ops, and the concierge has the catalog map's.
 * Both carry the declared parameters, and the declared parameters are the
 * whole of the evidence — so one rule serves both rather than being copied
 * and drifting, which is how the same endpoint comes to be filterable in one
 * code path and not the other.
 *
 * Dotted names work by construction: `Property.Id` normalises to `propertyid`
 * exactly as `PropertyId` does, so a relation that had to reach through an
 * object to find the id still finds the parameter.
 */
export const findFilterParam = (
  op:
    | { readonly params?: readonly { readonly name: string; readonly in: string }[] | undefined }
    | undefined,
  foreignField: string,
): string | undefined => {
  // No record of the endpoint, or a record that declares no parameters, are
  // the same answer: nothing is known to filter by, so nothing is claimed.
  const wanted = foreignField.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (op?.params ?? []).find((param) => {
    if (param.in !== "query") return false;
    const name = param.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return name === wanted || name === `${wanted}s` || name === `filterby${wanted}`;
  })?.name;
};

/** Endpoints that declare a search or date-range parameter, by role. */
export const inputAffordances = (
  ops: readonly OpDef[],
): Pick<Capabilities, "searchable" | "rangeFilterable"> => {
  const searchable: Array<{ op: string; param: string }> = [];
  const rangeFilterable: Array<{ op: string; start: string; end?: string }> = [];

  for (const op of ops) {
    const search = op.params.find((param) => param.role === "search");
    if (search) searchable.push({ op: op.id, param: search.name });

    const start = op.params.find((param) => param.role === "rangeStart");
    const end = op.params.find((param) => param.role === "rangeEnd");
    if (start) {
      rangeFilterable.push({ op: op.id, start: start.name, ...(end ? { end: end.name } : {}) });
    }
  }
  return { searchable, rangeFilterable };
};

/**
 * What came back, and — when nothing did — why.
 *
 * "The endpoint returned no rows" and "the request never succeeded" used to
 * collapse into the same silence, so an account with an unused feature looked
 * identical to a broken credential. They lead to different next steps, so they
 * are different outcomes.
 */
export type SampleOutcome =
  | { readonly kind: "rows"; readonly fields: readonly FieldInfo[]; readonly rowCount: number }
  | { readonly kind: "empty" }
  | {
      readonly kind: "failed";
      readonly message: string;
      /**
       * Upstream HTTP status, when there was one.
       *
       * The difference between "this one endpoint 404s" and "this API is now
       * refusing everything" is the difference between skipping a resource and
       * stopping the pass, and it cannot be read out of a message string.
       */
      readonly status?: number;
      readonly retryAfter?: string;
    };

export interface SampleFn {
  (
    opId: string,
    inputs?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<SampleOutcome>;
}

/** Why a resource is still unknown, in a form the UI can act on. */
export interface UnknownResource {
  readonly resource: string;
  readonly title: string;
  /**
   * - `empty`         — the endpoint answered, the account has no records yet
   * - `unsampled`     — we ran out of sampling budget
   * - `needsParent`   — it only exists inside another record
   * - `needsInput`    — it declares inputs nobody has supplied
   * - `requestFailed` — the call did not succeed
   * - `aborted`       — the pass stopped early (rate limit, rejected key) and
   *                     never got as far as this one
   *
   * Kept in step with `unknownResourceSchema` in `@freebirdai/dash-spec`; a reason that
   * exists here and not there cannot be written to a report.
   */
  readonly reason:
    | "empty"
    | "unsampled"
    | "needsParent"
    | "needsInput"
    | "requestFailed"
    | "aborted";
  readonly recheckOp?: string;
  /** Inputs the endpoint needs before it can be called at all. */
  readonly needs?: readonly string[];
  readonly detail?: string;
}

/** How many collections may be sampled. Each one is a real request. */
export const MAX_SAMPLES = 25;

/**
 * How long a full pass should take, deliberately.
 *
 * Enumeration's danger was never the total — 41 requests is nothing over a day
 * — it was firing them back to back. A burst is what trips a rate limiter, and
 * a limiter that trips does not just fail this pass: an API that starts
 * answering 403 punishes every later call too.
 *
 * So the burst is removed rather than merely capped. Spreading the same
 * requests across five seconds turns roughly eight per second into a trickle
 * no ordinary limiter reacts to, and it costs the user five seconds once.
 */
export const PACE_TARGET_MS = 5_000;

/**
 * Ceiling on the gap between two requests.
 *
 * Without it, a three-endpoint API would be padded to the full five seconds for
 * no reason — the target is a speed limit, not a quota to fill.
 */
export const PACE_MAX_GAP_MS = 1_200;

/** Delay between requests so `planned` of them land in about {@link PACE_TARGET_MS}. */
export const paceGapMs = (planned: number, targetMs = PACE_TARGET_MS): number => {
  if (planned <= 1) return 0;
  return Math.min(Math.round(targetMs / (planned - 1)), PACE_MAX_GAP_MS);
};

/**
 * Statuses that end the pass instead of skipping one resource.
 *
 * A rate limit will still be a rate limit on the next call, and an
 * unauthenticated request will still be unauthenticated — continuing would
 * spend the rest of the budget proving the same thing forty more times, while
 * digging the limiter deeper.
 *
 * **403 is deliberately not here.** It used to be, and that was wrong: 401
 * means the credential was not accepted at all, while 403 means it *was* and
 * this particular endpoint is off limits. Plenty of APIs scope a key per
 * resource, so one forbidden endpoint says nothing about the next — aborting
 * on the first threw away every readable endpoint behind it, and reported a
 * working credential as a rejected one.
 */
const isTerminal = (status: number | undefined): boolean =>
  status === 429 || status === 401;

/** Authenticated, but this endpoint is not permitted for that key. */
const isForbidden = (status: number | undefined): boolean => status === 403;

/**
 * How many child collections may be opened through a parent record.
 *
 * A scoped endpoint has no parameter-free form, so this is the only way to
 * ever see one of its rows — and therefore the only way to learn its identity
 * field, which is what a drill-down needs. Bounded, because it is one request
 * each on top of the parent sampling.
 */
export const MAX_CHILD_SAMPLES = 16;

/**
 * How many children of any one parent may be opened.
 *
 * Matches the cap on related sections a drill-down can carry, and stops one
 * parent with a dozen sub-collections from spending the whole budget while
 * every other parent gets nothing.
 *
 * The totals matter more than they look: enumeration is the single most
 * request-hungry thing this product does, and an API that starts refusing —
 * a 403 where an empty list used to be — punishes every later call too. Keep
 * the ceiling low enough that repeating it is not itself the problem.
 */
export const MAX_CHILDREN_PER_PARENT = 4;

/* ── verifying a proposed pairing ─────────────────────────────────────── */

export interface ProposedPairing {
  readonly parent: string;
  readonly child: string;
  /** Field on the child's rows the model believes holds the parent's id. */
  readonly linkField: string;
}

export interface VerifiedPairing extends ProposedPairing {
  readonly ok: boolean;
  /** Why it was rejected, in words the drawer can show. */
  readonly reason?: string;
  /** Fields the child actually returned, when it was read for this. */
  readonly fields?: readonly FieldInfo[];
}

/**
 * Check a model's guess against the API before anyone is offered it.
 *
 * The model proposes pairings from nouns and paths, which is the only way to
 * reach a relationship nothing declared — but a guess about *which field*
 * carries the parent's id is exactly the kind of thing that produces a widget
 * that renders empty forever. So each pairing costs at most one real request,
 * and anything that cannot be confirmed is dropped rather than shown.
 *
 * The same rule the discovery ladder already follows: documentation — or a
 * model — is a hypothesis, and the live 200 is the oracle. Cost scales with
 * the number of *proposals*, not the size of the API, which is what makes this
 * affordable where sampling everything is not.
 */
export const verifyPairings = async (
  pairings: readonly ProposedPairing[],
  resources: readonly ResourceSpec[],
  known: Readonly<Record<string, readonly FieldInfo[]>>,
  sample: SampleFn,
  options: { sleep?: (ms: number) => Promise<void>; targetMs?: number } = {},
): Promise<VerifiedPairing[]> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const seen = new Map<string, readonly FieldInfo[]>(Object.entries(known));

  // Only the children that still need reading; everything else is free.
  const toRead = new Set(
    pairings
      .map((pairing) => pairing.child)
      .filter((id) => !seen.has(id) && byId.get(id)?.listOp !== undefined),
  );
  const gap = paceGapMs(toRead.size, options.targetMs);

  const out: VerifiedPairing[] = [];
  let spent = 0;

  /** Read one collection, at most once, paced. */
  const read = async (id: string, opId: string): Promise<readonly FieldInfo[] | null> => {
    const already = seen.get(id);
    if (already) return already;
    if (spent > 0 && gap > 0) await sleep(gap);
    spent += 1;
    const outcome = await sample(opId).catch((caught: unknown) => ({
      kind: "failed" as const,
      message: caught instanceof Error ? caught.message : String(caught),
    }));
    if (outcome.kind !== "rows" || outcome.fields.length === 0) return null;
    seen.set(id, outcome.fields);
    return outcome.fields;
  };

  for (const pairing of pairings) {
    const parent = byId.get(pairing.parent);
    const child = byId.get(pairing.child);

    if (!parent || !child) {
      out.push({ ...pairing, ok: false, reason: "one of those resources does not exist" });
      continue;
    }
    if (!child.listOp) {
      out.push({
        ...pairing,
        ok: false,
        reason: `"${child.title}" only exists inside another record, so it has no collection to filter`,
      });
      continue;
    }

    /*
     * A parent with no known identity cannot key anything — but that is
     * usually just an unread parent, not a dead end. One request fixes it.
     */
    let parentId = parent.idField;
    if (!parentId && parent.listOp) {
      const parentFields = await read(parent.id, parent.listOp);
      if (parentFields) parentId = pickIdField(parentFields, parent.id);
    }
    if (!parentId) {
      out.push({
        ...pairing,
        ok: false,
        reason: `"${parent.title}" has no identity field that could key its children`,
      });
      continue;
    }

    const fields = await read(child.id, child.listOp);
    if (!fields) {
      out.push({
        ...pairing,
        ok: false,
        reason: `"${child.title}" could not be read, so the link could not be confirmed`,
      });
      continue;
    }

    /*
     * Repair rather than reject.
     *
     * The model is good at spotting *that* two resources belong together and
     * poor at naming the exact column — asked about unread resources it tends
     * to answer `Id` for everything. Rejecting on that threw away every
     * correct pairing it found. Since the child's real fields are in hand by
     * now, the column can simply be looked up: first the model's guess
     * (case-insensitively, since a difference of capitalisation is the same
     * field by any sane reading), then the ordinary foreign-key shape — a
     * field named for the parent with an id suffix.
     */
    /*
     * The child's own primary key is never the link to its parent.
     *
     * Asked for the linking column on a resource it has not seen, the model
     * answers `Id` almost every time — and a child collection does have an
     * `Id`, so a name check alone accepts it. The result filters the children
     * by their own identity and shows one row, or none. Rule it out here and
     * let the data-driven tiers below find the real foreign key.
     */
    const ownId = pickIdField(fields, child.id);
    const linksToSelf = (name: string): boolean =>
      name.toLowerCase() === "id" || (ownId !== undefined && name === ownId);

    const named = fields.find(
      (field) => field.name.toLowerCase() === pairing.linkField.toLowerCase(),
    );
    const guessed = named && !linksToSelf(named.name) ? named : undefined;
    const byNoun = (() => {
      const [found] = findForeignKeys(fields, [{ id: parent.id, idField: parentId! }]);
      return found ? fields.find((field) => field.name === found.foreignField) : undefined;
    })();

    /*
     * Last resort: the only foreign key on the child.
     *
     * Noun matching compares against the resource id, which is derived from
     * the URL segment — and an API is free to call the same thing one word in
     * its paths and another in its payloads, so the match fails on vocabulary
     * alone even when the link plainly exists. When a child carries exactly
     * one id-shaped column other than its own there is no ambiguity about what
     * it points at. Two or more and there genuinely is, so it is reported
     * rather than guessed.
     */
    const foreignKeys = fields.filter(
      (field) =>
        !field.name.includes(".") && /(^|[_-])id$/i.test(field.name) && !linksToSelf(field.name),
    );
    const derived = guessed ?? byNoun ?? (foreignKeys.length === 1 ? foreignKeys[0] : undefined);

    if (!derived) {
      out.push({
        ...pairing,
        ok: false,
        reason:
          foreignKeys.length > 1
            ? `"${child.title}" has several possible links (${foreignKeys
                .map((field) => field.name)
                .join(", ")}) — which one points at a ${parent.title.toLowerCase()} is ambiguous`
            : `"${child.title}" rows carry nothing linking back to a ${parent.title.toLowerCase()} — its fields are ${fields
                .slice(0, 8)
                .map((field) => field.name)
                .join(", ")}`,
      });
      continue;
    }

    // Answer with the field as the API spells it, not as the model guessed.
    out.push({ ...pairing, linkField: derived.name, ok: true, fields });
  }

  return out;
};

/**
 * Fold confirmed pairings into the resource graph as real relations.
 *
 * Written back so the reasoning is paid for once: the next widget, the chat
 * roster and any later agent read them straight off the report with no model
 * call at all.
 */
export const applyPairings = (
  resources: readonly ResourceSpec[],
  verified: readonly VerifiedPairing[],
  ops: readonly OpDef[] = [],
): ResourceSpec[] =>
  resources.map((resource) => {
    const mine = verified.filter((pairing) => pairing.ok && pairing.parent === resource.id);
    if (mine.length === 0) return resource;

    const relations = [...resource.relations];
    for (const pairing of mine) {
      const child = resources.find((candidate) => candidate.id === pairing.child);
      if (!child?.listOp) continue;

      const existing = relations.findIndex((relation) => relation.resource === pairing.child);
      if (existing >= 0) {
        /*
         * A URL-declared relation outranks anything inferred — the API said so
         * itself. An earlier inference does not: re-learning has to be able to
         * correct it, or one wrong link field is permanent. (It was: an early
         * run stored `Id` as the link, and skipping on "already present" meant
         * no later pass could ever replace it.)
         */
        if (relations[existing]!.via === "path") continue;
        relations.splice(existing, 1);
      }

      /*
       * The column and the query parameter are not the same fact.
       *
       * `foreignField` is a column on the child's rows, proved by reading
       * them. A query parameter is something the *endpoint* declares, and
       * nothing about a column implies one exists. Writing the verified column
       * into both slots sent an invented parameter, which an API is free to
       * ignore — and most do, answering 200 with the whole unfiltered
       * collection. The drill-down then opened on every record in the account
       * while looking entirely healthy.
       *
       * So the parameter is looked up, never assumed. Without one the relation
       * is still real; it is honoured by matching rows instead of by narrowing
       * the request, which the widget builders below do from `foreignField`.
       */
      const filterParam = findFilterParam(
        ops.find((op) => op.id === child.listOp),
        pairing.linkField,
      );

      relations.push({
        id: `${resource.id}-${pairing.child}s`.slice(0, 64),
        title: child.title,
        resource: pairing.child,
        cardinality: "many",
        foreignField: pairing.linkField,
        ...(filterParam ? { filterParam, param: filterParam } : {}),
        via: "filter",
        op: child.listOp,
        // A model read the nouns; a request proved the field. Inferred in
        // origin, verified in fact — the two axes stay independent.
        confidence: "inferred",
        verified: true,
      });
    }
    return { ...resource, relations };
  });

/**
 * Strip any filter parameter the endpoint does not actually declare.
 *
 * An invariant, enforced where the graph is assembled rather than only where
 * it is written — because a bad value survives in a stored report, and the
 * only thing that would rewrite it is a fresh proposal for a link the model
 * can already see and so will not propose again. It would have stayed wrong
 * indefinitely.
 *
 * The relation itself is left intact. A link with no usable parameter is still
 * a real link; it is honoured by matching rows instead of by narrowing the
 * request, and the widget builders read `foreignField` for exactly that. What
 * cannot be allowed to stand is a *request* built from an invented parameter,
 * because an API that ignores one answers 200 with everything and the result
 * looks healthy while being wholly wrong.
 *
 * Path relations are untouched: their parameter is part of the URL the API
 * published, which is as declared as a thing can be.
 */
export const withVerifiedParams = (
  resources: readonly ResourceSpec[],
  ops: readonly OpDef[],
): ResourceSpec[] => {
  const byId = new Map(ops.map((op) => [op.id, op]));

  return resources.map((resource) => {
    let changed = false;
    const relations = resource.relations.map((relation) => {
      if (relation.via === "path" || !relation.op) return relation;
      const declared = new Set(byId.get(relation.op)?.params.map((param) => param.name) ?? []);

      const param = relation.param && declared.has(relation.param) ? relation.param : undefined;
      const filterParam =
        relation.filterParam && declared.has(relation.filterParam)
          ? relation.filterParam
          : undefined;
      if (param === relation.param && filterParam === relation.filterParam) return relation;

      changed = true;
      // Whatever was in `param` was read off the rows, so it is worth keeping
      // as the matching column when nothing better is recorded.
      return {
        ...relation,
        param,
        filterParam,
        foreignField: relation.foreignField ?? relation.param,
      };
    });

    return changed ? { ...resource, relations } : resource;
  });
};

/**
 * Overlay the relations a person approved onto a freshly derived graph.
 *
 * Every pass re-derives resources from the endpoints, which is what keeps the
 * model honest — but it also means an edit would be silently undone on the
 * next run. So the connection's own saved resources win: a link somebody
 * corrected in the UI, or one a verified pairing wrote back, outranks whatever
 * the rules would have inferred for that same child.
 *
 * Merged per child rather than wholesale, so adding an endpoint still
 * contributes the relations it declares instead of being masked by a saved
 * graph that predates it. A saved relation whose endpoint or target no longer
 * exists is dropped — it cannot be fetched, and offering it would produce a
 * widget that fails at render.
 */
export const mergeStoredRelations = (
  derived: readonly ResourceSpec[],
  stored: readonly ResourceSpec[],
  ops: readonly OpDef[],
): ResourceSpec[] => {
  if (stored.length === 0) return [...derived];

  const storedById = new Map(stored.map((resource) => [resource.id, resource]));
  const liveResources = new Set(derived.map((resource) => resource.id));
  const liveOps = new Set(ops.map((op) => op.id));

  return derived.map((resource) => {
    const saved = storedById.get(resource.id);
    if (!saved || saved.relations.length === 0) return resource;

    const usable = saved.relations.filter(
      (relation) =>
        liveResources.has(relation.resource) && (!relation.op || liveOps.has(relation.op)),
    );
    if (usable.length === 0) return resource;

    const overridden = new Set(usable.map((relation) => relation.resource));
    return {
      ...resource,
      relations: [
        ...usable,
        ...resource.relations.filter((relation) => !overridden.has(relation.resource)),
      ],
    };
  });
};

/* ── persistence ──────────────────────────────────────────────────────── */

/**
 * Turn a finished pass into the document that goes on disk.
 *
 * `capabilityReportSchema.parse` is doing real work here, not just validating:
 * `persistedFieldSchema` has no `samples` key, so parsing is what strips the
 * example values off every field. The privacy boundary is enforced by the
 * schema rather than by remembering to delete something.
 */
export const toReport = (
  connection: ConnectionSpec,
  capabilities: Capabilities,
  shapes: Readonly<Record<string, InferredShape>>,
  meta: {
    outcome?: EnumerationOutcome;
    requestsSpent?: number;
    retryAfter?: string;
  } = {},
): CapabilityReport =>
  capabilityReportSchema.parse({
    connection: connection.id,
    generatedAt: new Date().toISOString(),
    opsFingerprint: fingerprintOps(connection.ops),
    resources: capabilities.resources,
    drillDowns: capabilities.drillDowns,
    joins: capabilities.joins,
    unknowns: capabilities.unknowns,
    searchable: capabilities.searchable,
    rangeFilterable: capabilities.rangeFilterable,
    shapes,
    notes: capabilities.notes,
    // The pass already knows how it ended and what it cost; `meta` is only an
    // override for a caller that knows better.
    outcome: meta.outcome ?? capabilities.outcome,
    requestsSpent: meta.requestsSpent ?? capabilities.requestsSpent,
    ...(meta.retryAfter ?? capabilities.retryAfter
      ? { retryAfter: meta.retryAfter ?? capabilities.retryAfter }
      : {}),
  });

/**
 * Rebuild a pass from disk, at no request cost.
 *
 * Shapes come back without their example values, because those were never
 * written down. Everything downstream copes: highlight offers read `samples`
 * and simply find none, so a restored report proposes the same widgets minus
 * the value-specific highlights, rather than proposing something wrong.
 */
export const fromReport = (
  report: CapabilityReport,
): { value: Capabilities; shapes: Record<string, InferredShape> } => {
  const shapes: Record<string, InferredShape> = {};
  const fieldsByResource: Record<string, readonly string[]> = {};

  for (const [resourceId, shape] of Object.entries(report.shapes)) {
    shapes[resourceId] = {
      rowsPath: shape.rowsPath,
      rowCount: shape.rowCount,
      schemaHash: shape.schemaHash,
      fields: shape.fields.map((field) => ({
        name: field.name,
        kinds: field.kinds,
        nullable: field.nullable,
        ...(field.format ? { format: field.format } : {}),
        distinct: field.distinct,
        samples: [],
      })),
    };
    fieldsByResource[resourceId] = shape.fields.map((field) => field.name);
  }

  return {
    value: {
      connection: report.connection,
      resources: report.resources,
      searchable: report.searchable,
      rangeFilterable: report.rangeFilterable,
      drillDowns: report.drillDowns,
      joins: report.joins,
      unknowns: report.unknowns,
      fieldsByResource,
      notes: report.notes,
      outcome: report.outcome,
      // Restoring costs nothing, and saying it cost what the original pass cost
      // would make "requests spent" meaningless as a running total.
      requestsSpent: 0,
      ...(report.retryAfter ? { retryAfter: report.retryAfter } : {}),
    },
    shapes,
  };
};

/**
 * Everything the endpoints say about themselves. No requests, any size of API.
 */
export const analyseStructure = (connection: ConnectionSpec): StructuralCapabilities => {
  const derived = deriveResourceGraph(connection.ops);
  const resources = withVerifiedParams(
    mergeStoredRelations(derived.resources, connection.resources, connection.ops),
    connection.ops,
  );
  const all = [...derived.notes];

  if (resources.length === 0) {
    all.push(
      "None of this connection's endpoints look like a collection of records, so there is " +
        "nothing to build a widget from yet. Adding an endpoint that returns a list would " +
        "give it something to work with.",
    );
  }

  return {
    connection: connection.id,
    resources,
    ...inputAffordances(connection.ops),
    notes: all,
  };
};

/**
 * A real value for a field, taken from what sampling already saw.
 *
 * `inferShape` keeps up to three example values per field, which is enough to
 * open a child collection without fetching the parent's body a second time.
 * Values are truncated at 80 characters there; an identifier is never that
 * long, but a non-scalar would arrive as the literal `{…}` and is refused
 * rather than sent as a path segment.
 */
const exampleValue = (
  fields: readonly FieldInfo[],
  name: string,
): string | number | undefined => {
  const value = fields.find((field) => field.name === name)?.samples?.[0];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "" && !value.startsWith("{") && !value.startsWith("["))
    return value;
  return undefined;
};

/**
 * Work out everything this connection supports, sampling where a specification
 * cannot answer.
 *
 * The costly half. Structure is free and already known by the time this runs;
 * what it buys is identity — which field on a row is its id — and that can
 * only ever come from a real response, because a path says `{leaseId}` while
 * the body says `Id` and nothing declares the correspondence.
 */
export const analyseConnection = async (
  connection: ConnectionSpec,
  sample: SampleFn,
  options: AnalyseOptions = {},
): Promise<Capabilities> => {
  const maxSamples = options.maxSamples ?? MAX_SAMPLES;
  const maxChildSamples = options.maxChildSamples ?? MAX_CHILD_SAMPLES;
  const maxChildrenPerParent = options.maxChildrenPerParent ?? MAX_CHILDREN_PER_PARENT;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));

  const structure = analyseStructure(connection);
  const resources = structure.resources;
  const notes = [...structure.notes];
  const unknowns: UnknownResource[] = [];

  const byOp = new Map(connection.ops.map((op) => [op.id, op]));
  const sampled = new Map<string, readonly FieldInfo[]>();

  /*
   * Only collections that can actually be called. An endpoint declaring an
   * input it has not been given cannot succeed, and spending a request to
   * rediscover that is how a budget of 25 becomes a budget of 5.
   */
  const callable = resources.filter((resource) => {
    const op = resource.listOp ? byOp.get(resource.listOp) : undefined;
    return op !== undefined && requiredInputs(op).length === 0;
  });
  const sampleable = callable.slice(0, maxSamples);

  /*
   * The pace is set from what we expect to spend, so the whole pass lands in
   * about `targetMs` no matter how big the API is. The estimate is shared with
   * the consent step, which is why the progress bar there is honest.
   */
  const planned = estimateEnumeration(connection, options).estimatedRequests;
  const gap = paceGapMs(planned, options.targetMs);
  let spent = 0;
  /*
   * A holder rather than a bare `let`: the assignment happens inside `take`,
   * and TypeScript does not follow a closure's writes back to an outer
   * variable — it would narrow this to `null` everywhere and refuse the reads
   * at the end. Property narrowing resets after a call, so an object works.
   */
  const halt: { reason: { outcome: EnumerationOutcome; retryAfter?: string } | null } = {
    reason: null,
  };
  /** Endpoints the key was accepted for but not permitted on. */
  let forbidden = 0;

  /** One paced request. Returns null once the pass has been stopped. */
  const take = async (
    opId: string,
    inputs?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<SampleOutcome | null> => {
    if (halt.reason) return null;
    if (spent > 0 && gap > 0) await sleep(gap);

    const outcome = await sample(opId, inputs).catch((caught: unknown) => ({
      kind: "failed" as const,
      message: caught instanceof Error ? caught.message : String(caught),
      ...(typeof (caught as { status?: unknown })?.status === "number"
        ? { status: (caught as { status: number }).status }
        : {}),
      ...(typeof (caught as { retryAfter?: unknown })?.retryAfter === "string"
        ? { retryAfter: (caught as { retryAfter: string }).retryAfter }
        : {}),
    }));

    spent += 1;
    options.onProgress?.({ spent, planned });

    if (outcome.kind === "failed" && isForbidden(outcome.status)) forbidden += 1;

    if (outcome.kind === "failed" && isTerminal(outcome.status)) {
      halt.reason = {
        outcome: outcome.status === 429 ? "rateLimited" : "authRejected",
        ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}),
      };
      notes.push(
        outcome.status === 429
          ? `Stopped early: ${connection.title} began rate limiting after ${spent} request(s).`
          : `Stopped early: ${connection.title} did not accept the credential (401).`,
      );
    }
    return outcome;
  };

  const enriched: ResourceSpec[] = [];
  for (const resource of resources) {
    const listOp = resource.listOp ? byOp.get(resource.listOp) : undefined;

    if (!sampleable.includes(resource) || halt.reason) {
      enriched.push(resource);
      if (!listOp) continue;
      const needs = requiredInputs(listOp);
      unknowns.push({
        resource: resource.id,
        title: resource.title,
        // A scoped endpoint is not a failure — it is a noun that only exists
        // inside another record, and saying so is the actionable version.
        reason: halt.reason ? "aborted" : needs.length > 0 ? "needsParent" : "unsampled",
        recheckOp: resource.listOp!,
        ...(needs.length > 0 ? { needs } : {}),
      });
      continue;
    }

    const outcome = (await take(resource.listOp!))!;

    if (outcome.kind !== "rows" || outcome.fields.length === 0) {
      enriched.push(resource);
      unknowns.push({
        resource: resource.id,
        title: resource.title,
        reason: outcome.kind === "failed" ? "requestFailed" : "empty",
        recheckOp: resource.listOp!,
        ...(outcome.kind === "failed" ? { detail: outcome.message } : {}),
      });
      continue;
    }

    sampled.set(resource.id, outcome.fields);
    const idField = pickIdField(outcome.fields, resource.id);
    const labelField = pickLabelField(outcome.fields);
    enriched.push({
      ...resource,
      ...(idField ? { idField } : {}),
      ...(labelField ? { labelField } : {}),
    });
    if (!idField) {
      notes.push(`No identity field was recognisable on "${resource.title}".`);
    }
  }

  /*
   * Then open a few child collections through a parent's real id.
   *
   * This is the only route to a scoped resource's fields — it has no
   * parameter-free form to call — and it doubles as verification: a 200 turns
   * a relation the URL merely declared into one a request has proved.
   */
  let childBudget = maxChildSamples;
  for (const parent of enriched) {
    if (childBudget <= 0 || halt.reason) break;
    const fields = sampled.get(parent.id);
    if (!fields || !parent.idField) continue;
    const parentId = exampleValue(fields, parent.idField);
    if (parentId === undefined) continue;

    let perParent = maxChildrenPerParent;
    for (const relation of parent.relations) {
      if (childBudget <= 0 || perParent <= 0 || halt.reason) break;
      if (relation.via !== "path" || !relation.op || !relation.param) continue;

      const child = enriched.find((item) => item.id === relation.resource);
      if (!child || sampled.has(child.id)) continue;

      childBudget -= 1;
      perParent -= 1;
      const outcome = await take(relation.op, { [relation.param]: parentId });
      if (!outcome) break;
      if (outcome.kind !== "rows" || outcome.fields.length === 0) {
        unknowns.push({
          resource: child.id,
          title: child.title,
          reason: outcome.kind === "failed" ? "requestFailed" : "empty",
          recheckOp: relation.op,
          needs: [relation.param],
          ...(outcome.kind === "failed" ? { detail: outcome.message } : {}),
        });
        continue;
      }

      sampled.set(child.id, outcome.fields);
      const idField = pickIdField(outcome.fields, child.id);
      const labelField = pickLabelField(outcome.fields);
      Object.assign(child, {
        ...(idField ? { idField } : {}),
        ...(labelField ? { labelField } : {}),
      });
      // A request came back, so the link is no longer merely documented.
      Object.assign(relation, { verified: true });

      /*
       * Now — and only now — the upward link can be written. If the child's
       * rows carry the parent's id, that is a fact a response demonstrated;
       * without it the relation stays one-way rather than pointing at a field
       * that does not exist.
       */
      if (parent.idField) {
        const back = findForeignKeys(outcome.fields, [
          { id: parent.id, idField: parent.idField },
        ])[0];
        if (back) {
          child.relations.push({
            id: `${child.id}-${parent.id}`.slice(0, 64),
            title: parent.title,
            resource: parent.id,
            cardinality: "one",
            localField: back.foreignField,
            via: "filter",
            confidence: "inferred",
            verified: true,
          });
        }
      }
    }
  }

  const drillDowns: DrillDownOffer[] = enriched
    .filter((resource) => resource.detailOp && resource.detailParam && resource.idField)
    .map((resource) => ({
      resource: resource.id,
      title: resource.title,
      listOp: resource.listOp!,
      detailOp: resource.detailOp!,
      idField: resource.idField!,
      detailParam: resource.detailParam!,
      ...(resource.labelField ? { labelField: resource.labelField } : {}),
      sampled: sampled.has(resource.id),
    }));

  /*
   * Joins need identity on both sides, so only sampled resources can offer one.
   *
   * The noun and the path travel with each target because the id alone cannot
   * settle a contested match: ids are unique, so the second `units` collection
   * is called `unit-2`, and that suffix is bookkeeping rather than meaning.
   */
  const targets = enriched
    .filter((resource): resource is ResourceSpec & { idField: string } => Boolean(resource.idField))
    .map((resource) => {
      const listPath = resource.listOp ? byOp.get(resource.listOp)?.path : undefined;
      return {
        id: resource.id,
        idField: resource.idField,
        noun: singularNoun(pathSegments(listPath ?? "").pop() ?? resource.id),
        ...(listPath ? { path: listPath } : {}),
      };
    });

  /* What every path here shares, discounted when judging which noun is meant. */
  const mountDepth = commonPathPrefix([...byOp.values()].map((op) => op.path));

  const joins: JoinOffer[] = [];
  for (const resource of enriched) {
    const fields = sampled.get(resource.id);
    if (!fields) continue;

    const sourcePath = resource.listOp ? byOp.get(resource.listOp)?.path : undefined;
    for (const key of findForeignKeys(
      fields,
      targets.filter((target) => target.id !== resource.id),
      { ...(sourcePath ? { sourcePath } : {}), mountDepth, notes },
    )) {
      const targetResource = enriched.find((item) => item.id === key.resource);
      const filterParam = findFilterParam(
        resource.listOp ? byOp.get(resource.listOp) : undefined,
        key.foreignField,
      );
      joins.push({
        from: resource.id,
        to: key.resource,
        title: `${resource.title} → ${targetResource?.title ?? key.resource}`,
        foreignField: key.foreignField,
        targetField: key.targetField,
        ...(filterParam ? { filterParam } : {}),
        // Without a filter parameter the only route is one request per row.
        needsFanOut: !filterParam,
      });

      /*
       * The same fact, written the other way round: the parent gains a child.
       *
       * A join says "these unit rows carry a property's id". Turned around,
       * that is "a property has units" — a parent-child relation every bit as
       * real as one declared in a URL, just reached by filtering the child's
       * own collection instead of walking into the parent's path.
       *
       * Without this, only APIs that nest children in the URL ever got a
       * drill-down. A nested path did; a top-level collection filtered by
       * the parent's id did not, despite being the more common REST shape and
       * despite the link being known.
       */
      if (targetResource && filterParam && resource.listOp) {
        const already = targetResource.relations.some(
          (relation) => relation.resource === resource.id && relation.cardinality === "many",
        );
        if (!already) {
          targetResource.relations.push({
            id: `${targetResource.id}-${resource.id}s`.slice(0, 64),
            title: resource.title,
            resource: resource.id,
            cardinality: "many",
            foreignField: key.foreignField,
            filterParam,
            via: "filter",
            op: resource.listOp,
            param: filterParam,
            confidence: "inferred",
            verified: true,
          });
        }
      }
    }
  }

  if (callable.length > sampleable.length) {
    notes.push(
      `${sampleable.length} of ${callable.length} collections were sampled; the rest are listed without field detail.`,
    );
  }

  /*
   * A resource is only unknown if it is *still* unknown, and each one is
   * reported once.
   *
   * Reasons accumulate as each pass gives up on something, but a child
   * collection that looked unreachable in the first pass is routinely reached
   * in the second, through its parent. Where both passes had something to say,
   * the later one knows more: "we opened it and it was empty" supersedes "it
   * needs a parent", because by then we had supplied one.
   */
  const latest = new Map<string, UnknownResource>();
  for (const unknown of unknowns) {
    if (sampled.has(unknown.resource)) continue;
    latest.set(unknown.resource, unknown);
  }
  const stillUnknown = [...latest.values()];

  const fieldsByResource: Record<string, readonly string[]> = {};
  for (const [id, fields] of sampled) {
    fieldsByResource[id] = fields.map((field) => field.name);
  }

  /*
   * `budget` and `complete` are both successes; only a stop is not. Saying
   * which lets the UI offer "look deeper" where more is genuinely available,
   * and "try again later" where the API asked us to back off.
   */
  /*
   * A key that is accepted everywhere and permitted nowhere.
   *
   * Reported as an auth problem because that is what the user has to fix, but
   * the note has to say *which* problem: "wrong key" and "key is not allowed
   * to read these resources" lead to completely different places, and only one
   * of them is solved by pasting a new credential.
   */
  if (forbidden > 0 && sampled.size === 0) {
    notes.push(
      `${connection.title} accepted the credential but refused all ${forbidden} endpoint(s) ` +
        "it was tried on (403). The key is valid; it is not permitted to read these " +
        "resources. Check which resources it is scoped to, or use one with wider access.",
    );
  } else if (forbidden > 0) {
    notes.push(
      `${forbidden} endpoint(s) were refused (403) — the credential is valid but not ` +
        "permitted on those. The rest were read normally.",
    );
  }

  const ended: EnumerationOutcome =
    halt.reason?.outcome ??
    (forbidden > 0 && sampled.size === 0
      ? "authRejected"
      : callable.length > sampleable.length
        ? "budget"
        : "complete");

  return {
    ...structure,
    resources: enriched,
    drillDowns,
    joins,
    unknowns: stillUnknown,
    fieldsByResource,
    notes,
    outcome: ended,
    requestsSpent: spent,
    ...(halt.reason?.retryAfter ? { retryAfter: halt.reason.retryAfter } : {}),
  };
};
