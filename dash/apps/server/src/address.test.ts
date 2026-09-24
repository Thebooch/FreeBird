import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { catalogEntrySchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./catalog.js";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

/**
 * Connecting an API that lives at a different address for every account and
 * logs in with two values — Rentvine, as its own documentation describes it.
 *
 * What has to hold, end to end: nothing is sent until the address is known,
 * the address is built from the person's values and nothing else, and both
 * halves of the login reach the API.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const RENTVINE = catalogEntrySchema.parse({
  id: "rentvine",
  title: "Rentvine",
  baseUrl: "https://example.rentvine.com/api/manager",
  server: {
    url: "https://{account}.rentvine.com/api/manager",
    variables: [
      { name: "account", label: "Account", description: "Your account subdomain", default: "example" },
      { name: "version", label: "Version", default: "v1" },
    ],
  },
  dialect: {
    auth: {
      type: "basic",
      usernameRef: "rentvine-key-user",
      keyRef: "rentvine-key",
      usernameLabel: "Access key",
      label: "Secret",
    },
  },
  ops: [{ id: "properties", title: "Properties", path: "/properties" }],
  validateOpId: "properties",
});

const calls: Array<{ url: string; authorization?: string }> = [];
const http: HttpFetch = async (url, init) => {
  calls.push({ url, ...(init.headers.authorization ? { authorization: init.headers.authorization } : {}) });
  return { status: 200, text: "[]", url, header: () => null };
};

const makeApp = () => buildServer({ store, keys, catalog, llm: null, http });

beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "dash-address-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
  catalog.put(RENTVINE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const connect = async (app: ReturnType<typeof makeApp>) =>
  (
    await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "rentvine", id: "rv" },
    })
  ).json() as { needsAddress: boolean; needsKey: boolean; baseUrl: string };

const address = (app: ReturnType<typeof makeApp>, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/connections/rv/address", payload });

describe("an API hosted per account", () => {
  it("asks for the address, keeping only the defaults that are real values", async () => {
    const app = makeApp();
    const created = await connect(app);
    expect(created.needsAddress).toBe(true);
    const stored = store.getConnection("rv")!;
    /* "example" is a placeholder and is left for the person; "v1" is kept. */
    expect(stored.server?.values).toEqual({ version: "v1" });
    expect(stored.addressPending).toBe(true);
    await app.close();
  });

  it("sends nothing, key or not, until the address is given", async () => {
    const app = makeApp();
    await connect(app);
    const validated = await app.inject({ method: "POST", url: "/api/connections/rv/validate" });
    expect(JSON.stringify(validated.json())).toMatch(/needs its address/);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("builds the address from the person's values", async () => {
    const app = makeApp();
    await connect(app);
    const saved = await address(app, { values: { account: "123pm", version: "v1" } });
    expect(saved.statusCode).toBe(200);
    const stored = store.getConnection("rv")!;
    expect(stored.baseUrl).toBe("https://123pm.rentvine.com/api/manager");
    expect(stored.addressPending).toBeUndefined();
    expect(stored.server?.values).toEqual({ account: "123pm", version: "v1" });
    /* A new address is a new account: nothing cached for the old one shows. */
    expect(stored.credentialsRevision).toBe(1);
    await app.close();
  });

  it("says which blank is missing", async () => {
    const app = makeApp();
    await connect(app);
    const result = await address(app, { values: { version: "v1" } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toMatch(/Fill in Account/);
    await app.close();
  });

  it("refuses a value that would send the request somewhere else", async () => {
    const app = makeApp();
    await connect(app);
    const result = await address(app, { values: { account: "evil.com/x", version: "v1" } });
    expect(result.statusCode).toBe(400);
    expect(store.getConnection("rv")?.baseUrl).toBe("https://example.rentvine.com/api/manager");
    await app.close();
  });

  it("takes a whole address instead, and drops the template", async () => {
    const app = makeApp();
    await connect(app);
    const result = await address(app, { baseUrl: "https://api.other-host.com/v2/" });
    expect(result.statusCode).toBe(200);
    const stored = store.getConnection("rv")!;
    expect(stored.baseUrl).toBe("https://api.other-host.com/v2");
    expect(stored.server).toBeUndefined();
    await app.close();
  });

  it("refuses an address that is not a web address, or carries a login", async () => {
    const app = makeApp();
    await connect(app);
    expect((await address(app, { baseUrl: "ftp://files.example.com" })).statusCode).toBe(400);
    expect((await address(app, { baseUrl: "https://me:pw@api.example.com" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("a Basic login where both halves are the person's", () => {
  it("names each credential for this connection and sends both", async () => {
    const app = makeApp();
    await connect(app);
    await address(app, { values: { account: "123pm", version: "v1" } });

    const stored = store.getConnection("rv")!;
    expect(stored.auth).toMatchObject({ type: "basic", usernameLabel: "Access key", label: "Secret" });
    const auth = stored.auth as { usernameRef: string; keyRef: string };
    /* Its own vault names, not the catalog's placeholders. */
    expect(auth.usernameRef).not.toBe("rentvine-key-user");
    expect(auth.keyRef).not.toBe("rentvine-key");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/connections/rv/key",
      payload: { keys: { [auth.usernameRef]: "AK123", [auth.keyRef]: "shh" } },
    });
    expect(saved.statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/api/connections/rv/validate" });
    expect(calls[0]?.url).toBe("https://123pm.rentvine.com/api/manager/properties");
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from("AK123:shh").toString("base64")}`);
    await app.close();
  });
});
