import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import type { Principal } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDashDb } from "../platform/db.js";
import { DbLeaseLock, MemoryLeaseLock } from "../platform/lease.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { bindAllowed, permissionFor } from "./guard.js";
import { acceptInvite, createInvite } from "./invites.js";
import { DbMembershipStore, MemoryMembershipStore } from "./members.js";
import { oidcJwtResolver } from "./oidc.js";
import { rolePolicy } from "./policy.js";

/* Plan, track G: what a hosted build signs people in and decides with. */

const ISSUER = "https://login.example.test";
const AUDIENCE = "dash-app";
const NOW = Date.UTC(2026, 8, 30, 12);

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const keys = async () => {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  const publicJwk = { ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }) => {
    const body = `${b64(header)}.${b64(claims)}`;
    const signature = await webcrypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(body));
    return `${body}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { publicJwk, sign };
};

const provider = (jwk: unknown, jwksHost = "login.example.test") => async (url: string) => {
  if (url === `${ISSUER}/.well-known/openid-configuration`)
    return { status: 200, text: JSON.stringify({ issuer: ISSUER, jwks_uri: `https://${jwksHost}/keys` }), url };
  if (url === `https://${jwksHost}/keys`) return { status: 200, text: JSON.stringify({ keys: [jwk] }), url };
  return { status: 404, text: "", url };
};

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "user-7",
  dash_workspace: "acme",
  exp: NOW / 1000 + 600,
  iat: NOW / 1000,
  ...extra,
});

const member = (role: "owner" | "admin" | "editor" | "viewer", grants: unknown[] = []) => ({
  workspaceId: "acme",
  userId: "user-7",
  email: "seven@acme.test",
  role,
  grants: grants as never,
  joinedAt: new Date(NOW).toISOString(),
});

describe("signing in with a token an identity provider signed", () => {
  it("is a member of the workspace the token names, with the role the workspace gave them", async () => {
    const { publicJwk, sign } = await keys();
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("editor"));
    const resolver = oidcJwtResolver({ issuer: ISSUER, audience: AUDIENCE, memberships, fetchDocument: provider(publicJwk), now: () => NOW });
    const token = await sign(claims());
    expect(await resolver.resolve({ headers: { authorization: `Bearer ${token}` }, url: "/" })).toEqual({
      userId: "user-7",
      workspaceId: "acme",
      role: "editor",
      kind: "member",
    });
  });

  it("is nobody for a token that does not check out, or a person who is not a member", async () => {
    const { publicJwk, sign } = await keys();
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("viewer"));
    const resolver = oidcJwtResolver({ issuer: ISSUER, audience: AUDIENCE, memberships, fetchDocument: provider(publicJwk), now: () => NOW });
    const as = async (token: string) => resolver.resolve({ headers: { authorization: `Bearer ${token}` }, url: "/" });
    expect(await as(await sign(claims({ aud: "someone-else" })))).toBeNull();
    expect(await as(await sign(claims({ iss: "https://evil.test" })))).toBeNull();
    expect(await as(await sign(claims({ exp: NOW / 1000 - 3600 })))).toBeNull();
    expect(await as(await sign(claims({ sub: "stranger" })))).toBeNull();
    expect(await as(await sign(claims({ dash_workspace: undefined })))).toBeNull();
    /* No signature at all, and a key it does not know: never trusted. */
    expect(await as(`${b64({ alg: "none" })}.${b64(claims())}.`)).toBeNull();
    expect(await as(await sign(claims(), { alg: "RS256", kid: "unknown" }))).toBeNull();
    const tampered = (await sign(claims())).split(".");
    expect(await as(`${tampered[0]}.${b64(claims({ sub: "admin" }))}.${tampered[2]}`)).toBeNull();
    expect(await resolver.resolve({ headers: {}, url: "/" })).toBeNull();
  });

  it("refuses keys an issuer's discovery document puts on another host", async () => {
    const { publicJwk, sign } = await keys();
    const memberships = new MemoryMembershipStore();
    await memberships.putMember(member("owner"));
    const resolver = oidcJwtResolver({ issuer: ISSUER, audience: AUDIENCE, memberships, fetchDocument: provider(publicJwk, "attacker.test"), now: () => NOW });
    expect(await resolver.resolve({ headers: { authorization: `Bearer ${await sign(claims())}` }, url: "/" })).toBeNull();
  });
});

