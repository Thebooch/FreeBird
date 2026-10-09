import { describe, expect, it } from "vitest";
import type { ConnectionEntity } from "../api";
import { recordTypeChoices } from "./entities.js";

describe("a connection's record types, as a picker shows them", () => {
  // The shape `GET /api/connections/:id/entities` answers with.
  const list: ConnectionEntity[] = [
    { entity: "vendor", name: { one: "Supplier", many: "Suppliers" }, kind: "party", starting: true, listable: true },
    { entity: "work_order", name: { one: "Work order", many: "Work orders" }, kind: "work", description: "A job to do.", listable: false },
  ];

  it("shows each one's plural name, as text, against the id it stores", () => {
    expect(recordTypeChoices(list)).toEqual([
      { entity: "vendor", name: "Suppliers" },
      { entity: "work_order", name: "Work orders" },
    ]);
  });

  it("offers nothing for a connection with no catalogued record types", () => {
    expect(recordTypeChoices([])).toEqual([]);
  });
});
