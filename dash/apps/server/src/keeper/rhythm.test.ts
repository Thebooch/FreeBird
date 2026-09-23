import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionSpec } from "@freebirdai/dash-spec";
import { DEFAULT_TIERS, connectionRhythmSchema, connectionSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RhythmStore } from "../rhythm-store.js";
import { decideAll, decideTier, mergeApiRhythm, opsOfResource, volatilityByOp } from "./rhythm.js";

/**
 * Turning "new applications arrive all day" into "ask this endpoint again in
 * ten minutes".
 *
 * The model answers about record types because that is the only vocabulary
 * anybody can reason in; a request is made to an endpoint. This is that
 * translation, and the tests are mostly about what must not be lost in it.
 */

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "applicants", title: "Applicants", path: "/v1/applicants" },
    { id: "applicant", title: "Applicant", path: "/v1/applicants/{{param.id}}" },
    { id: "vendors", title: "Vendors", path: "/v1/vendors" },
    { id: "orphan", title: "Something else", path: "/v1/other" },
  ],
  resources: [
    { id: "applicant", title: "Applicants", listOp: "applicants", detailOp: "applicant" },
    { id: "vendor", title: "Vendors", listOp: "vendors" },
    /* Described on the API but not carried by this connection. */
    { id: "ghost", title: "Ghosts" },
  ],
});

const api = {
  recordTypes: { applicant: "constant" as const, vendor: "rare" as const, ghost: "constant" as const },
  because: { applicant: "new applications arrive all day" },
  at: "2026-09-22T00:00:00.000Z",
  version: 1,
};

const personal = connectionRhythmSchema.parse({ tiers: [...DEFAULT_TIERS] });

describe("projecting a record type onto its endpoints", () => {
  /* Both the list and the detail: warming a record type means being able to
   * draw it and to open one, and they are separate requests. */
  it("covers every endpoint a record type is read through", () => {
    expect(opsOfResource(connection, "applicant")).toEqual(["applicants", "applicant"]);
  });

  it("ignores an endpoint this connection does not carry", () => {
    expect(opsOfResource(connection, "ghost")).toEqual([]);
  });

  it("keys the shared reading by endpoint", () => {
    expect(volatilityByOp({ connection, api })).toEqual({
      applicants: "constant",
      applicant: "constant",
      vendors: "rare",
    });
  });
});

describe("decideTier", () => {
  it("reads the API's own classification", () => {
    expect(decideTier({ connection, api, personal, op: "applicants" })).toMatchObject({
      tier: "live",
      source: "model",
      because: "new applications arrive all day",
    });
    expect(decideTier({ connection, api, personal, op: "vendors" })).toMatchObject({
      tier: "daily",
      source: "model",
    });
  });

  it("puts an endpoint nothing classified on the quick tier", () => {
    expect(decideTier({ connection, api, personal, op: "orphan" })).toMatchObject({
      tier: "live",
      source: "default",
    });
  });

  it("lets this account disagree without changing anybody else's", () => {
    const moved = connectionRhythmSchema.parse({
      tiers: [...DEFAULT_TIERS],
      overrides: { applicants: "daily" },
    });
    expect(decideTier({ connection, api, personal: moved, op: "applicants" })).toMatchObject({
      tier: "daily",
      source: "override",
    });
    /* The shared reading is untouched — it is a fact about the API. */
    expect(api.recordTypes.applicant).toBe("constant");
  });

  it("says everything is on the default before any pass has run", () => {
    const decisions = decideAll({
      connection,
      personal,
      ops: connection.ops.map((op) => op.id),
    });
    expect(decisions.every((one) => one.source === "default")).toBe(true);
    expect(decisions.every((one) => one.tier === "live")).toBe(true);
  });
});

describe("mergeApiRhythm", () => {
  /* A re-run that covers less than the last one must not lose what was
   * already settled — the same bargain every other pass here makes. */
  it("keeps what an earlier pass established", () => {
    const merged = mergeApiRhythm(api, {
      rhythm: { vendor: "daily" },
      because: { vendor: "vendors are added when somebody is hired" },
    });
    expect(merged.recordTypes).toMatchObject({ applicant: "constant", vendor: "daily" });
    expect(merged.because.applicant).toBe("new applications arrive all day");
  });

  it("starts from nothing on an API nobody has read", () => {
    const merged = mergeApiRhythm(undefined, { rhythm: { task: "constant" }, because: {} });
    expect(merged.recordTypes).toEqual({ task: "constant" });
  });
});

describe("RhythmStore", () => {
  let dir: string;
  let store: RhythmStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-rhythm-"));
    store = new RhythmStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("answers with the shipped cadences before anybody has chosen", () => {
    expect(store.get("acme").tiers.map((tier) => tier.id)).toEqual(["live", "daily"]);
  });

  it("remembers what somebody moved", () => {
    store.override("acme", "vendors", "daily");
    expect(store.get("acme").overrides).toEqual({ vendors: "daily" });
  });

  /* Recording agreement would freeze today's reading into one person's file,
   * so a better pass later would reach everybody except the people who had
   * already confirmed it. */
  it("removes an override rather than storing agreement", () => {
    store.override("acme", "vendors", "daily");
    store.override("acme", "vendors", null);
    expect(store.get("acme").overrides).toEqual({});
  });

  it("keeps one connection's choices out of another's", () => {
    store.override("acme", "vendors", "daily");
    expect(store.get("other").overrides).toEqual({});
  });

  it("stamps when it was answered, so the question is not asked again", () => {
    expect(store.override("acme", "vendors", "daily").at).toBeTruthy();
  });
});
