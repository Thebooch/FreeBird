import { fakeLlm } from "@freebirdai/dash-agent";
import type { CapabilityReport, ConnectionSpec } from "@freebirdai/dash-spec";
import { capabilityReportSchema, connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { buildConciergeContext } from "./context.js";
import { proposeSetup } from "./propose.js";

/**
 * The two model calls, driven offline.
 *
 * What matters here is not that a model can choose well — that is the model's
 * problem — but that a bad answer from either call fails in a way the user can
 * see and correct, and that neither call is handed more than it needs.
 */

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "list_things", title: "List things", path: "/things" },
    { id: "list_owners", title: "List owners", path: "/owners" },
  ],
  resources: [
    { id: "thing", title: "Thing", listOp: "list_things" },
    { id: "owner", title: "Owner", listOp: "list_owners" },
  ],
});

const report: CapabilityReport = capabilityReportSchema.parse({
  connection: "acme",
  generatedAt: new Date("2026-08-01T00:00:00Z").toISOString(),
  opsFingerprint: "abc123",
  resources: [
    { id: "thing", title: "Thing", idField: "Id", listOp: "list_things", verified: true },
    { id: "owner", title: "Owner", idField: "OwnerId", listOp: "list_owners", verified: true },
  ],
  joins: [
    {
      from: "thing",
      to: "owner",
      title: "Thing → Owner",
      foreignField: "OwnerId",
      targetField: "OwnerId",
      needsFanOut: false,
    },
  ],
  shapes: {
    thing: {
      rowsPath: "$.data",
      rowCount: 4,
      schemaHash: "h1",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 4 },
        { name: "Name", kinds: ["string"], distinct: 4 },
        { name: "Status", kinds: ["string"], distinct: 3 },
        { name: "OwnerId", kinds: ["number"], distinct: 2 },
        { name: "OpenedAt", kinds: ["string"], format: "iso8601", distinct: 4 },
      ],
    },
    owner: {
      rowsPath: "$.data",
      rowCount: 2,
      schemaHash: "h2",
      fields: [
        { name: "OwnerId", kinds: ["number"], distinct: 2 },
        { name: "OwnerName", kinds: ["string"], distinct: 2 },
        { name: "JoinedAt", kinds: ["string"], format: "iso8601", distinct: 2 },
      ],
    },
  },
});

const context = buildConciergeContext({ connections: [connection], reports: [report] });

/** What call B returns for "things by status" — `proposalSchema`'s own shape. */
const binding = {
  component: "metricRow",
  title: "Things by status",
  rowsPath: "$.data",
  labelField: "Status",
  valueField: "Id",
  aggregation: "count",
};

