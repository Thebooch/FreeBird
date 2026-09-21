import type { CatalogEntry, EntitySpec } from "@freebirdai/dash-spec";
import { ENTITY_VERSION, catalogEntrySchema, entitySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  entityState,
  mergeDescribedEntities,
  mergeRefreshedOps,
  withDeclaredValues,
} from "./map.js";

/**
 * Re-reading a spec without losing what the map has learned.
 *
 * The two halves of a catalog entry come from different places. Field schemas
 * come from the import and improve whenever the importer does; descriptions
 * and relations come from a model pass that costs money and is the artifact
 * the whole catalog idea rests on. Replacing the entry refreshes the first and
 * destroys the second, which is why this merge exists at all.
 */

const entry = (ops: unknown[]): CatalogEntry =>
  catalogEntrySchema.parse({
    id: "pm",
    title: "Property API",
    baseUrl: "https://api.example.com",
    dialect: { auth: { type: "none" } },
    ops,
  });

const existing = entry([
  {
    id: "list_tasks",
    title: "Retrieve all tasks",
    path: "/v1/tasks",
    description: "Every task on the account, open and closed.",
    // What the old importer read: an object flattened to a string, so the
    // field somebody means by "maintenance" is absent from the whole map.
    fields: [
      { name: "Id", kinds: ["number"] },
      { name: "Category", kinds: ["string"] },
    ],
  },
  { id: "list_gone", title: "Retired", path: "/v1/gone", description: "Removed upstream." },
]);

const fresh = entry([
  {
    id: "list_tasks",
    title: "Retrieve all tasks",
    path: "/v1/tasks",
    params: [{ name: "propertyids", in: "query" }],
    fields: [
      { name: "Id", kinds: ["number"] },
      { name: "Category", kinds: ["object"] },
      { name: "Category.Name", kinds: ["string"] },
    ],
  },
  { id: "list_new", title: "Retrieve all inspections", path: "/v1/inspections" },
]);

describe("mergeRefreshedOps", () => {
  const merged = mergeRefreshedOps(existing, fresh);
  const tasks = merged.find((op) => op.id === "list_tasks");

  it("takes the fresh schemas, which is the point of refreshing", () => {
    expect(tasks?.fields?.map((field) => field.name)).toEqual([
      "Id",
      "Category",
      "Category.Name",
    ]);
    expect(tasks?.fields?.find((field) => field.name === "Category")?.kinds).toEqual(["object"]);
  });

  it("takes the fresh parameters, so a declared filter becomes reachable", () => {
    expect(tasks?.params.map((param) => param.name)).toEqual(["propertyids"]);
  });

  it("keeps a description an import could never supply", () => {
    // Either the API author's own words or something somebody paid a model to
    // write. A re-read of the schema is evidence about neither.
    expect(tasks?.description).toBe("Every task on the account, open and closed.");
  });

  it("picks up endpoints the spec has gained", () => {
    expect(merged.map((op) => op.id)).toContain("list_new");
  });

  it("drops endpoints the spec no longer has", () => {
    // It cannot be called, so keeping its description keeps a description of
    // nothing. Relations pointing at it need no handling here — the graph
    // declines to offer a link whose endpoint is missing.
    expect(merged.map((op) => op.id)).not.toContain("list_gone");
  });
});

/**
 * Is this integration ready?
 *
 * Four counts rather than a flag, because "described" on its own hides the
 * cases that matter: record types with no identity cannot open a page, ones
 * with no display cannot say a record's name, and an API with no references is
 * a set of unrelated lists. A low number here is a specific, fixable thing.
 */
