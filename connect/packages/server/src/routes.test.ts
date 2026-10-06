import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnect } from "@freebirdai/connect";
import type { HttpFetch } from "@freebirdai/connect/adapters";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectFastify } from "./fastify.js";
import { matchRoute } from "./handlers.js";

/** The routes over a real engine and a fake API: add it, key it, read it. */

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Leasebook", version: "1.0.0" },
  servers: [{ url: "https://api.leasebook.test/v1" }],
  components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
  security: [{ key: [] }],
  paths: {
    "/tenants": {
      get: {
        operationId: "listTenants",
        responses: { "200": { description: "Tenants" } },
      },
    },
  },
};

const http: HttpFetch = async (url, init) => {
  const authorised = init.headers?.["x-api-key"] === "secret";
  return {
    status: authorised ? 200 : 401,
    text: JSON.stringify(authorised ? [{ id: "t1", status: "late" }, { id: "t2", status: "current" }] : { error: "no key" }),
    url,
    header: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null),
  };
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "connect-server-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const app = () => {
  const connect = createConnect({
    dir,
    http,
    fetchDocument: async (url) => ({ status: 200, text: JSON.stringify(SPEC), url }),
    autoIntegrate: false,
  });
  const server = Fastify();
  void server.register(connectFastify(connect));
  return server;
};

describe("connect-server", () => {
  it("adds, keys and reads a connection over HTTP, and never echoes the key", async () => {
    const server = app();
    const added = await server.inject({ method: "POST", url: "/connect/connections", payload: { from: "https://api.leasebook.test/openapi.json" } });
    expect(added.statusCode).toBe(201);
    const id = added.json().id as string;
    expect(added.json().needsKey).toBe(true);

    const keyed = await server.inject({ method: "PUT", url: `/connect/connections/${id}/key`, payload: { key: "secret" } });
    expect(keyed.json()).toEqual({ ok: true });

    const read = await server.inject({ method: "POST", url: `/connect/connections/${id}/read`, payload: { op: "listTenants", filter: { status: "late" } } });
    expect(read.statusCode).toBe(200);
    expect(read.json().rows).toEqual([{ id: "t1", status: "late" }]);

    const listed = await server.inject({ method: "GET", url: "/connect/connections" });
    expect(JSON.stringify(listed.json())).not.toContain("secret");
    await server.close();
  });

  it("says why a request failed, in the engine's words", async () => {
    const server = app();
    const missing = await server.inject({ method: "POST", url: "/connect/connections/nope/read", payload: { op: "x" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatch(/no connection "nope"/);
    const empty = await server.inject({ method: "POST", url: "/connect/connections", payload: {} });
    expect(empty.statusCode).toBe(400);
    await server.close();
  });
});

describe("matchRoute", () => {
  it("matches a path and reads its params", () => {
    expect(matchRoute("post", "/changes/p1/commit")?.params).toEqual({ pendingId: "p1" });
    expect(matchRoute("GET", "/connections/a%20b")?.params).toEqual({ id: "a b" });
    expect(matchRoute("PATCH", "/connections")).toBeNull();
  });
});
