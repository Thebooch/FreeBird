import type { ConciergeContext } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { bindingFor, expansionFor, readBindings, referencesFrom } from "./bindings.js";

/**
 * The claim this file has to keep honest: nothing here knows an API.
 *
 * So the fixture is two APIs that have nothing in common — different nouns,
 * different id fields, different parameter names, different URL shapes — and
 * the same code derives both. If a rule about one vendor ever creeps in, one
 * of these two stops working.
 */

const context = (over: Partial<ConciergeContext> = {}): ConciergeContext =>
  ({
    connections: [
      { id: "field-ops", title: "Field Ops" },
      { id: "helpdesk", title: "Helpdesk" },
    ],
    ops: [
      {
        id: "list_jobs",
        title: "All jobs",
        connection: "field-ops",
        path: "/v2/jobs",
        description: "Scheduled work",
      },
      {
        id: "sites",
        title: "Sites",
        connection: "field-ops",
        path: "/v2/sites",
      },
      {
        id: "tickets.list",
        title: "Conversations",
        connection: "helpdesk",
        path: "/api/tickets",
        description: "Support threads",
      },
    ],
    shapes: {},
    joins: [],
    drillDowns: [
      {
        resource: "job",
        title: "Job",
        listOp: "list_jobs",
        detailOp: "get_job",
        idField: "JobNumber",
        detailParam: "jobId",
      },
      {
        resource: "site",
        title: "Site",
        listOp: "sites",
        detailOp: "site",
        idField: "uuid",
        detailParam: "site",
      },
      {
        resource: "conversation",
        title: "Conversation",
        listOp: "tickets.list",
        detailOp: "tickets.get",
        idField: "reference",
        detailParam: "ref",
      },
    ],
    children: [],
    searchable: [],
    rangeFilterable: [],
    readPlans: [],
    ...over,
  }) as unknown as ConciergeContext;

describe("readBindings", () => {
  it("derives an openable record for every drill-down, on any API shape", () => {
    const bindings = readBindings({ context: context() });
    expect(bindings.map((binding) => binding.id).sort()).toEqual([
      "conversation",
      "job",
      "site",
    ]);

    // Two APIs that agree on nothing, read by one rule.
    expect(bindings.find((binding) => binding.id === "job")).toMatchObject({
      verb: "read",
      connection: "field-ops",
      connectionTitle: "Field Ops",
      op: "get_job",
      idParam: "jobId",
      idField: "JobNumber",
      listOp: "list_jobs",
      describes: "Scheduled work",
    });
    expect(bindings.find((binding) => binding.id === "conversation")).toMatchObject({
      connection: "helpdesk",
      op: "tickets.get",
      idParam: "ref",
      idField: "reference",
    });
  });

  /*
   * The regression this caught, and the reason the fixture omits detail ops:
   * `ConciergeContext.ops` lists only endpoints callable with no id, so a
   * record endpoint is never in it. Deriving from the detail op produced zero
   * bindings against a real API with eighty-two openable records.
   */
  it("derives from the collection, since record endpoints are not listed as ops", () => {
    const bindings = readBindings({ context: context() });
    expect(bindings.map((binding) => binding.op).sort()).toEqual([
      "get_job",
      "site",
      "tickets.get",
    ]);
  });

  it("falls back to the URL when the API described nothing", () => {
    const bindings = readBindings({ context: context() });
    expect(bindings.find((binding) => binding.id === "site")?.describes).toBe("/v2/sites");
  });

  /*
   * Qualified only on collision, the same rule widget handles follow: "task"
   * reads as a thing and "task--acme" reads as configuration, so the second is
   * worth paying only where the first is ambiguous.
   */
  it("qualifies a noun only when two connections both have it", () => {
    const shared = context({
      drillDowns: [
        {
          resource: "conversation",
          title: "Job",
          listOp: "list_jobs",
          detailOp: "get_job",
          idField: "JobNumber",
          detailParam: "jobId",
        },
        {
          resource: "conversation",
          title: "Conversation",
          listOp: "tickets.list",
          detailOp: "tickets.get",
          idField: "reference",
          detailParam: "ref",
        },
      ],
    } as Partial<ConciergeContext>);
    expect(readBindings({ context: shared }).map((binding) => binding.id).sort()).toEqual([
      "conversation--field-ops",
      "conversation--helpdesk",
    ]);
  });

  it("restricts to one connection when asked — the direct request", () => {
    const bindings = readBindings({ context: context(), connection: "helpdesk" });
    expect(bindings.map((binding) => binding.id)).toEqual(["conversation"]);
  });

  it("offers nothing rather than guessing when an API exposes no record endpoint", () => {
    expect(readBindings({ context: context({ drillDowns: [] }) })).toEqual([]);
  });

  it("drops a duplicate mapping rather than offering the same handle twice", () => {
    const twice = context({
      drillDowns: [
        ...context().drillDowns,
        {
          resource: "job",
          title: "Job again",
          listOp: "list_jobs",
          detailOp: "get_job",
          idField: "JobNumber",
          detailParam: "jobId",
        },
      ],
    } as Partial<ConciergeContext>);
    expect(readBindings({ context: twice }).filter((binding) => binding.id === "job")).toHaveLength(1);
  });
});

