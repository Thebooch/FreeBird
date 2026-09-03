import { describe, expect, it, vi } from "vitest";
import { composeSkillProviders } from "./compose.js";
import { dbSkillProvider } from "./provider.js";
import type { Skill, SkillProvider } from "./types.js";
import { buildSkillsPrompt, selectSkills } from "../chat/skills-context.js";
import { MemoryDb } from "../testing/memoryDb.js";
import type { DbAdapter } from "../adapters/db.js";
import { requireSkills } from "../adapters/db.js";

const skill = (id: string, over: Partial<Skill> = {}): Skill => ({
  id,
  body: `Body of ${id}`,
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  auth: { userId: "u1" },
  sessionId: "s1",
  text: "hello",
  activeComponentIds: [] as readonly string[],
  ...over,
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("selectSkills", () => {
  it("always includes an unscoped skill", () => {
    expect(selectSkills([skill("a")], []).map((s) => s.id)).toEqual(["a"]);
  });

  it("includes a scoped skill only when its component is active", () => {
    const scoped = [skill("refund", { appliesTo: ["orders"] })];
    expect(selectSkills(scoped, [])).toEqual([]);
    expect(selectSkills(scoped, ["profile"])).toEqual([]);
    expect(selectSkills(scoped, ["orders"]).map((s) => s.id)).toEqual(["refund"]);
  });

  it("treats an empty appliesTo as unscoped rather than never-applies", () => {
    expect(selectSkills([skill("a", { appliesTo: [] })], []).map((s) => s.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("buildSkillsPrompt", () => {
  it("emits nothing at all when there are no skills", () => {
    expect(buildSkillsPrompt([])).toBe("");
  });

  it("emits nothing when every skill is scoped away", () => {
    // The whole point of scoping: a large library costs nothing on the turns
    // it does not apply to.
    expect(buildSkillsPrompt([skill("a", { appliesTo: ["orders"] })], {})).toBe("");
  });

  it("renders title, description and body", () => {
    const out = buildSkillsPrompt([
      skill("refund", { title: "Refunds", description: "How to handle one." }),
    ]);
    expect(out).toContain("### Refunds");
    expect(out).toContain("How to handle one.");
    expect(out).toContain("Body of refund");
  });

  it("falls back to the id when there is no title", () => {
    expect(buildSkillsPrompt([skill("refund")])).toContain("### refund");
  });

  it("tells the model these are instructions, not citable facts", () => {
    expect(buildSkillsPrompt([skill("a")])).toContain("do not cite");
  });

  it("respects its own budget and truncates rather than overruns", () => {
    const big = [skill("a", { body: "x".repeat(5000) }), skill("b", { body: "y".repeat(5000) })];
    const out = buildSkillsPrompt(big, { maxChars: 2000 });
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("...");
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("composeSkillProviders", () => {
  const defaults: SkillProvider = () => [skill("greet"), skill("refund", { title: "Default" })];
  const tenant: SkillProvider = () => [skill("refund", { title: "Tenant override" })];

  it("layers, with later providers winning on id", async () => {
    const provider = composeSkillProviders(defaults, tenant);
    const out = await provider(ctx());
    expect(out.map((s) => s.id).sort()).toEqual(["greet", "refund"]);
    expect(out.find((s) => s.id === "refund")?.title).toBe("Tenant override");
  });

  it("keeps going when one provider fails", async () => {
    const broken: SkillProvider = () => {
      throw new Error("db down");
    };
    const out = await composeSkillProviders(defaults, broken)(ctx());
    expect(out.map((s) => s.id).sort()).toEqual(["greet", "refund"]);
  });

  it("composes to nothing when given nothing", async () => {
    expect(await composeSkillProviders()(ctx())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("requireSkills", () => {
  it("names the missing methods rather than failing obscurely", () => {
    expect(() => requireSkills({} as DbAdapter)).toThrow(/listSkills\/putSkill\/deleteSkill/);
  });

  it("narrows an adapter that supports them", async () => {
    const db = new MemoryDb();
    const store = requireSkills(db);
    await store.put({ id: "a", body: "B" }, { userId: "u1" });
    expect((await store.list({ userId: "u1" })).map((s) => s.id)).toEqual(["a"]);
    await store.delete("a", { userId: "u1" });
    expect(await store.list({ userId: "u1" })).toEqual([]);
  });
});

describe("dbSkillProvider", () => {
  it("serves what the adapter holds for that caller", async () => {
    const db = new MemoryDb();
    await db.putSkill({ id: "refund", body: "Check the order date." }, { orgId: "acme" });
    const out = await dbSkillProvider(db)(ctx({ auth: { orgId: "acme" } }));
    expect(out.map((s) => s.id)).toEqual(["refund"]);
  });

  it("keeps tenants apart", async () => {
    // The property that cannot be checked by reading the calling code: one
    // provider, two auth contexts, two different answers.
    const db = new MemoryDb();
    await db.putSkill({ id: "acme-only", body: "..." }, { orgId: "acme" });
    await db.putSkill({ id: "globex-only", body: "..." }, { orgId: "globex" });

    const provider = dbSkillProvider(db);
    expect((await provider(ctx({ auth: { orgId: "acme" } }))).map((s) => s.id)).toEqual([
      "acme-only",
    ]);
    expect((await provider(ctx({ auth: { orgId: "globex" } }))).map((s) => s.id)).toEqual([
      "globex-only",
    ]);
  });

  it("throws early on an adapter that cannot store skills", () => {
    // At wiring time, not on the first turn — a host should learn this at
    // boot rather than from an empty skill list in production.
    expect(() => dbSkillProvider({} as DbAdapter)).toThrow(/does not support skills/);
  });
});
