import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import { fakeLlm } from "@freebirdai/dash-agent";
import type { CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import {
  CATEGORY_VERSION,
  catalogEntrySchema,
  connectionSchema,
  dashboardSchema,
} from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../catalog.js";
import { currentFingerprint } from "../onboarding/service.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { categoryState, offersFor } from "./onboarding.js";

/**
 * Onboarding over HTTP: what the wizard's last steps actually talk to.
 *
 * Every model call here is a fake, so preparing an API is exercised without
 * spending anything — and the boards that come out are built by the real
 * compiler, checked through the real cache, against a pretend API that
 * answers the way a real one would.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;
let catalog: CatalogStore;

const ENTITIES = [
  {
    id: "task",
    resource: "task",
    name: { one: "Task", many: "Tasks" },
    kind: "work",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"], status: "Status" },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Summary", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary", values: ["Open", "Closed"] },
      { path: "DueDate", label: "Due date", semantic: "timestamp", visibility: "detail" },
    ],
  },
  {
    id: "lease",
    resource: "lease",
    name: { one: "Lease", many: "Leases" },
    kind: "document",
    identity: { field: "Id", observed: true },
    display: { title: ["Title"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Title", label: "Reference", visibility: "primary" },
      { path: "Status", label: "Status", visibility: "primary" },
    ],
  },
];

const entry = (input: Partial<CatalogEntry> = {}): CatalogEntry =>
  catalogEntrySchema.parse({
    id: "acme",
    title: "Acme",
    baseUrl: "https://api.example.com",
    dialect: { auth: { type: "none" } },
    ops: [
      { id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" },
      { id: "leases_list", title: "Retrieve all leases", path: "/v1/leases" },
    ],
    resources: [
      { id: "task", title: "Tasks", listOp: "tasks_list" },
      { id: "lease", title: "Leases", listOp: "leases_list" },
    ],
    entities: ENTITIES,
    ...input,
  });

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  catalog: "acme",
  ops: [
    { id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" },
    { id: "leases_list", title: "Retrieve all leases", path: "/v1/leases" },
  ],
  resources: [
    { id: "task", title: "Tasks", listOp: "tasks_list" },
    { id: "lease", title: "Leases", listOp: "leases_list" },
  ],
});

const DIVISION = {
  product: "Property management software.",
  domain: "property management",
  categories: [
    { title: "Maintenance", description: "Work on the properties.", entities: ["task"] },
    { title: "Leasing", description: "Agreements on units.", entities: ["lease"] },
  ],
};

const COMPOSITION = {
  widgets: [
    { entity: "task", intent: "measure", title: "Open work", importance: 5, size: "sm" },
    { entity: "task", intent: "compare", groupBy: "Status", importance: 4, size: "md" },
    { entity: "task", intent: "records", importance: 2, size: "lg" },
  ],
};

const LEASE_COMPOSITION = {
  widgets: [{ entity: "lease", intent: "records", title: "Leases", importance: 3 }],
};

const RHYTHM = {
  ratings: [
    { entity: "task", changes: "constant", because: "work comes in all day" },
    { entity: "lease", changes: "rare", because: "a lease is signed once" },
    { entity: "ghost", changes: "constant" },
  ],
};

/** Every model call a whole API takes, in the order they are made. */
const WHOLE_API = [
  { args: DIVISION },
  { args: COMPOSITION },
  { args: LEASE_COMPOSITION },
  { args: RHYTHM },
];

/** A composed catalog entry, so the connection routes need no model at all. */
const composed = (input: Partial<CatalogEntry> = {}): CatalogEntry => {
  const base = entry({
    profile: { summary: "Property management software.", domain: "property management" },
    categories: [
      {
        id: "maintenance",
        title: "Maintenance",
        description: "Work on the properties.",
        entities: ["task"],
        status: "ready",
        starters: [
          { brief: { entity: "task", intent: "measure", title: "Open work" }, importance: 5, size: "sm" },
          { brief: { entity: "task", intent: "compare", groupBy: "Status" }, importance: 4 },
          { brief: { entity: "task", intent: "records" }, importance: 2, size: "lg" },
        ],
      },
      {
        id: "leasing",
        title: "Leasing",
        entities: ["lease"],
        status: "ready",
        starters: [{ brief: { entity: "lease", intent: "records" }, importance: 3 }],
      },
    ],
    categoriesAt: new Date("2026-09-01T00:00:00Z").toISOString(),
    categoryVersion: CATEGORY_VERSION,
    rhythm: { recordTypes: { task: "constant", lease: "rare" }, because: {} },
    ...input,
  });
  return { ...base, categoryFingerprint: currentFingerprint(base) };
};

const ROWS: Record<string, unknown[]> = {
  "/v1/tasks": [
    { Id: 1, Title: "Fix the boiler", Status: "Open", DueDate: "2026-09-10" },
    { Id: 2, Title: "Paint the hall", Status: "Closed", DueDate: "2026-09-12" },
  ],
  "/v1/leases": [{ Id: 9, Title: "Unit 4", Status: "Active" }],
};

/** A pretend API. `refuse` maps a path to the status it answers with. */
const api = (refuse: Record<string, number> = {}): HttpFetch & { urls: string[] } => {
  const urls: string[] = [];
  const fetch: HttpFetch = async (url) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const status = refuse[path];
    if (status) return { status, text: "{}", url, header: () => null };
    return { status: 200, text: JSON.stringify(ROWS[path] ?? []), url, header: () => null };
  };
  return Object.assign(fetch, { urls });
};

