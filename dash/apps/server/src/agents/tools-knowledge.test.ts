import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeLlm } from "@freebirdai/dash-agent";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { connectionSchema, type Principal } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerPolicy } from "../identity/policy.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { draftAgentText } from "./assist.js";
import { AgentService } from "./service.js";
import { MemoryAgentStore } from "./store.js";

const owner: Principal = { userId: "o", workspaceId: "acme", role: "owner", kind: "member" };

const service = () =>
  new AgentService({
    store: new MemoryAgentStore(),
    policy: ownerPolicy,
    hasConnection: (id) => id === "pms",
    hasOp: (connection, op) => connection === "pms" && (op === "properties" || op === "tenants"),
  });

const readPms = [{ permission: "records.read" as const, scope: { connection: "pms" } }];

describe("an agent's tools", () => {
  it("keeps tools with their modes", async () => {
    const made = await service().create(owner, {
      name: "Collector",
      color: 1,
      reach: readPms,
      tools: [
        { id: "look", kind: "look_up_record", mode: "auto", scope: { connection: "pms" }, enabled: true, whenToUse: "", denyReply: "" },
        { id: "follow", kind: "schedule_follow_up", mode: "auto", scope: {}, enabled: true, whenToUse: "", denyReply: "" },
        {
          id: "refund",
          kind: "record_action",
          mode: "deny",
          scope: {},
          enabled: true,
          whenToUse: "",
          denyReply: "Refunds are handled by the office; give them the office number.",
        },
      ],
    });
    expect(made.tools.map((tool) => [tool.id, tool.mode])).toEqual([
      ["look", "auto"],
      ["follow", "auto"],
      ["refund", "deny"],
    ]);
  });

  it("refuses a record tool the reach does not cover, unless it is set to deny or off", async () => {
    const agents = service();
    const update = { id: "upd", kind: "update_record" as const, scope: { connection: "pms" }, whenToUse: "", denyReply: "" };
    await expect(
      agents.create(owner, { name: "A", color: 1, reach: readPms, tools: [{ ...update, mode: "approve", enabled: true }] }),
    ).rejects.toMatchObject({ status: 400, problems: [{ reason: "tool-beyond-reach", item: "upd" }] });
    await expect(agents.create(owner, { name: "B", color: 1, reach: readPms, tools: [{ ...update, mode: "deny", enabled: true }] })).resolves.toBeDefined();
    await expect(agents.create(owner, { name: "C", color: 1, reach: readPms, tools: [{ ...update, mode: "auto", enabled: false }] })).resolves.toBeDefined();
  });

  it("refuses two tools with one id, and a workflow tool that names no workflow", async () => {
    const tool = { id: "t", kind: "schedule_appointment" as const, mode: "auto" as const, scope: {}, enabled: true, whenToUse: "", denyReply: "" };
    await expect(service().create(owner, { name: "A", color: 1, tools: [tool, tool] })).rejects.toMatchObject({ status: 400 });
    await expect(
      service().create(owner, { name: "B", color: 1, tools: [{ ...tool, kind: "run_workflow" }] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("an agent's knowledge", () => {
  const rule = (op: string) => ({ id: "property", trigger: "Someone mentions a property", sources: [{ connection: "pms", op }], enabled: true });

  it("keeps notes and context rules that read what the agent may read", async () => {
    const made = await service().create(owner, {
      name: "Helper",
      color: 2,
      reach: readPms,
      knowledge: { notes: "Office hours are 9 to 5.", context: [rule("properties")] },
    });
    expect(made.knowledge.context[0]?.sources).toEqual([{ connection: "pms", op: "properties" }]);
  });

  it("refuses a rule on an endpoint that is not there, or one the agent may not read", async () => {
    await expect(
      service().create(owner, { name: "A", color: 1, reach: readPms, knowledge: { notes: "", context: [rule("ghost")] } }),
    ).rejects.toMatchObject({ problems: [{ reason: "unknown-endpoint" }] });
    await expect(
      service().create(owner, { name: "B", color: 1, knowledge: { notes: "", context: [rule("properties")] } }),
    ).rejects.toMatchObject({ problems: [{ reason: "context-beyond-reach" }] });
  });

  it("keeps knowledge every agent shares, checking only that its endpoints exist", async () => {
    const agents = service();
    const saved = await agents.putShared({ notes: "We are closed on public holidays.", context: [rule("tenants")] });
    expect((await agents.shared()).notes).toBe(saved.notes);
    await expect(agents.putShared({ notes: "", context: [rule("ghost")] })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps tools and knowledge across a rename", async () => {
    const agents = service();
    const made = await agents.create(owner, { name: "A", color: 1, reach: readPms, knowledge: { notes: "x", context: [] }, personality: "Warm." });
    const renamed = await agents.update(owner, made.id, { name: "B", color: 1 });
    expect(renamed).toMatchObject({ name: "B", personality: "Warm.", knowledge: { notes: "x" } });
  });
});

describe("Generate", () => {
  it("drafts from what was typed, keeps the base prompt out of the answer, and strips fences", async () => {
    const llm = fakeLlm([{ text: "```\n- DO NOT accept Friday as a pay date.\n```" }]);
    const text = await draftAgentText(llm, { field: "instructions", text: "no fridays for payment", agent: { name: "Collector" } });
    expect(text).toBe("- DO NOT accept Friday as a pay date.");
    const sent = llm.calls[0]!.messages.map((one) => one.content).join("\n");
    expect(sent).toContain("no fridays for payment");
    expect(sent).toContain("Collector");
    expect(sent).toMatch(/Never invent policies/);
  });
});

describe("/api/agents/assist and /api/agent-knowledge", () => {
  let dir: string;
  let store: SpecStore;
  let keys: KeyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-agent-assist-"));
    store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
    store.putConnection(
      connectionSchema.parse({
        id: "pms",
        title: "Property system",
        kind: "rest",
        baseUrl: "https://api.pms.test",
        auth: { type: "none" },
        ops: [{ id: "properties", title: "List properties", path: "/properties", rowsPath: "$.data" }],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drafts with the configured model, and says so plainly when there is none", async () => {
    const withModel = buildServer({ store, keys, llm: fakeLlm([{ text: "You are Collector, a collections agent for [Company name]." }]) });
    const drafted = await withModel.inject({ method: "POST", url: "/api/agents/assist", payload: { field: "role", text: "collections" } });
    expect(drafted.json()).toEqual({ text: "You are Collector, a collections agent for [Company name]." });

    const without = buildServer({ store, keys, llm: null });
    const refused = await without.inject({ method: "POST", url: "/api/agents/assist", payload: { field: "role", text: "x" } });
    expect(refused.statusCode).toBe(503);
  });

  it("saves and reads the shared knowledge", async () => {
    const app = buildServer({ store, keys });
    expect((await app.inject({ method: "GET", url: "/api/agent-knowledge" })).json()).toMatchObject({ notes: "", context: [] });
    const put = await app.inject({
      method: "PUT",
      url: "/api/agent-knowledge",
      payload: { notes: "Closed Sundays.", context: [{ id: "p", trigger: "a property", sources: [{ connection: "pms", op: "properties" }] }] },
    });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agent-knowledge" })).json().notes).toBe("Closed Sundays.");
  });
});
