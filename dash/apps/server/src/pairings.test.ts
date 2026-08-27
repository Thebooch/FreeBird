import type { FieldInfo } from "@freebirdai/dash-agent";
import type { Capabilities } from "./capabilities.js";
import type { ResourceSpec } from "@freebirdai/dash-spec";
import { connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  type SampleFn,
  applyPairings,
  fromReport,
  mergeStoredRelations,
  toReport,
  verifyPairings,
  withVerifiedParams,
} from "./capabilities.js";

/**
 * A model's guess about how two resources link, checked against the API.
 *
 * The fixtures stay deliberately anonymous — `alpha` and `beta` — because the
 * whole point of this layer is that it works on an API whose domain nobody
 * here knows. Naming them after a real business would let a rule that only
 * holds for that business pass unnoticed.
 */

const instant = { sleep: async () => {} };

const field = (name: string, ...kinds: string[]): FieldInfo =>
  ({
    name,
    kinds: kinds.length > 0 ? kinds : ["string"],
    nullable: false,
    distinct: 1,
    samples: [],
  }) as unknown as FieldInfo;

const resource = (spec: Partial<ResourceSpec> & { id: string }): ResourceSpec =>
  ({
    title: spec.id,
    relations: [],
    confidence: "declared",
    verified: true,
    ...spec,
  }) as unknown as ResourceSpec;

const parent = resource({
  id: "alpha",
  title: "Alpha",
  listOp: "alphas",
  detailOp: "alpha",
  detailParam: "alphaId",
  idField: "Id",
});

const child = resource({ id: "beta", title: "Beta", listOp: "betas" });

/** Every endpoint answers with the same columns. */
const rows =
  (...fields: FieldInfo[]): SampleFn =>
  async () => ({ kind: "rows", rowCount: 3, fields });

const propose = [{ parent: "alpha", child: "beta", linkField: "AlphaId" }];

describe("verifyPairings", () => {
  it("accepts the model's field when the child really has it", async () => {
    const [result] = await verifyPairings(
      propose,
      [parent, child],
      {},
      rows(field("Id"), field("AlphaId"), field("Name")),
      instant,
    );
    expect(result).toMatchObject({ ok: true, linkField: "AlphaId" });
  });

  it("corrects a capitalisation difference rather than rejecting it", async () => {
    const [result] = await verifyPairings(
      [{ parent: "alpha", child: "beta", linkField: "alphaid" }],
      [parent, child],
      {},
      rows(field("Id"), field("AlphaId")),
      instant,
    );
    // Answered as the API spells it, so the binding it produces actually works.
    expect(result).toMatchObject({ ok: true, linkField: "AlphaId" });
  });

  it("repairs the model's habit of answering with the child's own id", async () => {
    const [result] = await verifyPairings(
      [{ parent: "alpha", child: "beta", linkField: "Id" }],
      [parent, child],
      {},
      rows(field("Id"), field("AlphaId")),
      instant,
    );
    expect(result).toMatchObject({ ok: true, linkField: "AlphaId" });
  });

  it("takes the only foreign key when the nouns do not match", async () => {
    const [result] = await verifyPairings(
      [{ parent: "alpha", child: "beta", linkField: "Nonsense" }],
      [parent, child],
      {},
      rows(field("Id"), field("OwnerRef_id"), field("Name")),
      instant,
    );
    expect(result).toMatchObject({ ok: true, linkField: "OwnerRef_id" });
  });

  it("reports ambiguity instead of picking one of several links", async () => {
    const [result] = await verifyPairings(
      [{ parent: "alpha", child: "beta", linkField: "Nonsense" }],
      [parent, child],
      {},
      rows(field("Id"), field("OwnerId"), field("RegionId")),
      instant,
    );
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/OwnerId, RegionId/);
  });

  it("drops a pairing whose child carries nothing linking back", async () => {
    const [result] = await verifyPairings(
      propose,
      [parent, child],
      {},
      rows(field("Id"), field("Name"), field("Total")),
      instant,
    );
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/nothing linking back/);
  });

  it("learns the parent's identity rather than giving up on an unread parent", async () => {
    const asked: string[] = [];
    const sample: SampleFn = async (opId) => {
      asked.push(opId);
      return {
        kind: "rows",
        rowCount: 1,
        fields: opId === "alphas" ? [field("Id"), field("Name")] : [field("Id"), field("AlphaId")],
      };
    };

    const [result] = await verifyPairings(
      propose,
      [resource({ ...parent, idField: undefined }), child],
      {},
      sample,
      instant,
    );
    expect(asked).toEqual(["alphas", "betas"]);
    expect(result).toMatchObject({ ok: true, linkField: "AlphaId" });
  });

  it("spends nothing on a child whose fields are already known", async () => {
    let calls = 0;
    const sample: SampleFn = async () => {
      calls += 1;
      return { kind: "failed", message: "should not have been called" };
    };

    const [result] = await verifyPairings(
      propose,
      [parent, child],
      { beta: [field("Id"), field("AlphaId")] },
      sample,
      instant,
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: true, linkField: "AlphaId" });
  });

  it("refuses a child that has no collection of its own", async () => {
    const [result] = await verifyPairings(
      propose,
      [parent, resource({ ...child, listOp: undefined })],
      {},
      rows(field("Id")),
      instant,
    );
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/no collection to filter/);
  });
});