const makeApp = (input: { llm?: LlmAdapter; http?: HttpFetch } = {}) =>
  buildServer({
    store,
    keys,
    catalog,
    llm: input.llm ?? null,
    ...(input.http ? { http: input.http } : {}),
  });

const prepare = async (app: ReturnType<typeof makeApp>) =>
  (await app.inject({ method: "POST", url: "/api/connections/acme/onboarding/prepare" })).json() as {
    step: { step: string; ok: boolean; error?: string };
    state: { remaining: number; divided: boolean };
    categories: { id: string; status: string; available: boolean }[];
  };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-onboarding-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  catalog = new CatalogStore(join(dir, "seed"), join(dir, "overlay"));
  catalog.put(entry());
  store.putConnection(connection);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("categoryState", () => {
  it("reports an API nobody has divided", () => {
    const state = categoryState(entry());
    expect(state).toMatchObject({ divided: false, stale: false, categories: 0 });
    expect(state.remaining).toBeGreaterThan(0);
  });

  it("counts the parts that are ready, and what is left", () => {
    expect(categoryState(composed())).toMatchObject({
      divided: true,
      composed: 2,
      starters: 4,
      rhythm: true,
      remaining: 0,
    });
  });

  /* The version only notices when the code changes. The fingerprint notices
   * when the API does. */
  it("calls a division made against an older reading of the API stale", () => {
    expect(categoryState({ ...composed(), categoryFingerprint: "older" }).stale).toBe(true);
  });

  it("does not call a division stale just for predating fingerprints", () => {
    expect(categoryState({ ...composed(), categoryFingerprint: undefined }).stale).toBe(false);
  });
});

