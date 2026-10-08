import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionSchema, dashboardSchema, evidenceSchema, type Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_WORKSPACE_MIGRATION, openChatDb, type ChatDb } from "../chat/db.js";
import { KeyStore, LocalAesVault, scopedEvidence } from "@freebirdai/connect/host";
import type { Policy } from "../identity/policy.js";
import type { IdentityResolver } from "../identity/resolver.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { MemorySignalStore } from "../workflows/store.js";
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
const signals = new Map<string, MemorySignalStore>();
/* Which workspaces the host was asked whether it holds. */
const asked: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-workspaces-"));
  db = await openDashDb({ inMemory: true });
  chat = await openChatDb({ inMemory: true });
  const evidence = new DbEvidenceStore(db);
  host = new WorkspaceHost({
    identity,
    holds: (workspace) => {
      asked.push(workspace);
      return workspace === "a" || workspace === "b";
    },
    build: (workspace) => {
      const store = new SpecStore(join(dir, workspace, "dashboards"), join(dir, workspace, "connections"), join(dir, workspace, "reports"));
      stores.set(workspace, store);
      signals.set(workspace, new MemorySignalStore());
      return buildServer({
        store,
        keys: new KeyStore(vault, join(dir, workspace, "vault.json")),
        identity,
        policy,
        workspace: { id: workspace, key: workspace },
        evidence: scopedEvidence(evidence, workspace),
        jobs: new DbJobStore(db, vault, workspace),
        chat,
        signals: signals.get(workspace)!,
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

/* ── webhooks ─────────────────────────────────────────────────────── */

let named = 0;

/** A case in a member's workspace, waiting for its webhook, and the address it handed out. */
const waitingForACall = async (who: string): Promise<{ case: string; hook: string; token: string }> => {
  const saved = await host.inject({
    method: "PUT",
    url: "/api/workflows/new",
    headers: as(who),
    payload: {
      name: `Wait for a call ${++named}`,
      trigger: { kind: "manual" },
      nodes: [
        { id: "hook", action: "wait.for", settings: { event: "webhook", timeout: "1d" } },
        { id: "heard", action: "create.note", settings: { text: "heard" } },
      ],
      edges: [
        { id: "a", from: "trigger", to: "hook" },
        { id: "b", from: "hook", outcome: "happened", to: "heard" },
      ],
    },
  });
  expect(saved.statusCode).toBe(200);
  const run = (await host.inject({ method: "POST", url: `/api/workflows/${(saved.json() as { id: string }).id}/run`, headers: as(who) })).json() as { cases: string[] };
  const id = run.cases[0]!;
  const one = (await host.inject({ method: "GET", url: `/api/cases/${id}`, headers: as(who) })).json() as { status: string; data: { steps: { hook: { hook: string } } } };
  expect(one.status).toBe("waiting");
  const hook = one.data.steps.hook.hook;
  return { case: id, hook, token: hook.split("/").pop()! };
};

const statusOf = async (who: string, id: string): Promise<string> => ((await host.inject({ method: "GET", url: `/api/cases/${id}`, headers: as(who) })).json() as { status: string }).status;

/**
 * Every route a server has, from `printRoutes`: its method, and its path with
 * each parameter filled in (parameters at one place in the tree are drawn
 * together, `:workspace|:token`, so they are not told apart by name).
 */
const routesOf = (app: FastifyInstance): Array<{ readonly method: string; readonly url: string }> => {
  const found: Array<{ method: string; url: string }> = [];
  const above: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const drawn = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]+)\))?/.exec(line);
    if (!drawn) continue;
    const depth = drawn[1]!.length / 4;
    above.length = depth;
    const route = (above[depth - 1] ?? "") + drawn[2];
    above.push(route);
    for (const method of drawn[3]?.split(", ") ?? []) found.push({ method, url: route.replace(/:[^/]+/g, "x1").replace(/\*/g, "x1") });
  }
  return found;
};