describe("expansionFor", () => {
  /*
   * The transcript's fix, in one assertion: rows came from the collection, and
   * this is what turns them into the record.
   */
  it("finds the record endpoint behind a collection", () => {
    const bindings = readBindings({ context: context() });
    expect(expansionFor(bindings, "tickets.list")?.op).toBe("tickets.get");
    expect(expansionFor(bindings, "list_jobs")?.op).toBe("get_job");
  });

  it("is null for a collection with no record endpoint", () => {
    expect(expansionFor(readBindings({ context: context() }), "something_else")).toBeNull();
  });
});

describe("bindingFor", () => {
  it("resolves a handle against the list and never approximates", () => {
    const bindings = readBindings({ context: context() });
    expect(bindingFor(bindings, "job")?.op).toBe("get_job");
    expect(bindingFor(bindings, "jobs")).toBeNull();
  });
});

describe("referencesFrom", () => {
  /*
   * Only proven links. A field that merely looks like a foreign key is not
   * evidence — a wrong reference opens an unrelated record and reads exactly
   * like a right one.
   */
  it("reads a proven join as a way to open the other record", () => {
    const linked = context({
      joins: [
        {
          id: "job-site",
          fromOp: "list_jobs",
          toOp: "sites",
          title: "Site",
          leftField: "SiteRef",
          rightField: "uuid",
          fetch: { mode: "filtered" },
        },
      ],
    } as Partial<ConciergeContext>);
    const bindings = readBindings({ context: linked });
    const references = referencesFrom(linked, "list_jobs", bindings);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ field: "SiteRef", kind: "scalar" });
    expect(references[0]?.to.id).toBe("site");
  });

  it("reads a child collection's parent field the same way", () => {
    const linked = context({
      children: [
        {
          id: "job-of-site",
          parentOp: "sites",
          title: "Jobs here",
          op: "list_jobs",
          parentIdField: "JobIds",
          linkKind: "array",
        },
      ],
    } as Partial<ConciergeContext>);
    const references = referencesFrom(linked, "sites", readBindings({ context: linked }));
    expect(references[0]).toMatchObject({ field: "JobIds", kind: "array" });
  });

  it("offers nothing when the link points at something that cannot be opened", () => {
    const linked = context({
      drillDowns: [],
      joins: [
        {
          id: "job-site",
          fromOp: "list_jobs",
          toOp: "sites",
          title: "Site",
          leftField: "SiteRef",
          rightField: "uuid",
          fetch: { mode: "filtered" },
        },
      ],
    } as Partial<ConciergeContext>);
    expect(referencesFrom(linked, "list_jobs", readBindings({ context: linked }))).toEqual([]);
  });

  it("does not offer the same field twice", () => {
    const linked = context({
      joins: [
        {
          id: "a",
          fromOp: "list_jobs",
          toOp: "sites",
          title: "Site",
          leftField: "SiteRef",
          rightField: "uuid",
          fetch: { mode: "filtered" },
        },
        {
          id: "b",
          fromOp: "list_jobs",
          toOp: "site",
          title: "Site again",
          leftField: "SiteRef",
          rightField: "uuid",
          fetch: { mode: "filtered" },
        },
      ],
    } as Partial<ConciergeContext>);
    expect(referencesFrom(linked, "list_jobs", readBindings({ context: linked }))).toHaveLength(1);
  });
});