describe("POST /api/catalog/:id/categories", () => {
  it("divides the API, composes each part and reads how often records arrive", async () => {
    const llm = fakeLlm(WHOLE_API);
    const app = makeApp({ llm });
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });

    expect(result.statusCode).toBe(200);
    const body = result.json() as {
      ranPass: boolean;
      categories: number;
      composed: number;
      errors: string[];
      profile?: { domain?: string };
    };
    expect(body).toMatchObject({ ranPass: true, categories: 2, composed: 2, errors: [] });
    expect(body.profile?.domain).toBe("property management");
    /* One call to divide, one per part, one for the rhythm. */
    expect(llm.calls).toHaveLength(4);

    const stored = catalog.get("acme");
    expect(stored?.categories.map((one) => [one.id, one.status])).toEqual([
      ["maintenance", "ready"],
      ["leasing", "ready"],
    ]);
    expect(stored?.categoryFingerprint).toBe(currentFingerprint(stored!));
    expect(stored?.rhythm?.recordTypes).toEqual({ task: "constant", lease: "rare" });
    expect(stored?.rhythm?.because.task).toBe("work comes in all day");
    await app.close();
  });

  it("makes no request against the API it is describing", async () => {
    const http = api();
    const app = makeApp({ llm: fakeLlm(WHOLE_API), http });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(http.urls).toEqual([]);
    await app.close();
  });

  it("declines an API whose records nobody has described", async () => {
    catalog.put(entry({ entities: [] }));
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toMatch(/records have not been described/);
    await app.close();
  });

  it("says it needs an AI key rather than failing obscurely", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toMatch(/needs an AI key/);
    await app.close();
  });

  /* Re-dividing re-ids every part. A finished API is left alone. */
  it("does nothing when everything is already prepared", async () => {
    catalog.put(composed());
    const llm = fakeLlm(WHOLE_API);
    const app = makeApp({ llm });
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.json().ranPass).toBe(false);
    expect(llm.calls).toEqual([]);
    await app.close();
  });

  it("composes the one missing part without re-dividing the API", async () => {
    const whole = composed();
    catalog.put({
      ...whole,
      categories: [
        whole.categories[0]!,
        { ...whole.categories[1]!, starters: [], status: "pending" },
      ],
    });
    const llm = fakeLlm([{ args: LEASE_COMPOSITION }]);
    const app = makeApp({ llm });
    const result = await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(result.json().composed).toBe(2);
    expect(llm.calls).toHaveLength(1);
    await app.close();
  });

  /* Rhythm used to be read only by the call that divides an API, so an API
   * divided before it existed could never be read short of re-dividing it. */
  it("reads how often records arrive on an API divided before that existed", async () => {
    catalog.put(composed({ rhythm: undefined }));
    const llm = fakeLlm([{ args: RHYTHM }]);
    const app = makeApp({ llm });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    expect(llm.calls).toHaveLength(1);
    expect(catalog.get("acme")?.categories.map((one) => one.id)).toEqual([
      "maintenance",
      "leasing",
    ]);
    expect(catalog.get("acme")?.rhythm?.recordTypes.task).toBe("constant");
    await app.close();
  });
});

