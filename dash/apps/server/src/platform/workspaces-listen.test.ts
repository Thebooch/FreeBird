import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionSchema, type Principal } from "@freebirdai/dash-spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityResolver } from "../identity/resolver.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { WorkspaceHost } from "./workspaces.js";

/*
 * The host over a real socket: each request handed to its workspace's server
 * as it arrived — headers, body and all.
 */

const identity: IdentityResolver = {
  resolve: ({ headers }) => {
    const who = headers["x-test-user"];
    if (typeof who !== "string" || !who.includes("@")) return null;
    const [userId, workspaceId] = who.split("@") as [string, string];
    return { userId, workspaceId, role: "owner", kind: "member" } satisfies Principal;
  },
};

let dir: string;
let host: WorkspaceHost;
let base: string;
let server: ReturnType<WorkspaceHost["listen"]>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-host-"));
  host = new WorkspaceHost({
    identity,
    build: (workspace) => {
      const store = new SpecStore(join(dir, workspace, "dashboards"), join(dir, workspace, "connections"), join(dir, workspace, "reports"));
      store.putConnection(
        connectionSchema.parse({ id: "books", title: `${workspace}'s books`, kind: "rest", baseUrl: "https://api.books.test", ops: [{ id: "items", title: "Items", path: "/items" }] }),
      );
      return buildServer({ store, keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 6)), join(dir, workspace, "vault.json")), identity, workspace: { id: workspace, key: workspace } });
    },
  });
  server = host.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a host listening for several workspaces", () => {
  it("answers each member from their own workspace's server, and nobody it cannot name", async () => {
    const ask = async (who?: string) => {
      const response = await fetch(`${base}/api/connections`, { headers: who ? { "x-test-user": who } : {} });
      return { status: response.status, body: (await response.json()) as unknown };
    };
    expect((await ask("ana@north")).body).toEqual([expect.objectContaining({ title: "north's books" })]);
    expect((await ask("sam@south")).body).toEqual([expect.objectContaining({ title: "south's books" })]);
    expect((await ask()).status).toBe(401);
    expect(host.open().sort()).toEqual(["north", "south"]);
  });

  it("hands a request's body through untouched", async () => {
    const response = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "x-test-user": "ana@north", "content-type": "application/json" },
      body: JSON.stringify({ connection: "nowhere", op: "items" }),
    });
    /* The body arrived: the workspace's server read which connection was asked for, and has none by that name. */
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/nowhere/);
  });
});
