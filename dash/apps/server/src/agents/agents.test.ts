import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { connectionSchema, type Principal } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { AgentError, AgentService } from "./service.js";
import { MemoryAgentStore } from "./store.js";

let dir: string;
let store: SpecStore;
let keys: KeyStore;

const pms = connectionSchema.parse({
  id: "pms",
  title: "Property system",
  kind: "rest",
  baseUrl: "https://api.pms.test",
  auth: { type: "none" },
  ops: [{ id: "properties", title: "List properties", path: "/properties", rowsPath: "$.data" }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-agents-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  store.putConnection(pms);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const member = (userId: string, role: "owner" | "admin" | "editor" | "viewer", grants: unknown[] = []) => ({
  workspaceId: "acme",
  userId,
  email: `${userId}@acme.test`,
  role,
  grants: grants as never,
  joinedAt: "2026-10-06T00:00:00.000Z",
});

const principal = (userId: string, role: Principal["role"]): Principal => ({ userId, workspaceId: "acme", role, kind: "member" });

describe("AgentService", () => {
  const build = async () => {
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("boss", "admin"));
    await memberships.putMember(
      member("lead", "editor", [
        { permission: "agents.manage", scope: {} },
      ]),
    );
    await memberships.putMember(member("reader", "viewer", [{ permission: "agents.manage", scope: {} }]));
    const service = new AgentService({
      store: new MemoryAgentStore(),
      policy: rolePolicy(memberships),
      hasConnection: (id) => id === "pms",
      now: () => new Date("2026-10-06T12:00:00Z"),
    });
    return service;
  };

  it("makes an agent with an id from its name, and keeps the order they were made in", async () => {
    const service = await build();
    const first = await service.create(principal("boss", "admin"), { name: "Leasing Scout", color: 2 });
    const second = await service.create(principal("boss", "admin"), { name: "Leasing Scout", color: 4 });
    expect(first).toMatchObject({ id: "leasing-scout", instructions: "", reach: [], archived: false });
    expect(second.id).toBe("leasing-scout-2");
    expect((await service.list()).map((one) => one.id)).toEqual(["leasing-scout", "leasing-scout-2"]);
  });

  it("refuses a reach on a connection that does not exist", async () => {
    const service = await build();
    const attempt = service.create(principal("boss", "admin"), {
      name: "Ghost",
      color: 1,
      reach: [{ permission: "records.read", scope: { connection: "nope" } }],
    });
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    expect(await service.list()).toEqual([]);
  });

  it("will not grant more than the person saving holds", async () => {
    const service = await build();
    /* A viewer who may manage agents still cannot hand one the power to change records. */
    const beyond = service.create(principal("reader", "viewer"), {
      name: "Overreach",
      color: 1,
      reach: [{ permission: "records.update", scope: { connection: "pms" } }],
    });
    await expect(beyond).rejects.toMatchObject({ status: 403, problems: [{ reason: "beyond-you" }] });

    const within = await service.create(principal("reader", "viewer"), {
      name: "Reader",
      color: 1,
      reach: [{ permission: "records.read", scope: { connection: "pms" } }],
    });
    expect(within.reach).toHaveLength(1);
  });

  it("holds a grant scoped to one record type to that record type", async () => {
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("narrow", "viewer", [{ permission: "records.update", scope: { connection: "pms", entity: "property" } }]));
    const service = new AgentService({ store: new MemoryAgentStore(), policy: rolePolicy(memberships), hasConnection: () => true });
    const who = principal("narrow", "viewer");
    await expect(
      service.create(who, { name: "A", color: 1, reach: [{ permission: "records.update", scope: { connection: "pms", entity: "property" } }] }),
    ).resolves.toBeDefined();
    await expect(
      service.create(who, { name: "B", color: 1, reach: [{ permission: "records.update", scope: { connection: "pms", entity: "tenant" } }] }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("updates in place, keeping id and creation date, and archives without losing it", async () => {
    const service = await build();
    const made = await service.create(principal("boss", "admin"), { name: "Scout", color: 2, instructions: "Watch leases." });
    const changed = await service.update(principal("boss", "admin"), made.id, { name: "Lease Scout", color: 5, instructions: "Watch leases." });
    expect(changed).toMatchObject({ id: made.id, name: "Lease Scout", color: 5, createdAt: made.createdAt });

    await service.setArchived(made.id, true);
    expect(await service.list()).toEqual([]);
    expect((await service.list({ includeArchived: true }))[0]).toMatchObject({ id: made.id, archived: true });
    await service.setArchived(made.id, false);
    expect(await service.list()).toHaveLength(1);
  });

  it("removes for good only an archived agent nothing refers to", async () => {
    const memberships = new MemoryMembershipStore();
    let referenced = true;
    const service = new AgentService({
      store: new MemoryAgentStore(),
      policy: rolePolicy(memberships),
      hasConnection: () => true,
      isReferenced: async () => referenced,
    });
    await memberships.putMember(member("boss", "admin"));
    const made = await service.create(principal("boss", "admin"), { name: "Scout", color: 1 });
    await expect(service.remove(made.id)).rejects.toMatchObject({ status: 409 });
    await service.setArchived(made.id, true);
    await expect(service.remove(made.id)).rejects.toMatchObject({ status: 409 });
    referenced = false;
    await service.remove(made.id);
    expect(await service.get(made.id)).toBeNull();
  });
});

describe("/api/agents", () => {
  it("makes, lists, changes, archives and restores an agent for the one local owner", async () => {
    const app = buildServer({ store, keys });
    const put = (id: string, body: unknown) => app.inject({ method: "PUT", url: `/api/agents/${id}`, payload: body as never });

    const made = await put("new", { name: "Scout", color: 3, reach: [{ permission: "records.read", scope: { connection: "pms" } }] });
    expect(made.statusCode).toBe(200);
    const agent = made.json();
    expect(agent).toMatchObject({ id: "scout", color: 3, archived: false });

    expect((await app.inject({ method: "GET", url: "/api/agents" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/agents/scout" })).json().name).toBe("Scout");

    const renamed = await put("scout", { name: "Lease Scout", color: 3 });
    /* What was not sent stays: a rename does not take away its access. */
    expect(renamed.json()).toMatchObject({ id: "scout", name: "Lease Scout", reach: [{ permission: "records.read", scope: { connection: "pms" } }] });
    expect((await put("scout", { name: "Lease Scout", color: 3, reach: [] })).json().reach).toEqual([]);

    expect((await app.inject({ method: "DELETE", url: "/api/agents/scout" })).json().archived).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/agents?archived=1" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/agents/scout/restore" })).json().archived).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/agents/ghost" })).statusCode).toBe(404);
  });

  it("answers 400 for a bad agent and for a connection that is not there", async () => {
    const app = buildServer({ store, keys });
    expect((await app.inject({ method: "PUT", url: "/api/agents/x", payload: { name: "", color: 3 } })).statusCode).toBe(400);
    const unknown = await app.inject({
      method: "PUT",
      url: "/api/agents/x",
      payload: { name: "X", color: 3, reach: [{ permission: "records.read", scope: { connection: "ghost" } }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/ghost/);
  });

  it("is for owners and admins: an editor is refused at the door, an admin is let in", async () => {
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("ed", "editor"));
    await memberships.putMember(member("ad", "admin"));
    const as = (userId: string, role: Principal["role"]) => ({ resolve: () => principal(userId, role) });
    const body = { name: "Scout", color: 1 };

    const editor = buildServer({ store, keys, policy: rolePolicy(memberships), identity: as("ed", "editor") });
    const refused = await editor.inject({ method: "PUT", url: "/api/agents/x", payload: body });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().permission).toBe("agents.manage");
    /* Reading is open to anybody in the workspace. */
    expect((await editor.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(200);

    const admin = buildServer({ store, keys, policy: rolePolicy(memberships), identity: as("ad", "admin") });
    expect((await admin.inject({ method: "PUT", url: "/api/agents/x", payload: body })).statusCode).toBe(200);
  });
});