describe("POST /api/connections/:id/onboarding/prepare", () => {
  /* One step per request, so no request is long and every step is written
   * the moment it lands. */
  it("takes one step at a time until nothing is left", async () => {
    const llm = fakeLlm(WHOLE_API);
    const app = makeApp({ llm });

    const first = await prepare(app);
    expect(first.step).toMatchObject({ step: "divided", ok: true });
    expect(llm.calls).toHaveLength(1);
    expect(first.categories.map((one) => one.status)).toEqual(["pending", "pending"]);

    const steps = [first.step.step];
    let state = first.state;
    while (state.remaining > 0) {
      const next = await prepare(app);
      steps.push(next.step.step);
      state = next.state;
    }
    expect(steps).toEqual(["divided", "composed", "composed", "rhythm"]);
    expect((await prepare(app)).step.step).toBe("none");
    expect(llm.calls).toHaveLength(4);
    await app.close();
  });

  it("keeps going past a part that failed, and retries it last", async () => {
    const llm = fakeLlm([
      { args: DIVISION },
      /* Maintenance: no tool call, twice — the retry fails too. */
      { text: "I would rather not." },
      { text: "Still no." },
      { args: LEASE_COMPOSITION },
      { args: RHYTHM },
      { args: COMPOSITION },
    ]);
    const app = makeApp({ llm });
    await prepare(app);

    const failed = await prepare(app);
    expect(failed.step).toMatchObject({ step: "composed", ok: false });
    expect(failed.categories.find((one) => one.id === "maintenance")?.status).toBe("failed");

    expect((await prepare(app)).step.step).toBe("composed");
    expect((await prepare(app)).step.step).toBe("rhythm");
    const retried = await prepare(app);
    expect(retried.step).toMatchObject({ step: "composed", ok: true });
    expect(retried.state.remaining).toBe(0);
    await app.close();
  });

  /* Composed, and nothing could be built: asking the same question of the
   * same record types gets the same refusals, so it is not paid for again. */
  it("does not pay again for a part where nothing could be built", async () => {
    const hopeless = {
      widgets: [{ entity: "lease", intent: "measure", measureAgg: "sum", measureField: "Title" }],
    };
    const llm = fakeLlm([
      { args: DIVISION },
      { args: COMPOSITION },
      { args: hopeless },
      { args: hopeless },
      { args: RHYTHM },
    ]);
    const app = makeApp({ llm });
    let state = (await prepare(app)).state;
    while (state.remaining > 0) state = (await prepare(app)).state;

    expect(catalog.get("acme")?.categories.find((one) => one.id === "leasing")?.status).toBe(
      "empty",
    );
    const calls = llm.calls.length;
    expect((await prepare(app)).step.step).toBe("none");
    expect(llm.calls).toHaveLength(calls);
    await app.close();
  });

  it("runs one preparation at a time", async () => {
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    const [one, two] = await Promise.all([
      app.inject({ method: "POST", url: "/api/connections/acme/onboarding/prepare" }),
      app.inject({ method: "POST", url: "/api/connections/acme/onboarding/prepare" }),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    await app.close();
  });

  /* Shared with everybody who connects this API: never a reading of an API
   * that changed while it was being made. */
  it("does not publish work done against an API re-described mid-call", async () => {
    const inner = fakeLlm(WHOLE_API);
    const llm: LlmAdapter = {
      ...inner,
      generate: async (opts) => {
        const answer = await inner.generate(opts);
        catalog.put(entry({ entities: [ENTITIES[0]] as never }));
        return answer;
      },
    };
    const app = makeApp({ llm });
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/acme/onboarding/prepare",
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toMatch(/re-described/);
    expect(catalog.get("acme")?.categories).toEqual([]);
    await app.close();
  });
});

describe("GET /api/connections/:id/onboarding", () => {
  beforeEach(() => catalog.put(composed()));

  it("offers the parts, with what each opens with", async () => {
    const app = makeApp();
    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" })
    ).json() as {
      categories: { id: string; widgets: number; available: boolean }[];
      profile?: { summary: string };
      setup: { status: string };
    };
    expect(body.categories.map((one) => [one.id, one.widgets, one.available])).toEqual([
      ["maintenance", 3, true],
      ["leasing", 1, true],
    ]);
    expect(body.profile?.summary).toBe("Property management software.");
    expect(body.setup.status).toBe("pending");
    await app.close();
  });

  /* Every field defaults, so another experiment's record parsed into a setup
   * that said "done" over no boards. */
  it("does not read a foreign record as a finished setup", async () => {
    store.putConnection({
      ...connection,
      onboarding: { dashboardIds: [], templateRevision: "v1-x" } as never,
    });
    const app = makeApp();
    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" })
    ).json() as { setup: { status: string } };
    expect(body.setup.status).toBe("pending");
    await app.close();
  });

  it("reads a setup the first version finished", async () => {
    store.putDashboard(dashboardSchema.parse({ id: "maintenance", title: "Maintenance", widgets: [] }));
    store.putConnection({
      ...connection,
      onboarding: {
        chose: ["maintenance"],
        layout: "per-category",
        boards: [{ category: "maintenance", dashboard: "maintenance" }, { dashboard: "gone" }],
        at: "2026-09-21T00:00:00.000Z",
      } as never,
    });
    const app = makeApp();
    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/onboarding" })
    ).json() as { setup: { status: string }; boards: { dashboard: string }[] };
    expect(body.setup.status).toBe("complete");
    /* A board deleted since is not reported as there. */
    expect(body.boards.map((one) => one.dashboard)).toEqual(["maintenance"]);
    await app.close();
  });

  it("404s a connection that does not exist", async () => {
    const app = makeApp();
    const result = await app.inject({ method: "GET", url: "/api/connections/nope/onboarding" });
    expect(result.statusCode).toBe(404);
    await app.close();
  });
});

