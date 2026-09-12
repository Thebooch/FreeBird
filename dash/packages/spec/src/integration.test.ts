import { describe, expect, it } from "vitest";
import { integrationDefinitionSchema, relationshipsForEntity } from "./integration.js";

export const integrationFixture = () => integrationDefinitionSchema.parse({
  id: "service", version: "one", title: "Service", protocol: "rest", schemaFingerprint: "abc", origin: "prepared",
  entities: ["work", "supplier"].map(id => ({
    id, title: id, identity: [{ name: "id", field: "id" }],
    fields: [{ id: "id", name: "id", kinds: ["string"] }, { id: "supplier", name: "supplier", kinds: ["string"] }],
  })),
  relationships: [{
    id: "assigned", role: "assigned", source: "work", target: "supplier",
    forward: { title: "Assigned supplier", cardinality: "one", plan: { kind: "unavailable", reason: "Not checked." } },
    reverse: { title: "Assigned work", cardinality: "many", plan: { kind: "unavailable", reason: "No filtered collection." } },
  }],
});

describe("integration relationship contract", () => {
  it("makes both directions available without fabricating reverse retrieval", () => {
    const definition = integrationFixture();
    expect(relationshipsForEntity(definition, "work")[0]).toMatchObject({ target: "supplier", cardinality: "one", direction: "forward" });
    expect(relationshipsForEntity(definition, "supplier")[0]).toMatchObject({ target: "work", cardinality: "many", direction: "reverse", plan: { kind: "unavailable" } });
  });
  it("rejects verification without claim-specific current evidence", () => {
    const definition = integrationFixture();
    definition.relationships[0]!.forward.status = "verified";
    expect(integrationDefinitionSchema.safeParse(definition).success).toBe(false);
  });
  it("rejects private payloads and unknown identity fields", () => {
    expect(integrationDefinitionSchema.safeParse({ ...integrationFixture(), samples: [{ id: "private" }] }).success).toBe(false);
    const definition = integrationFixture();
    definition.entities[0]!.identity[0]!.field = "missing";
    expect(integrationDefinitionSchema.safeParse(definition).success).toBe(false);
  });
  it("preserves distinct roles between the same entities", () => {
    const definition = integrationFixture();
    const other = structuredClone(definition.relationships[0]!);
    other.id = "billing"; other.role = "billing";
    definition.relationships.push(other);
    expect(relationshipsForEntity(integrationDefinitionSchema.parse(definition), "supplier")).toHaveLength(2);
  });
});