describe("what each member may do", () => {
  const principal: Principal = { userId: "user-7", workspaceId: "acme", role: "viewer", kind: "member" };

  it("follows the role, adds each grant only where its scope says, and stops when they leave", async () => {
    const memberships = new MemoryMembershipStore();
    const policy = rolePolicy(memberships);
    await memberships.putMember(member("editor"));
    expect((await policy.can(principal, "boards.edit")).ok).toBe(true);
    expect((await policy.can(principal, "connections.manage")).ok).toBe(false);
    await memberships.putMember(member("viewer", [{ permission: "records.update", scope: { connection: "buildium", entity: "property" } }]));
    expect((await policy.can(principal, "records.update", { connection: "buildium", entity: "property" })).ok).toBe(true);
    expect((await policy.can(principal, "records.update", { connection: "buildium", entity: "lease" })).ok).toBe(false);
    expect((await policy.can(principal, "records.read")).ok).toBe(true);
    await memberships.removeMember("acme", "user-7");
    expect(await policy.can(principal, "records.read")).toEqual({ ok: false, reason: "You are no longer a member of this workspace." });
  });

  it("guards every route that changes stored state, and never a read", () => {
    expect(permissionFor("PUT", "/api/dashboards/main")).toBe("boards.edit");
    expect(permissionFor("POST", "/api/connections/buildium/compile")).toBe("boards.edit");
    expect(permissionFor("PUT", "/api/connections/buildium/key")).toBe("connections.manage");
    expect(permissionFor("POST", "/api/connections/buildium/sample")).toBe("records.read");
    expect(permissionFor("PUT", "/api/parts/card/x")).toBe("boards.edit");
    expect(permissionFor("POST", "/api/query")).toBeNull();
    expect(permissionFor("GET", "/api/dashboards/main")).toBeNull();
    /* A change to an account checks the record type itself, on prepare and on commit. */
    expect(permissionFor("POST", "/api/connections/buildium/writes/prepare")).toBeNull();
    expect(permissionFor("POST", "/api/writes/p1/commit")).toBeNull();
  });

  it("refuses a viewer's change at the door, and lets the owner of this machine do everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-guard-"));
    try {
      const memberships = new MemoryMembershipStore();
      await memberships.putMember(member("viewer"));
      const app = buildServer({
        store: new SpecStore(join(dir, "d"), join(dir, "c"), join(dir, "r")),
        keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "vault.json")),
        identity: { resolve: () => principal },
        policy: rolePolicy(memberships),
      });
      const refused = await app.inject({ method: "POST", url: "/api/dashboards", payload: { title: "Mine" } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ permission: "boards.edit" });
      expect((await app.inject({ method: "GET", url: "/api/dashboards" })).statusCode).toBe(200);
      await app.close();
      const local = buildServer({
        store: new SpecStore(join(dir, "d2"), join(dir, "c2"), join(dir, "r2")),
        keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "vault2.json")),
      });
      expect((await local.inject({ method: "POST", url: "/api/dashboards", payload: { title: "Mine" } })).statusCode).toBeLessThan(300);
      await local.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listens beyond this machine only where every request is signed in", () => {
    expect(bindAllowed("127.0.0.1", false)).toEqual({ ok: true });
    expect(bindAllowed("::1", false)).toEqual({ ok: true });
    expect(bindAllowed("0.0.0.0", false)).toMatchObject({ ok: false, reason: expect.stringMatching(/no sign-in/) });
    expect(bindAllowed("0.0.0.0", true)).toEqual({ ok: true });
  });
});

describe("invitations", () => {
  it("keep only a hash, make a member once, and refuse the wrong person, a used one and an old one", async () => {
    const store = new MemoryMembershipStore();
    const { token, invite } = await createInvite(store, { workspaceId: "acme", email: "new@acme.test", role: "editor", invitedBy: "owner-1", now: NOW });
    expect(JSON.stringify(invite)).not.toContain(token);
    expect(await acceptInvite(store, { workspaceId: "acme", token, userId: "u-2", email: "other@acme.test", now: NOW })).toMatchObject({ error: expect.stringMatching(/another address/) });
    expect(await acceptInvite(store, { workspaceId: "acme", token, userId: "u-2", email: "NEW@acme.test", now: NOW })).toMatchObject({ role: "editor", userId: "u-2" });
    expect(await acceptInvite(store, { workspaceId: "acme", token, userId: "u-3", email: "new@acme.test", now: NOW })).toMatchObject({ error: expect.stringMatching(/already used/) });
    const old = await createInvite(store, { workspaceId: "acme", email: "late@acme.test", role: "viewer", invitedBy: "owner-1", now: NOW, days: 1 });
    expect(await acceptInvite(store, { workspaceId: "acme", token: old.token, userId: "u-4", email: "late@acme.test", now: NOW + 2 * 86_400_000 })).toMatchObject({ error: expect.stringMatching(/expired/) });
    await expect(createInvite(store, { workspaceId: "acme", email: "x@acme.test", role: "owner", invitedBy: "owner-1", now: NOW })).rejects.toThrow(/owner/);
  });
});

describe("in Dash's database", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-hosted-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps members and invitations, and gives a lease to one holder at a time until it lapses", async () => {
    const db = await openDashDb({ dataDir: dir });
    try {
      const store = new DbMembershipStore(db);
      await store.putWorkspace({ id: "acme", name: "Acme", ownerId: "owner-1", createdAt: new Date(NOW).toISOString() });
      await store.putMember(member("admin"));
      expect(await store.member("acme", "user-7")).toMatchObject({ role: "admin" });
      expect(await store.members("acme")).toHaveLength(1);
      const { token } = await createInvite(store, { workspaceId: "acme", email: "new@acme.test", role: "viewer", invitedBy: "owner-1", now: NOW });
      expect(await acceptInvite(store, { workspaceId: "acme", token, userId: "u-2", email: "new@acme.test", now: NOW })).toMatchObject({ role: "viewer" });
      expect(await store.members("acme")).toHaveLength(2);

      const leases = new DbLeaseLock(db);
      expect(await leases.acquire("keeper:buildium", "server-a", 60_000)).toBe(true);
      expect(await leases.acquire("keeper:buildium", "server-b", 60_000)).toBe(false);
      expect(await leases.acquire("keeper:buildium", "server-a", 60_000)).toBe(true);
      await leases.release("keeper:buildium", "server-a");
      expect(await leases.acquire("keeper:buildium", "server-b", 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await leases.acquire("keeper:buildium", "server-a", 60_000)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("keeps a lease in memory for one process the same way", async () => {
    let clock = NOW;
    const leases = new MemoryLeaseLock(() => clock);
    expect(await leases.acquire("k", "a", 1000)).toBe(true);
    expect(await leases.acquire("k", "b", 1000)).toBe(false);
    clock += 2000;
    expect(await leases.acquire("k", "b", 1000)).toBe(true);
  });
});