type Status = {
  setup: {
    status: string;
    dashboards: string[];
    notes: string[];
    preview?: {
      id: string;
      boards: { category?: string; board: { id: string; title: string; widgets: unknown[] } }[];
      checks: { widget: string; title: string; status: string; message: string }[];
    };
  };
  boards: { dashboard: string; title: string }[];
};

const choose = async (
  app: ReturnType<typeof makeApp>,
  categories: string[],
  layout: "single" | "per-category" = "per-category",
) =>
  app.inject({
    method: "PUT",
    url: "/api/connections/acme/onboarding/choices",
    payload: { categories, layout },
  });

const preview = async (app: ReturnType<typeof makeApp>) =>
  app.inject({ method: "POST", url: "/api/connections/acme/onboarding/preview" });

const commit = async (app: ReturnType<typeof makeApp>, previewId: string) =>
  app.inject({
    method: "POST",
    url: "/api/connections/acme/onboarding/commit",
    payload: { previewId },
  });

describe("choose, preview, create", () => {
  beforeEach(() => catalog.put(composed()));

  it("previews the boards checked against the account, and writes nothing", async () => {
    const http = api();
    const app = makeApp({ http });
    expect((await choose(app, ["maintenance", "leasing"])).statusCode).toBe(200);
    const before = store.listDashboards().length;

    const result = await preview(app);
    expect(result.statusCode).toBe(200);
    const body = result.json() as Status;
    expect(body.setup.status).toBe("preview");
    expect(body.setup.preview?.boards.map((one) => one.board.title)).toEqual([
      "Maintenance",
      "Leasing",
    ]);
    expect(body.setup.preview?.checks.every((one) => one.status === "ready")).toBe(true);
    /* Two endpoints, each read once however many widgets use it. */
    expect(new Set(http.urls.map((url) => new URL(url).pathname))).toEqual(
      new Set(["/v1/tasks", "/v1/leases"]),
    );
    expect(store.listDashboards()).toHaveLength(before);
    await app.close();
  });

  it("creates exactly what was previewed", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance", "leasing"]);
    const shown = (await preview(app)).json() as Status;

    const result = await commit(app, shown.setup.preview!.id);
    expect(result.statusCode).toBe(200);
    const body = result.json() as Status & { created: { dashboard: string; widgets: number }[] };
    expect(body.setup.status).toBe("complete");
    expect(body.created.map((one) => one.dashboard)).toEqual(
      shown.setup.preview!.boards.map((one) => one.board.id),
    );
    for (const one of body.created) {
      expect(store.getDashboard(one.dashboard)?.widgets).toHaveLength(one.widgets);
    }
    await app.close();
  });

  /* The check reads through the cache under the key the board will read, so
   * opening the new boards costs nothing — and the keeper agrees on the keys. */
  it("leaves the new boards' queries already in the cache", async () => {
    const http = api();
    const app = makeApp({ http });
    await choose(app, ["maintenance", "leasing"]);
    const shown = (await preview(app)).json() as Status;
    await commit(app, shown.setup.preview!.id);

    const keeper = (await app.inject({ method: "GET", url: "/api/keeper" })).json() as {
      targets: { op: string; because: string; cached: boolean }[];
    };
    const widgets = keeper.targets.filter((one) => one.because === "widget");
    expect(widgets.length).toBeGreaterThan(0);
    expect(widgets.every((one) => one.cached)).toBe(true);
    await app.close();
  });

  it("puts everything on one board named after the connection when asked", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance", "leasing"], "single");
    const body = (await preview(app)).json() as Status;
    expect(body.setup.preview?.boards.map((one) => one.board.title)).toEqual(["Acme"]);
    await app.close();
  });

  it("leaves off a widget the account is refused, and says why", async () => {
    const app = makeApp({ http: api({ "/v1/leases": 403 }) });
    await choose(app, ["maintenance", "leasing"]);
    const body = (await preview(app)).json() as Status;
    expect(body.setup.preview?.boards.map((one) => one.board.title)).toEqual(["Maintenance"]);
    expect(body.setup.preview?.checks.find((one) => one.status === "denied")?.message).toMatch(
      /not allowed/,
    );
    await app.close();
  });

  /* A rate limit is not a reason to design a widget away. */
  it("keeps a widget it could not check because the API said wait", async () => {
    const app = makeApp({ http: api({ "/v1/leases": 429 }) });
    await choose(app, ["maintenance", "leasing"]);
    const body = (await preview(app)).json() as Status;
    expect(body.setup.preview?.boards.map((one) => one.board.title)).toEqual([
      "Maintenance",
      "Leasing",
    ]);
    expect(body.setup.preview?.checks.find((one) => one.title === "Leases")?.status).toBe(
      "unchecked",
    );
    await app.close();
  });

  it("stops at a refused key and says to fix it", async () => {
    const app = makeApp({ http: api({ "/v1/tasks": 401, "/v1/leases": 401 }) });
    await choose(app, ["maintenance"]);
    const result = await preview(app);
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toMatch(/refused the key/);
    await app.close();
  });

  it("refuses to create from a preview that is not the one on record", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance"]);
    await preview(app);
    const result = await commit(app, "not-this-one");
    expect(result.statusCode).toBe(409);
    await app.close();
  });

  it("refuses to create once the connection has changed since the preview", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance"]);
    const shown = (await preview(app)).json() as Status;
    store.putConnection({ ...store.getConnection("acme")!, credentialsRevision: 3 });
    const result = await commit(app, shown.setup.preview!.id);
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toMatch(/changed since this preview/);
    await app.close();
  });

  /* A create that died half way finishes the same boards — and never
   * overwrites one that was already written, which somebody may be using. */
  it("finishes an interrupted create without touching what it already wrote", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance", "leasing"]);
    const shown = (await preview(app)).json() as Status;
    const [first, second] = shown.setup.preview!.boards;

    const current = store.getConnection("acme")!;
    store.putConnection({
      ...current,
      onboarding: {
        ...current.onboarding!,
        status: "creating",
        dashboards: [first!.board.id, second!.board.id],
      },
    });
    store.putDashboard(
      dashboardSchema.parse({ id: first!.board.id, title: "Renamed by somebody", widgets: [] }),
    );

    const result = await commit(app, shown.setup.preview!.id);
    expect(result.statusCode).toBe(200);
    expect(store.getDashboard(first!.board.id)?.title).toBe("Renamed by somebody");
    expect(store.getDashboard(second!.board.id)?.title).toBe("Leasing");
    await app.close();
  });

  it("reserves another id when a board took the previewed one", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance"]);
    const shown = (await preview(app)).json() as Status;
    const reserved = shown.setup.preview!.boards[0]!.board.id;
    store.putDashboard(dashboardSchema.parse({ id: reserved, title: "Somebody else's", widgets: [] }));

    const body = (await commit(app, shown.setup.preview!.id)).json() as {
      created: { dashboard: string }[];
    };
    expect(body.created[0]?.dashboard).not.toBe(reserved);
    expect(store.getDashboard(reserved)?.title).toBe("Somebody else's");
    await app.close();
  });

  it("refuses a part that is not on this API", async () => {
    const app = makeApp();
    const result = await choose(app, ["nowhere"]);
    expect(result.statusCode).toBe(409);
    expect((result.json() as { notes: string[] }).notes.join(" ")).toMatch(/not a part/);
    await app.close();
  });

  it("refuses an empty choice", async () => {
    const app = makeApp();
    expect((await choose(app, [])).statusCode).toBe(400);
    await app.close();
  });

  /* Another set leaves the boards already made exactly as they are. */
  it("starts another set without touching the first", async () => {
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance"]);
    const shown = (await preview(app)).json() as Status;
    const made = (
      (await commit(app, shown.setup.preview!.id)).json() as { created: { dashboard: string }[] }
    ).created[0]!.dashboard;

    const restarted = (
      await app.inject({ method: "POST", url: "/api/connections/acme/onboarding/restart" })
    ).json() as Status;
    expect(restarted.setup.status).toBe("choosing");
    expect(store.getDashboard(made)).not.toBeNull();
    await app.close();
  });
});

