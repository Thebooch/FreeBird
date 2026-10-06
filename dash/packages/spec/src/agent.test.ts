import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./access.js";
import { agentInputSchema, agentSchema, dedupeReach, summarizeReach } from "./agent.js";

const at = "2026-10-06T00:00:00.000Z";

describe("agentSchema", () => {
  it("fills in an empty reach and instructions, and starts unarchived", () => {
    const agent = agentSchema.parse({ id: "scout", name: "Scout", color: 3, createdAt: at, updatedAt: at });
    expect(agent).toMatchObject({ instructions: "", reach: [], archived: false });
  });

  it("keeps colour to the eight series hues", () => {
    for (const color of [0, 9, 1.5]) {
      expect(agentSchema.safeParse({ id: "a", name: "A", color, createdAt: at, updatedAt: at }).success).toBe(false);
    }
  });

  it("only lets an agent be given access to records", () => {
    const base = { id: "a", name: "A", color: 1, createdAt: at, updatedAt: at };
    expect(agentSchema.safeParse({ ...base, reach: [{ permission: "records.update", scope: { connection: "pms" } }] }).success).toBe(true);
    expect(agentSchema.safeParse({ ...base, reach: [{ permission: "members.manage" }] }).success).toBe(false);
    expect(agentSchema.safeParse({ ...base, reach: [{ permission: "agents.manage" }] }).success).toBe(false);
  });

  it("has no approval setting of its own", () => {
    const parsed = agentSchema.parse({ id: "a", name: "A", color: 1, createdAt: at, updatedAt: at, requiresApproval: false });
    expect("requiresApproval" in parsed).toBe(false);
  });
});

describe("agentInputSchema", () => {
  it("trims the name and refuses an empty one", () => {
    expect(agentInputSchema.parse({ name: "  Scout ", color: 2 }).name).toBe("Scout");
    expect(agentInputSchema.safeParse({ name: "   ", color: 2 }).success).toBe(false);
  });
});

describe("agents.manage", () => {
  it("belongs to the owner and an admin, and to nobody else by role", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("agents.manage");
    expect(ROLE_PERMISSIONS.admin).toContain("agents.manage");
    expect(ROLE_PERMISSIONS.editor).not.toContain("agents.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("agents.manage");
  });
});

describe("reach", () => {
  it("drops a grant said twice", () => {
    const once = { permission: "records.read", scope: { connection: "pms" } } as const;
    expect(dedupeReach([once, { ...once }, { permission: "records.read", scope: {} }])).toHaveLength(2);
  });

  it("is summarised by where it applies", () => {
    expect(summarizeReach([])).toBe("Touches nothing");
    expect(
      summarizeReach([
        { permission: "records.read", scope: { connection: "pms", entity: "property" } },
        { permission: "records.update", scope: { connection: "pms", entity: "property" } },
      ]),
    ).toBe("read, update · property on pms");
  });
});
