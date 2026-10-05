import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionSchema, dashboardSchema, evidenceSchema, type Principal } from "@freebirdai/dash-spec";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_WORKSPACE_MIGRATION, openChatDb, type ChatDb } from "../chat/db.js";
import { KeyStore, LocalAesVault, scopedEvidence } from "@freebirdai/connect/host";
import type { Policy } from "../identity/policy.js";
import type { IdentityResolver } from "../identity/resolver.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { WorkspaceHost } from "./workspaces.js";
import { DbEvidenceStore, DbJobStore } from "@freebirdai/connect-postgres";
import { type DashDb, openDashDb } from "./db.js";

/*
 * Two workspaces on one server, sharing one database: neither sees the
 * other's connections, boards, chats, jobs or evidence,
 * whatever the two happen to name them.
 */

const NOW = Date.UTC(2026, 9, 2);

/** `alice@a` is alice, an owner in workspace a. */
const identity: IdentityResolver = {
  resolve: ({ headers }) => {
    const who = headers["x-test-user"];
    if (typeof who !== "string" || !who.includes("@")) return null;
    const [userId, workspaceId] = who.split("@") as [string, string];
    return { userId, workspaceId, role: userId === "carol" ? "viewer" : "owner", kind: "member" } satisfies Principal;
  },
};

/* Owners do anything; carol may read the connection `one` and nothing else. */
const policy: Policy = {
  can: (principal, permission, scope = {}) =>
    principal.role === "owner" || (permission === "records.read" && scope.connection === "one")
      ? { ok: true }
      : { ok: false, reason: "Not shared with you." },
};

const connectionNamed = (id: string, title: string) =>
  connectionSchema.parse({
    id,
    title,
    kind: "rest",
    baseUrl: `https://api.${id}.test`,
    ops: [{ id: "items", title: "Items", path: "/items", rowsPath: "$.data" }],
  });

let dir: string;
let db: DashDb;
let chat: ChatDb;
let host: WorkspaceHost;
const vault = new LocalAesVault(Buffer.alloc(32, 4));
const stores = new Map<string, SpecStore>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-workspaces-"));
  db = await openDashDb({ inMemory: true });
  chat = await openChatDb({ inMemory: true });
  const evidence = new DbEvidenceStore(db);
  host = new WorkspaceHost({
    identity,
    build: (workspace) => {
      const store = new SpecStore(join(dir, workspace, "dashboards"), join(dir, workspace, "connections"), join(dir, workspace, "reports"));
      stores.set(workspace, store);
      return buildServer({
        store,
        keys: new KeyStore(vault, join(dir, workspace, "vault.json")),
        identity,
        policy,
        workspace: { id: workspace, key: workspace },
        evidence: scopedEvidence(evidence, workspace),
        jobs: new DbJobStore(db, vault, workspace),
        chat,
      });
    },
  });
  await host.appFor("a");
  await host.appFor("b");
  /* The same names in both: isolation that holds only for different ids is not isolation. */
  stores.get("a")!.putConnection(connectionNamed("one", "Alpha's books"));
  stores.get("a")!.putConnection(connectionNamed("two", "Alpha's tickets"));
  stores.get("b")!.putConnection(connectionNamed("one", "Bravo's books"));
  stores.get("a")!.putDashboard(dashboardSchema.parse({ id: "ops", title: "Alpha ops", widgets: [], layout: { cells: [] } }));
});