describe("somewhere to land", () => {
  it("gives a connection made for onboarding no empty board", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "acme", id: "fresh", onboarding: true },
    });
    expect(result.statusCode).toBe(200);
    expect(store.getDashboard("fresh")).toBeNull();
    await app.close();
  });

  it("keeps the empty board for anything that did not ask for onboarding", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "acme", id: "plain" },
    });
    expect(store.getDashboard("plain")).not.toBeNull();
    await app.close();
  });

  it("gives the board back to somebody who skips setup", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections/from-catalog",
      payload: { catalogId: "acme", id: "later", onboarding: true },
    });
    const skipped = (
      await app.inject({ method: "POST", url: "/api/connections/later/onboarding/skip" })
    ).json() as Status;
    expect(skipped.setup.status).toBe("skipped");
    expect(store.getDashboard("later")).not.toBeNull();
    await app.close();
  });

  /* A client saving the connection from its own form does not send setup
   * progress, and must not wipe it by leaving it out. */
  it("keeps setup progress when a connection is saved without it", async () => {
    store.putConnection({
      ...connection,
      onboarding: { status: "skipped", dashboards: [], notes: [] },
    });
    const app = makeApp();
    const { onboarding: _dropped, ...rest } = store.getConnection("acme")!;
    await app.inject({ method: "PUT", url: "/api/connections/acme", payload: rest });
    expect(store.getConnection("acme")?.onboarding?.status).toBe("skipped");
    await app.close();
  });
});