describe("a webhook, which another system calls with nobody signed in", () => {
  it("reaches the workspace its address names, and wakes the case waiting there", async () => {
    const waiting = await waitingForACall("alice@a");
    expect(waiting.hook).toBe(`/api/workflow-hooks/a/${waiting.token}`);
    const called = await host.inject({ method: "POST", url: waiting.hook, payload: { paid: true } });
    expect(called.statusCode).toBe(200);
    expect(called.json()).toEqual({ woken: 1 });
    expect(await statusOf("alice@a", waiting.case)).toBe("done");
    /* Once taken, nothing waits on it any more. */
    expect((await host.inject({ method: "POST", url: waiting.hook, payload: { paid: true } })).statusCode).toBe(404);
  });

  it("finds nothing when its address names another workspace, and keeps nothing there", async () => {
    const waiting = await waitingForACall("alice@a");
    const elsewhere = await host.inject({ method: "POST", url: `/api/workflow-hooks/b/${waiting.token}`, payload: { paid: true } });
    expect(elsewhere.statusCode).toBe(404);
    expect(await signals.get("b")!.untaken("2000-01-01T00:00:00.000Z")).toEqual([]);
    /* Handed straight to the other workspace's server, it is not that server's hook either. */
    const b = await host.appFor("b");
    const straight = await b.inject({ method: "POST", url: waiting.hook, payload: { paid: true } });
    expect(straight.statusCode).toBe(404);
    expect(straight.json()).toEqual({ error: "Unknown hook." });
    expect(await statusOf("alice@a", waiting.case)).toBe("waiting");
    /* Its own workspace still wakes it. */
    expect((await host.inject({ method: "POST", url: waiting.hook })).json()).toEqual({ woken: 1 });
  });

  it("opens no workspace the host does not hold, whatever the address says", async () => {
    asked.length = 0;
    expect((await host.inject({ method: "POST", url: "/api/workflow-hooks/c/abcdefabcdefabcdef12" })).statusCode).toBe(404);
    expect((await host.inject({ method: "POST", url: "/api/workflow-hooks/a%2F..%2Fc/abcdefabcdefabcdef12" })).statusCode).toBe(404);
    expect(asked).toEqual(["c"]);
    expect(host.open()).not.toContain("c");
  });

  it("lets no other route through without a principal, at the host or at a workspace's own server", async () => {
    const waiting = await waitingForACall("alice@a");
    const a = await host.appFor("a");
    const routes = routesOf(a);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContainEqual({ method: "POST", url: "/api/workflow-hooks/x1/x1" });
    expect(routes).toContainEqual({ method: "POST", url: "/api/workflow-hooks/x1" });
    const unsigned = new Set<string>();
    for (const one of routes) {
      const method = one.method as "GET";
      if ((await host.inject({ method, url: one.url })).statusCode !== 401) unsigned.add(`${one.method} ${one.url} at the host`);
      if ((await a.inject({ method, url: one.url })).statusCode !== 401) unsigned.add(`${one.method} ${one.url} at a's server`);
    }
    /* The one route without a person, and only it: answered (here, "Unknown hook.") rather than refused. */
    expect([...unsigned].sort()).toEqual(["POST /api/workflow-hooks/x1/x1 at a's server", "POST /api/workflow-hooks/x1/x1 at the host"]);

    /* Addresses that look like a hook's and are not, or are the old form, which named no workspace. */
    const lookalikes: Array<["GET" | "POST", string]> = [
      ["GET", waiting.hook],
      ["POST", `/api/workflow-hooks/${waiting.token}`],
      ["POST", `${waiting.hook}/more`],
      ["POST", "/api/workflow-hooks/a"],
      ["POST", "/api/workflow-hooks/a/../../workflow-events"],
      ["POST", `/API/workflow-hooks/a/${waiting.token}`],
    ];
    for (const [method, url] of lookalikes) {
      expect((await host.inject({ method, url, payload: { key: waiting.token } })).statusCode, `${method} ${url} at the host`).toBe(401);
      expect((await a.inject({ method, url, payload: { key: waiting.token } })).statusCode, `${method} ${url} at a's server`).toBe(401);
    }
    expect(await statusOf("alice@a", waiting.case)).toBe("waiting");
  });
});