afterAll(async () => {
  await host.close();
  await chat.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (who: string) => ({ "x-test-user": who });

describe("two workspaces on one server", () => {
  it("each sees its own connections and boards, and none of the other's", async () => {
    const alice = (await host.inject({ method: "GET", url: "/api/connections", headers: as("alice@a") })).json() as Array<{ id: string; title: string }>;
    const bob = (await host.inject({ method: "GET", url: "/api/connections", headers: as("bob@b") })).json() as Array<{ id: string; title: string }>;
    expect(alice.map((one) => one.title).sort()).toEqual(["Alpha's books", "Alpha's tickets"]);
    expect(bob.map((one) => one.title)).toEqual(["Bravo's books"]);
    expect((await host.inject({ method: "GET", url: "/api/connections/two", headers: as("bob@b") })).statusCode).toBe(404);
    const boards = (await host.inject({ method: "GET", url: "/api/dashboards", headers: as("bob@b") })).json() as Array<{ id: string }>;
    expect(boards.map((one) => one.id)).not.toContain("ops");
  });

  it("keeps each one's evidence and jobs apart, under one database", async () => {
    const at = new Date(NOW).toISOString();
    await scopedEvidence(new DbEvidenceStore(db), "a").record(
      evidenceSchema.parse({ connection: "one", op: "items", level: "accepted", configVersion: "v1", at, by: "integrate" }),
    );
    const evidenceOf = async (who: string) =>
      ((await host.inject({ method: "GET", url: "/api/connections/one/evidence", headers: as(who) })).json() as { ops: unknown[] }).ops;
    expect(await evidenceOf("alice@a")).toHaveLength(1);
    expect(await evidenceOf("bob@b")).toEqual([]);

    const job = { id: "read:x", kind: "read" as const, connection: "one", configVersion: "v1", state: "pending" as const, priority: 0, progress: { at: 1 }, attempts: 0, createdAt: NOW, updatedAt: NOW };
    await new DbJobStore(db, vault, "a").put(job);
    expect(await new DbJobStore(db, vault, "b").get("read:x")).toBeNull();
    await new DbJobStore(db, vault, "b").forget("one");
    expect(await new DbJobStore(db, vault, "a").get("read:x")).toMatchObject({ state: "pending" });
  });

  it("keeps each one's chats under its own workspace", async () => {
    const created = await host.inject({ method: "POST", url: "/freebird/sessions", headers: as("alice@a"), payload: { title: "Alpha's question" } });
    expect(created.statusCode).toBe(201);
    const session = (created.json() as { id: string }).id;
    const kept = await sql<{ tenant_id: string | null }>`SELECT tenant_id FROM freebird_chat_session WHERE id = ${session}`.execute(chat.kysely);
    expect(kept.rows[0]?.tenant_id).toBe("a");
    /* The same session asked for from the other workspace holds nothing of it. */
    await chat.kysely.insertInto("freebird_chat_message" as never).values({ id: "m1", session_id: session, role: "user", content: "only for a", references_json: "[]", tenant_id: "a" } as never).execute();
    const theirs = (await host.inject({ method: "GET", url: `/freebird/sessions/${session}/messages`, headers: as("bob@b") })).json();
    const ours = (await host.inject({ method: "GET", url: `/freebird/sessions/${session}/messages`, headers: as("alice@a") })).json();
    expect(ours).toHaveLength(1);
    expect(theirs).toEqual([]);
  });

  it("moves chats saved before there were workspaces to the local one, where the open-source build reads them", async () => {
    await sql`INSERT INTO freebird_chat_session (id, title, tags, tenant_id) VALUES ('before', 'Before', '{}', NULL)`.execute(chat.kysely);
    for (const statement of CHAT_WORKSPACE_MIGRATION) await sql.raw(statement).execute(chat.kysely);
    const kept = await sql<{ tenant_id: string | null }>`SELECT tenant_id FROM freebird_chat_session WHERE id = 'before'`.execute(chat.kysely);
    expect(kept.rows[0]?.tenant_id).toBe("local");
  });

  it("refuses a member of one workspace at the other's server, and anyone it cannot name", async () => {
    const a = await host.appFor("a");
    expect((await a.inject({ method: "GET", url: "/api/connections", headers: as("bob@b") })).statusCode).toBe(403);
    expect((await host.inject({ method: "GET", url: "/api/connections" })).statusCode).toBe(401);
  });

  it("shows a member only the connections shared with them, and reads nothing else", async () => {
    const listed = (await host.inject({ method: "GET", url: "/api/connections", headers: as("carol@a") })).json() as Array<{ id: string }>;
    expect(listed.map((one) => one.id)).toEqual(["one"]);
    expect((await host.inject({ method: "GET", url: "/api/connections/two", headers: as("carol@a") })).statusCode).toBe(403);
    const query = await host.inject({ method: "POST", url: "/api/query", headers: as("carol@a"), payload: { connection: "two", op: "items" } });
    expect(query.statusCode).toBe(403);
  });
});