describe("entityState", () => {
  const described = catalogEntrySchema.parse({
    id: "pm",
    title: "Property API",
    baseUrl: "https://api.example.com",
    dialect: { auth: { type: "none" } },
    entityVersion: ENTITY_VERSION,
    entities: [
      {
        id: "task",
        resource: "task",
        name: { one: "Task", many: "Tasks" },
        identity: { field: "Id", observed: true },
        display: { title: ["Title"] },
        fields: [
          { path: "Id" },
          { path: "Title", description: "What the task is called." },
          { path: "VendorId", reference: { entity: "vendor" } },
        ],
      },
      // Named, and nothing more: no identity, no name, no fields.
      { id: "vendor", resource: "vendor", name: { one: "Vendor", many: "Vendors" } },
    ],
  });

  it("counts exactly what everything downstream needs", () => {
    expect(entityState(described)).toEqual({
      described: true,
      stale: false,
      entities: 2,
      withIdentity: 1,
      withName: 1,
      references: 1,
      fieldsDescribed: 1,
      // Nothing here has been near a live account.
      verified: 0,
      referencesVerified: 0,
    });
  });

  it("reports an API nobody has described as undescribed", () => {
    const state = entityState(entry([]));
    expect(state.described).toBe(false);
    expect(state).toMatchObject({ entities: 0, references: 0 });
  });

  it("reports an API with record types as described, stamp or no stamp", () => {
    /*
     * The stamp means "the current pass finished cleanly" — a different
     * question from "are there record types". Read off the stamp, an API with
     * a hundred described record types whose last run was partial was reported
     * as "nothing has been described yet": untrue, and an offer to spend money
     * redoing work already done.
     */
    const partial = catalogEntrySchema.parse({
      ...described,
      entityVersion: undefined,
    });
    expect(entityState(partial).described).toBe(true);
    // Still worth running again — which is what `stale` is for.
    expect(entityState(partial).stale).toBe(true);
  });

  it("does not call an API with no record types described", () => {
    expect(entityState(entry([])).described).toBe(false);
    expect(entityState(entry([])).stale).toBe(false);
  });

  it("does not call the current version stale", () => {
    // Staleness only becomes assertable once the version moves, which is the
    // same position `mapState` is in — the flag is read from the comparison
    // rather than from a claim.
    expect(entityState(described).stale).toBe(false);
  });
});

/**
 * Describing an API again without throwing away what a real account proved.
 *
 * The same shape as the merge above, applied to the half that matters more.
 * A model can write names and descriptions again any time; it cannot produce
 * evidence. Verification comes from real rows on a live account, and a second
 * reading of the same specification is not evidence against it — but it is
 * evidence about a *particular* claim, so it has to lapse when that claim
 * changes.
 */
const entity = (input: Record<string, unknown>): EntitySpec =>
  entitySchema.parse({
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    ...input,
  });

describe("mergeDescribedEntities", () => {
  const proven = entity({
    name: { one: "Job", many: "Jobs" },
    fields: [{ path: "Id" }, { path: "VendorId", reference: { entity: "vendor", verified: true } }],
    identity: { field: "Id", observed: true },
    verified: true,
  });

  it("keeps evidence a live account produced, and takes the newer reading", () => {
    const again = entity({
      fields: [{ path: "Id" }, { path: "VendorId", reference: { entity: "vendor" } }],
      identity: { field: "Id" },
      description: "Something that needs doing.",
    });
    const [merged] = mergeDescribedEntities([proven], [again]);

    expect(merged?.verified).toBe(true);
    expect(merged?.identity?.observed).toBe(true);
    expect(merged?.fields[1]?.reference?.verified).toBe(true);
    // Everything a model writes is taken fresh — a re-run is asked for
    // precisely because the newer reading is wanted.
    expect(merged?.name.one).toBe("Task");
    expect(merged?.description).toBe("Something that needs doing.");
  });

  it("lets verification lapse when the identity moved", () => {
    // The old sighting was of a different field, and says nothing about this.
    const moved = entity({
      fields: [{ path: "Id" }, { path: "Reference" }],
      identity: { field: "Reference" },
    });
    const [merged] = mergeDescribedEntities([proven], [moved]);

    expect(merged?.verified).toBe(false);
    expect(merged?.identity?.observed).toBe(false);
  });

  it("lets a link's verification lapse when it points somewhere else now", () => {
    const repointed = entity({
      fields: [{ path: "Id" }, { path: "VendorId", reference: { entity: "supplier" } }],
      identity: { field: "Id" },
    });
    expect(
      mergeDescribedEntities([proven], [repointed])[0]?.fields[1]?.reference?.verified,
    ).toBe(false);
  });

  it("leaves a record type nobody had described exactly as it arrived", () => {
    const added = entity({ id: "bill", resource: "bill", name: { one: "Bill", many: "Bills" } });
    expect(mergeDescribedEntities([proven], [added])[0]).toEqual(added);
  });

  it("forgets one the fresh description no longer has", () => {
    // Carrying its verification forward would be keeping proof about something
    // that is gone.
    expect(mergeDescribedEntities([proven], [])).toEqual([]);
  });
});