describe("applyPairings", () => {
  const confirmed = [{ parent: "alpha", child: "beta", linkField: "AlphaId", ok: true }];

  /** The child's collection, with and without a way to narrow it. */
  const listOps = (queryParams: string[]) =>
    [
      { id: "betas", params: queryParams.map((name) => ({ name, in: "query" })) },
    ] as unknown as Parameters<typeof applyPairings>[2];

  it("records the verified column, and no parameter the endpoint never declared", () => {
    /*
     * The bug this pins, and it looked entirely healthy: the verified column
     * was written into `param` as well, so the request went out with an
     * invented query parameter. An API is free to ignore one — most answer 200
     * with the whole collection — so every drill-down opened on every record
     * in the account while reporting success.
     */
    const [alpha] = applyPairings([parent, child], confirmed, listOps([]));
    expect(alpha?.relations).toHaveLength(1);
    expect(alpha?.relations[0]).toMatchObject({
      resource: "beta",
      via: "filter",
      op: "betas",
      foreignField: "AlphaId",
      // A model read the nouns; a request proved the field.
      confidence: "inferred",
      verified: true,
    });
    expect(alpha?.relations[0]?.param).toBeUndefined();
    expect(alpha?.relations[0]?.filterParam).toBeUndefined();
  });

  it("uses the endpoint's own parameter when it really has one", () => {
    const [alpha] = applyPairings([parent, child], confirmed, listOps(["alphaId"]));
    expect(alpha?.relations[0]).toMatchObject({
      foreignField: "AlphaId",
      param: "alphaId",
      filterParam: "alphaId",
    });
  });

  it("accepts the plural spelling APIs commonly use for an id filter", () => {
    // `?alphaids=` narrows by the same key; refusing it would fetch everything
    // and filter in the browser for no reason.
    const [alpha] = applyPairings([parent, child], confirmed, listOps(["alphaIds"]));
    expect(alpha?.relations[0]?.param).toBe("alphaIds");
  });

  it("replaces an earlier inference, so a wrong link is not permanent", () => {
    const stale = resource({
      ...parent,
      relations: [
        {
          id: "alpha-betas",
          title: "Beta",
          resource: "beta",
          cardinality: "many",
          via: "filter",
          op: "betas",
          param: "Id",
          confidence: "inferred",
          verified: false,
        },
      ],
    } as unknown as Partial<ResourceSpec> & { id: string });

    const [alpha] = applyPairings([stale, child], confirmed);
    expect(alpha?.relations).toHaveLength(1);
    expect(alpha?.relations[0]).toMatchObject({ foreignField: "AlphaId", verified: true });
    expect(alpha?.relations[0]?.param).toBeUndefined();
  });

  it("leaves a URL-declared relation alone — the API said so itself", () => {
    const declared = resource({
      ...parent,
      relations: [
        {
          id: "alpha-betas",
          title: "Beta",
          resource: "beta",
          cardinality: "many",
          via: "path",
          op: "alpha-betas",
          param: "alphaId",
          confidence: "declared",
          verified: true,
        },
      ],
    } as unknown as Partial<ResourceSpec> & { id: string });

    const [alpha] = applyPairings([declared, child], confirmed);
    expect(alpha?.relations).toHaveLength(1);
    expect(alpha?.relations[0]).toMatchObject({ via: "path", op: "alpha-betas" });
  });

  it("ignores rejected pairings entirely", () => {
    const [alpha] = applyPairings(
      [parent, child],
      [{ parent: "alpha", child: "beta", linkField: "AlphaId", ok: false, reason: "no" }],
    );
    expect(alpha?.relations).toEqual([]);
  });

  it("survives being written to a report and read back", () => {
    /*
     * The point of the write-back: the reasoning is paid for once. If the
     * relation does not round-trip through the persisted report, the next
     * caller re-runs the model and the whole exercise is a per-request cost.
     */
    const connection = connectionSchema.parse({
      id: "api",
      title: "API",
      kind: "rest",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer", keyRef: "k" },
      ops: [
        { id: "alphas", title: "Alphas", path: "/alphas" },
        { id: "alpha", title: "Alpha", path: "/alphas/{{param.alphaId}}" },
        { id: "betas", title: "Betas", path: "/betas" },
      ],
      validateOpId: "alphas",
    });

    const capabilities = {
      connection: "api",
      resources: applyPairings([parent, child], confirmed),
      drillDowns: [],
      joins: [],
      unknowns: [],
      searchable: [],
      rangeFilterable: [],
      fieldsByResource: {},
      notes: [],
      outcome: "complete",
      requestsSpent: 2,
    } as unknown as Capabilities;

    const restored = fromReport(toReport(connection, capabilities, {}));
    const alpha = restored.value.resources.find((item) => item.id === "alpha");
    expect(alpha?.relations[0]).toMatchObject({
      resource: "beta",
      via: "filter",
      foreignField: "AlphaId",
      verified: true,
    });
  });
});

