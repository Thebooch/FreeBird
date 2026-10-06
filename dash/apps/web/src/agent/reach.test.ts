import { describe, expect, it } from "vitest";
import { addRow, reachFromRows, removeRow, rowsFromReach, togglePermission } from "./reach.js";

describe("an agent's reach, as rows", () => {
  const reach = [
    { permission: "records.update", scope: { connection: "pms", entity: "property" } },
    { permission: "records.read", scope: { connection: "pms", entity: "property" } },
    { permission: "records.read", scope: { connection: "pms" } },
  ] as const;

  it("groups permissions by place, in the order they are shown", () => {
    const rows = rowsFromReach(reach);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ scope: { connection: "pms", entity: "property" }, permissions: ["records.read", "records.update"] });
  });

  it("round-trips to the same set of grants", () => {
    const back = reachFromRows(rowsFromReach(reach));
    expect(back).toHaveLength(3);
    expect(back).toContainEqual({ permission: "records.update", scope: { connection: "pms", entity: "property" } });
  });

  it("adds a place once, starting with reading, and takes it away", () => {
    const rows = addRow(addRow([], { connection: "pms" }), { connection: "pms" });
    expect(rows).toEqual([{ scope: { connection: "pms" }, permissions: ["records.read"] }]);
    expect(removeRow(rows, { connection: "pms" })).toEqual([]);
  });

  it("toggles one permission in one place and leaves the rest", () => {
    const rows = addRow(addRow([], { connection: "pms" }), {});
    const next = togglePermission(rows, { connection: "pms" }, "records.delete");
    expect(next[0]?.permissions).toEqual(["records.read", "records.delete"]);
    expect(next[1]).toEqual(rows[1]);
    expect(togglePermission(next, { connection: "pms" }, "records.read")[0]?.permissions).toEqual(["records.delete"]);
  });

  it("drops a place with nothing ticked when turned back into a reach", () => {
    expect(reachFromRows([{ scope: { connection: "pms" }, permissions: [] }])).toEqual([]);
  });
});