/**
 * Picking up a value the vendor has added, without paying for it.
 *
 * A closed set is stated by the specification, so a re-read settles it
 * outright. Leaving it to the describing pass would mean re-describing a whole
 * API — and rewriting 1,500 descriptions that were fine — to learn that a
 * status now has a fourth value.
 */
describe("withDeclaredValues", () => {
  const entities = [
    entitySchema.parse({
      id: "task",
      resource: "task",
      name: { one: "Task", many: "Tasks" },
      fields: [
        { path: "Id" },
        { path: "Status", values: ["New", "Done"] },
        { path: "Title" },
      ],
    }),
  ];
  const resources = [{ id: "task", title: "Tasks", listOp: "list_tasks", relations: [] }];

  const opsWith = (values: string[] | undefined) => [
    {
      id: "list_tasks",
      title: "Tasks",
      path: "/v1/tasks",
      params: [],
      fields: [
        { name: "Id", kinds: ["number" as const] },
        { name: "Status", kinds: ["string" as const], ...(values ? { values } : {}) },
        // Declared, and the spec says nothing else about it — which is a
        // different thing from the spec not declaring it at all.
        { name: "Title", kinds: ["string" as const] },
      ],
    },
  ];

  it("takes the set the fresh spec declares", () => {
    const [task] = withDeclaredValues(
      entities,
      resources as never,
      opsWith(["New", "InProgress", "Done"]) as never,
    );
    expect(task?.fields.find((field) => field.path === "Status")?.values).toEqual([
      "New",
      "InProgress",
      "Done",
    ]);
  });

  it("drops a set the fresh spec no longer states", () => {
    /*
     * A stale closed set is worse than none: a strip built from one folds
     * everything it missed into a single "Other" tile.
     */
    const [task] = withDeclaredValues(entities, resources as never, opsWith(undefined) as never);
    expect(task?.fields.find((field) => field.path === "Status")?.values).toEqual([]);
  });

  it("drops a field no endpoint declares any more", () => {
    /*
     * The case that forced it: an importer misread a by-id response and put
     * `Number` and `Type` on a record type with forty fields. Re-reading the
     * spec fixed the endpoint; without this the record type kept the two bogus
     * fields until somebody paid to describe the whole API again.
     */
    const withBogus = [
      entitySchema.parse({
        id: "task",
        resource: "task",
        name: { one: "Task", many: "Tasks" },
        fields: [{ path: "Id" }, { path: "Status" }, { path: "Number" }, { path: "Type" }],
      }),
    ];
    const [task] = withDeclaredValues(withBogus, resources as never, opsWith(undefined) as never);
    expect(task?.fields.map((field) => field.path)).toEqual(["Id", "Status"]);
  });

  it("keeps a field the record type points at, even when no endpoint declares it", () => {
    /*
     * Identity, display and views are all validated against the field list, so
     * pruning one they name makes the record type unparseable — and a write
     * meant to fix an entry would fail it instead.
     */
    const referenced = [
      entitySchema.parse({
        id: "task",
        resource: "task",
        name: { one: "Task", many: "Tasks" },
        identity: { field: "Id" },
        display: { title: ["Ghost"] },
        fields: [{ path: "Id" }, { path: "Status" }, { path: "Ghost" }],
      }),
    ];
    const [task] = withDeclaredValues(referenced, resources as never, opsWith(undefined) as never);
    expect(task?.fields.map((field) => field.path)).toContain("Ghost");
  });

  it("prunes nothing when no endpoint declares anything", () => {
    // Ignorance, not evidence — the same rule a link against an unknown row
    // list follows.
    const bare = [
      entitySchema.parse({
        id: "task",
        resource: "task",
        name: { one: "Task", many: "Tasks" },
        fields: [{ path: "Id" }, { path: "Whatever" }],
      }),
    ];
    const ops = [{ id: "list_tasks", title: "Tasks", path: "/v1/tasks", params: [] }];
    const [task] = withDeclaredValues(bare, resources as never, ops as never);
    expect(task?.fields.map((field) => field.path)).toEqual(["Id", "Whatever"]);
  });

  it("leaves a field the spec says nothing about alone", () => {
    const [task] = withDeclaredValues(entities, resources as never, opsWith(["New"]) as never);
    expect(task?.fields.find((field) => field.path === "Title")?.values).toEqual([]);
  });
});