/**
 * A correction has to outlive the next pass, or it is not a correction.
 */
describe("mergeStoredRelations", () => {
  const ops = [
    { id: "alphas" },
    { id: "alpha" },
    { id: "betas" },
  ] as unknown as Parameters<typeof mergeStoredRelations>[2];

  const link = (over: Record<string, unknown> = {}) =>
    ({
      id: "alpha-betas",
      title: "Beta",
      resource: "beta",
      cardinality: "many",
      via: "filter",
      op: "betas",
      param: "AlphaId",
      confidence: "inferred",
      verified: true,
      ...over,
    }) as never;

  it("prefers the saved link over the one just derived", () => {
    const derived = [resource({ ...parent, relations: [link({ param: "Guess" })] }), child];
    const stored = [resource({ ...parent, relations: [link({ param: "Corrected" })] })];

    const [alpha] = mergeStoredRelations(derived, stored, ops);
    expect(alpha?.relations).toHaveLength(1);
    expect(alpha?.relations[0]).toMatchObject({ param: "Corrected" });
  });

  it("keeps derived links to children the saved graph never mentioned", () => {
    /*
     * Merged per child rather than wholesale: adding an endpoint has to keep
     * contributing what its URL declares, instead of being masked by a saved
     * graph that predates it.
     */
    const gamma = resource({ id: "gamma", title: "Gamma", listOp: "gammas" });
    const derived = [
      resource({
        ...parent,
        relations: [link(), link({ id: "alpha-gammas", resource: "gamma", op: "betas" })],
      }),
      child,
      gamma,
    ];
    const stored = [resource({ ...parent, relations: [link({ param: "Corrected" })] })];

    const [alpha] = mergeStoredRelations(derived, stored, ops);
    expect(alpha?.relations.map((relation) => relation.resource).sort()).toEqual([
      "beta",
      "gamma",
    ]);
  });

  it("drops a saved link whose endpoint no longer exists", () => {
    // It cannot be fetched, so offering it would build a widget that fails at
    // render rather than one that is merely wrong.
    const derived = [resource({ ...parent, relations: [] }), child];
    const stored = [resource({ ...parent, relations: [link({ op: "deleted-endpoint" })] })];

    expect(mergeStoredRelations(derived, stored, ops)[0]?.relations).toEqual([]);
  });

  it("drops a saved link whose target resource is gone", () => {
    const derived = [resource({ ...parent, relations: [] })];
    const stored = [resource({ ...parent, relations: [link({ resource: "vanished" })] })];

    expect(mergeStoredRelations(derived, stored, ops)[0]?.relations).toEqual([]);
  });

  it("leaves a graph alone when nothing has been saved", () => {
    const derived = [resource({ ...parent, relations: [link()] }), child];
    expect(mergeStoredRelations(derived, [], ops)).toEqual(derived);
  });
});