describe("how often each endpoint is asked again", () => {
  it("stores the reading on the catalog entry, keyed by record type", async () => {
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });

    const stored = catalog.get("acme");
    expect(stored?.rhythm?.recordTypes).toMatchObject({ task: "constant", lease: "rare" });
    /* A rating for a record type this API does not have is refused. */
    expect(stored?.rhythm?.recordTypes).not.toHaveProperty("ghost");
    await app.close();
  });

  it("reports each endpoint's cadence and what decided it", async () => {
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });

    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/rhythm" })
    ).json() as {
      classified: boolean;
      tiers: { id: string }[];
      endpoints: { op: string; tier: string; source: string; because?: string }[];
    };
    expect(body.classified).toBe(true);
    expect(body.tiers.map((tier) => tier.id)).toEqual(["live", "daily"]);
    const tasks = body.endpoints.find((one) => one.op === "tasks_list");
    expect(tasks).toMatchObject({ tier: "live", source: "model" });
    expect(tasks?.because).toBe("work comes in all day");
    expect(body.endpoints.find((one) => one.op === "leases_list")).toMatchObject({
      tier: "daily",
      source: "model",
    });
    await app.close();
  });

  it("puts everything on the quick tier before any pass has run", async () => {
    const app = makeApp();
    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/rhythm" })
    ).json() as { classified: boolean; endpoints: { source: string; tier: string }[] };
    expect(body.classified).toBe(false);
    expect(body.endpoints.every((one) => one.source === "default" && one.tier === "live")).toBe(
      true,
    );
    await app.close();
  });

  /* Read from the warm set as it is now, not from the keeper's last tick —
   * somebody arriving straight after building boards must see them. */
  it("marks the endpoints a board reads before the keeper has run", async () => {
    catalog.put(composed());
    const app = makeApp({ http: api() });
    await choose(app, ["maintenance"]);
    const shown = (await preview(app)).json() as Status;
    await commit(app, shown.setup.preview!.id);

    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/rhythm" })
    ).json() as { endpoints: { op: string; warmed: boolean }[] };
    expect(body.endpoints.find((one) => one.op === "tasks_list")?.warmed).toBe(true);
    await app.close();
  });

  it("saves a move against this connection and nothing else", async () => {
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    const moved = await app.inject({
      method: "PUT",
      url: "/api/connections/acme/rhythm",
      payload: { overrides: { tasks_list: "daily" } },
    });
    expect(moved.statusCode).toBe(200);

    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/rhythm" })
    ).json() as { endpoints: { op: string; tier: string; source: string }[] };
    expect(body.endpoints.find((one) => one.op === "tasks_list")).toMatchObject({
      tier: "daily",
      source: "override",
    });
    expect(catalog.get("acme")?.rhythm?.recordTypes.task).toBe("constant");
    await app.close();
  });

  it("puts one back when it is cleared", async () => {
    const app = makeApp({ llm: fakeLlm(WHOLE_API) });
    await app.inject({ method: "POST", url: "/api/catalog/acme/categories" });
    for (const tier of ["daily", null]) {
      await app.inject({
        method: "PUT",
        url: "/api/connections/acme/rhythm",
        payload: { overrides: { tasks_list: tier } },
      });
    }
    const body = (
      await app.inject({ method: "GET", url: "/api/connections/acme/rhythm" })
    ).json() as { endpoints: { op: string; source: string }[] };
    expect(body.endpoints.find((one) => one.op === "tasks_list")?.source).toBe("model");
    await app.close();
  });

  it("refuses a cadence that is not on offer, and says which", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "PUT",
      url: "/api/connections/acme/rhythm",
      payload: { overrides: { tasks_list: "hourly" } },
    });
    expect((result.json() as { notes: string[] }).notes.join(" ")).toMatch(/not one of the cadences/);
    await app.close();
  });

  it("refuses an endpoint this connection does not carry", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "PUT",
      url: "/api/connections/acme/rhythm",
      payload: { overrides: { nothing_here: "daily" } },
    });
    expect((result.json() as { notes: string[] }).notes.join(" ")).toMatch(/not an endpoint/);
    await app.close();
  });
});