describe("proposeSetup", () => {
  it("picks an endpoint, then binds its fields — two calls, not one", async () => {
    const llm = fakeLlm([
      { args: { primary: "list_things", reason: "Your things, grouped by status." } },
      { args: binding },
    ]);

    const result = await proposeSetup({ llm, intent: "things by status", context });

    expect(llm.calls).toHaveLength(2);
    expect(result.patch.endpoint).toBe("list_things");
    expect(result.patch.connection).toBe("acme");
    expect(result.reason).toBe("Your things, grouped by status.");
  });

  it("shows call A every endpoint and none of their fields", async () => {
    const llm = fakeLlm([
      { args: { primary: "list_things", reason: "things" } },
      { args: binding },
    ]);
    await proposeSetup({ llm, intent: "things", context });

    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("list_things");
    expect(prompt).toContain("list_owners");
    // The field names are the next call's input, and the whole reason this
    // is split in two.
    expect(prompt).not.toContain("OwnerName");
  });

  it("shows call B the chosen endpoint's fields", async () => {
    const llm = fakeLlm([
      { args: { primary: "list_owners", reason: "owners" } },
      { args: { component: "table", title: "Owners", rowsPath: "$.data", columns: ["OwnerName"] } },
    ]);
    await proposeSetup({ llm, intent: "owners", context });

    const prompt = llm.calls[1]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("OwnerName");
  });

  it("joins a second endpoint when the map knows how they relate", async () => {
    const llm = fakeLlm([
      {
        args: {
          primary: "list_things",
          secondary: "list_owners",
          reason: "things with their owners",
        },
      },
      { args: binding },
    ]);

    const result = await proposeSetup({ llm, intent: "things with owner names", context });

    expect(result.patch.joinWith).toEqual({
      endpoint: "list_owners",
      leftField: "OwnerId",
      rightField: "OwnerId",
    });
    expect(result.notes).toEqual([]);
  });

  it("falls back to matching field names when the map declares nothing", async () => {
    /*
     * The map refuses a contested link because it is shared with everyone.
     * Here both endpoints are already named for this one request, so there is
     * nothing left to be wrong about — only which field on each side carries
     * the same value. Without this, "leases alongside their unit" became
     * unanswerable the moment the map stopped claiming to know.
     */
    const noJoins = buildConciergeContext({
      connections: [connection],
      reports: [capabilityReportSchema.parse({ ...report, joins: [] })],
    });
    const llm = fakeLlm([
      { args: { primary: "list_things", secondary: "list_owners", reason: "both" } },
      { args: binding },
    ]);

    const result = await proposeSetup({ llm, intent: "things with owners", context: noJoins });

    // `OwnerId` on the left, `OwnerId` is the owners' own identity on the right.
    expect(result.patch.joinWith).toEqual({
      endpoint: "list_owners",
      leftField: "OwnerId",
      rightField: "OwnerId",
    });
    // And it says it guessed, pointing at the number that would disprove it.
    expect(result.notes.join(" ")).toContain("OwnerId = OwnerId");
    expect(result.notes.join(" ")).toContain("row count");
  });

  it("says so rather than inventing a key when no field pairs either", async () => {
    /*
     * Owners carry OwnerId and OwnerName — nothing named for a thing. There is
     * no convention to fall back on, so the honest answer is that no link was
     * found. Reaching for the next most plausible pair would produce a join
     * that quietly matches on the wrong column, which is the failure worth
     * avoiding; a missing join is recoverable in one sentence.
     */
    const noJoins = buildConciergeContext({
      connections: [connection],
      reports: [capabilityReportSchema.parse({ ...report, joins: [] })],
    });
    const llm = fakeLlm([
      { args: { primary: "list_owners", secondary: "list_things", reason: "both" } },
      { args: { component: "table", title: "Owners", rowsPath: "$.data", columns: ["OwnerName"] } },
    ]);

    const result = await proposeSetup({ llm, intent: "owners with things", context: noJoins });

    expect(result.patch.joinWith).toBeUndefined();
    expect(result.notes.join(" ")).toContain("no field on either side");
  });

  it("keeps the endpoint when the binding call fails", async () => {
    const llm = fakeLlm([
      { args: { primary: "list_things", reason: "things" } },
      { args: { component: "not-a-real-view", title: "Nope", rowsPath: "$.data" } },
    ]);

    const result = await proposeSetup({ llm, intent: "things", context });

    // Half a proposal beats none: the records are right and every remaining
    // decision already has a control on the card.
    expect(result.patch.endpoint).toBe("list_things");
    expect(result.patch.component).toBeUndefined();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("proposes nothing when call A invents an endpoint", async () => {
    const llm = fakeLlm([{ args: { primary: "list_invented", reason: "here" } }]);

    const result = await proposeSetup({ llm, intent: "anything", context });

    expect(result.patch).toEqual({});
    expect(result.notes.join(" ")).toContain("list_invented");
    // Call B is never reached, so a bad pick costs one call rather than two.
    expect(llm.calls).toHaveLength(1);
  });

  it("calls no model at all when nothing is readable", async () => {
    const bare = buildConciergeContext({ connections: [connection], reports: [] });
    const llm = fakeLlm([{ args: { primary: "list_things", reason: "x" } }]);

    const result = await proposeSetup({ llm, intent: "things", context: bare });

    expect(result.patch).toEqual({});
    expect(llm.calls).toHaveLength(0);
  });
});

/* ── two things measured against each other ────────────────────────────── */

describe("a comparison rather than a join", () => {
  const compare = {
    primary: "list_things",
    secondary: "list_owners",
    relationship: "compare",
    reason: "counting both over time",
  };

  it("builds two series instead of forcing a join that has nothing to match", async () => {
    /*
     * The reported failure. Asked for listings per month against applications
     * per month, call A picked both endpoints correctly and the join path had
     * nothing to match them on — so the widget silently became a chart of
     * listings alone, with rent on the value axis.
     */
    const llm = fakeLlm([{ args: compare }, { args: binding }]);
    const result = await proposeSetup({ llm, intent: "things vs owners per month", context });

    // Each side as a shape of its own, over its own date field — the general
    // form, so neither the count nor the time axis is baked into the schema.
    expect(result.patch.shape).toEqual({
      groupBy: [{ field: "OpenedAt", bucket: "{{range.grain}}" }],
      measures: [{ as: "count", agg: "count" }],
      sort: [],
    });
    expect(result.patch.seriesWith).toEqual([
      {
        endpoint: "list_owners",
        label: "List owners",
        shape: {
          groupBy: [{ field: "JoinedAt", bucket: "{{range.grain}}" }],
          measures: [{ as: "count", agg: "count" }],
          sort: [],
        },
      },
    ]);
    expect(result.patch.joinWith).toBeUndefined();
    // A comparison measures each side whatever the binding call proposed.
    expect(result.patch.component).toBe("timeseries");
  });

  it("says so plainly when one side has no date to count by", async () => {
    const undated = buildConciergeContext({
      connections: [connection],
      reports: [
        capabilityReportSchema.parse({
          ...report,
          shapes: {
            ...report.shapes,
            owner: {
              rowsPath: "$.data",
              rowCount: 2,
              schemaHash: "h2",
              fields: [{ name: "OwnerId", kinds: ["number"], distinct: 2 }],
            },
          },
        }),
      ],
    });
    const llm = fakeLlm([{ args: compare }, { args: binding }]);
    const result = await proposeSetup({ llm, intent: "things vs owners", context: undated });

    expect(result.patch.compareWith).toBeUndefined();
    expect(result.notes.join(" ")).toContain("no date field");
  });

  /*
   * The third reading, and the one that had no word for it.
   *
   * "Show all my properties and also my available listings" is not enrichment
   * — neither endpoint's rows are an attribute of the other's — and it is not
   * a comparison, because nothing is being measured. With only two words in
   * the enum the model had to answer "enrich"; the join then found nothing to
   * match on, degraded to the first endpoint, and the reply announced both.
   */
  it("does not attempt a join when the two are simply two things", async () => {
    const llm = fakeLlm([
      { args: { ...compare, relationship: "alongside" } },
      { args: binding },
    ]);
    const result = await proposeSetup({ llm, intent: "my things and also my owners", context });

    expect(result.patch.joinWith).toBeUndefined();
    expect(result.patch.seriesWith).toBeUndefined();
    // Built from the primary, which is a real answer rather than a dead end.
    expect(result.patch.endpoint).toBe("list_things");
  });

  it("names the endpoint it could not include, rather than dropping it silently", async () => {
    const llm = fakeLlm([
      { args: { ...compare, relationship: "alongside" } },
      { args: binding },
    ]);
    const result = await proposeSetup({ llm, intent: "my things and also my owners", context });

    const notes = result.notes.join(" ");
    expect(notes).toContain("List owners");
    expect(notes).toContain("List things");
    // The note has to be usable as a sentence to the user, not a status code.
    expect(notes).toContain("second widget");
  });

  it("still joins when the second endpoint is enriching the first", async () => {
    const llm = fakeLlm([
      { args: { ...compare, relationship: "enrich" } },
      { args: binding },
    ]);
    const result = await proposeSetup({ llm, intent: "things with owner names", context });

    expect(result.patch.joinWith).toBeDefined();
    expect(result.patch.compareWith).toBeUndefined();
  });
});

/**
 * A nested field, proposed and kept.
 *
 * `mapProposal` binds to the flattened column its own widget will carry —
 * `Property_Address_AddressLine1` — while the draft's questions offer the
 * names the endpoint has. A proposal naming the flat form therefore arrived as
 * an answer nobody had offered, and every nested role was silently discarded:
 * the model picked the street address and the answer was thrown away a layer
 * later.
 */
describe("a proposal that binds a nested field", () => {
  it("hands the draft the API's own name, not the flattened column", async () => {
    const nested = buildConciergeContext({
      connections: [connection],
      reports: [
        capabilityReportSchema.parse({
          ...report,
          joins: [],
          shapes: {
            thing: {
              rowsPath: "$.data",
              rowCount: 2,
              schemaHash: "h3",
              fields: [
                { name: "Id", kinds: ["number"], distinct: 2 },
                { name: "Owner", kinds: ["object"], distinct: 2 },
                { name: "Owner.Name", kinds: ["string"], distinct: 2 },
              ],
            },
          },
        }),
      ],
    });

    const llm = fakeLlm([
      { args: { primary: "list_things", reason: "these are the things" } },
      {
        args: {
          title: "Things",
          component: "list",
          rowsPath: "$.data",
          titleField: "Owner.Name",
          metaField: "Id",
        },
      },
    ]);

    const result = await proposeSetup({ llm, intent: "show me the things", context: nested });
    expect(result.patch.roles?.title).toEqual(["Owner.Name"]);
  });
});