/**
 * A stored report is data written by an earlier version of this code.
 */
describe("withVerifiedParams", () => {
  const ops = (queryParams: string[]) =>
    [
      { id: "betas", params: queryParams.map((name) => ({ name, in: "query" })) },
    ] as unknown as Parameters<typeof withVerifiedParams>[1];

  const link = (over: Record<string, unknown> = {}) =>
    ({
      id: "alpha-betas",
      title: "Beta",
      resource: "beta",
      cardinality: "many",
      via: "filter",
      op: "betas",
      confidence: "inferred",
      verified: true,
      ...over,
    }) as never;

  it("drops a parameter the endpoint never declared, keeping the link", () => {
    /*
     * The case that forced this to be an invariant rather than a write-time
     * check: the bad value was already in a stored report, and nothing would
     * rewrite it — the model can see the link in the map it is given, so it
     * correctly declines to propose it a second time.
     */
    const stale = resource({
      ...parent,
      relations: [link({ param: "AlphaId", filterParam: "AlphaId" })],
    } as unknown as Partial<ResourceSpec> & { id: string });

    const [alpha] = withVerifiedParams([stale], ops([]));
    expect(alpha?.relations).toHaveLength(1);
    expect(alpha?.relations[0]?.param).toBeUndefined();
    expect(alpha?.relations[0]?.filterParam).toBeUndefined();
    // Kept as the matching column, so the link still works — by sifting rows.
    expect(alpha?.relations[0]?.foreignField).toBe("AlphaId");
  });

  it("leaves a parameter the endpoint really declares", () => {
    const good = resource({
      ...parent,
      relations: [link({ param: "alphaId", filterParam: "alphaId", foreignField: "AlphaId" })],
    } as unknown as Partial<ResourceSpec> & { id: string });

    expect(withVerifiedParams([good], ops(["alphaId"]))[0]?.relations[0]).toMatchObject({
      param: "alphaId",
      filterParam: "alphaId",
    });
  });

  it("never touches a path relation — the URL is the API's own statement", () => {
    const declared = resource({
      ...parent,
      relations: [link({ via: "path", op: "alpha-betas", param: "alphaId" })],
    } as unknown as Partial<ResourceSpec> & { id: string });

    expect(withVerifiedParams([declared], ops([]))[0]?.relations[0]?.param).toBe("alphaId");
  });
});