describe("offersFor", () => {
  it("says what each part covers and what it opens with", () => {
    const offers = offersFor({ connection, entry: composed() });
    expect(offers[0]).toMatchObject({
      id: "maintenance",
      title: "Maintenance",
      status: "ready",
      recordTypes: 1,
      widgets: 3,
      available: true,
    });
    expect(offers[0]?.opensWith).toEqual(["Open work", "Tasks", "Tasks"]);
  });

  /* The catalog describes the whole API; a connection holds what somebody
   * picked. An offer that cannot be executed is worse than no offer. */
  it("marks a part unavailable when this connection lacks its endpoints", () => {
    const partial = connectionSchema.parse({
      ...connection,
      ops: [{ id: "tasks_list", title: "Retrieve all tasks", path: "/v1/tasks" }],
      resources: [{ id: "task", title: "Tasks", listOp: "tasks_list" }],
    });
    expect(offersFor({ connection: partial, entry: composed() }).find((one) => one.id === "leasing")).toMatchObject({
      available: false,
      unavailable: "This connection does not carry the endpoints behind these records.",
    });
  });

  it("says a part has not been prepared yet, and why one came out empty", () => {
    const whole = composed();
    const offers = offersFor({
      connection,
      entry: {
        ...whole,
        categories: [
          { ...whole.categories[0]!, starters: [], status: "pending" },
          { ...whole.categories[1]!, starters: [], status: "empty" },
        ],
      },
    });
    expect(offers[0]).toMatchObject({ available: false, unavailable: "Not prepared yet." });
    expect(offers[1]?.unavailable).toMatch(/could be built/);
  });
});
