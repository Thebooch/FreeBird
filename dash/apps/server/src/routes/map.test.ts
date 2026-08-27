import type { CatalogEntry } from "@freebirdai/dash-spec";
import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { mergeRefreshedOps } from "./map.js";

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
    facet: "Category.Name",
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

  it("keeps a facet, which names a field rather than describing a schema", () => {
    expect(tasks?.facet).toBe("Category.Name");
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
