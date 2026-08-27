import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { SettingsStore } from "./settings.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

/**
 * The picker's own endpoint.
 *
 * Worth covering separately from the resolution it reports: a route that
 * answers correctly but forgets to persist, or persists but reports the old
 * answer back, is a control that appears to do nothing — which is the exact
 * complaint that led here.
 */

const dir = mkdtempSync(join(tmpdir(), "dash-model-routes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
const vault = LocalAesVault.fromEnvOrDevFile(join(dir, "master-key"));
const keys = new KeyStore(vault, join(dir, "vault.json"));

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DASH_LLM_MODEL: process.env.DASH_LLM_MODEL,
  };
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;
  delete process.env.DASH_LLM_MODEL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const makeApp = (name: string) =>
  buildServer({ store, keys, settings: new SettingsStore(join(dir, `${name}.json`)) });

describe("GET /api/models", () => {
  it("reports every action, what runs it, and where that came from", async () => {
    const body = (await makeApp("get").inject({ method: "GET", url: "/api/models" })).json();

    expect(body.tasks).toHaveLength(8);
    const widget = body.tasks.find((task: { id: string }) => task.id === "widget");
    expect(widget).toMatchObject({
      tier: "capable",
      selected: null,
      effective: "claude-sonnet-5",
      source: "tier",
      available: true,
    });
    expect(body.tasks.find((task: { id: string }) => task.id === "chat")).toMatchObject({
      tier: "fast",
      effective: "claude-haiku-4-5",
    });
  });

  /*
   * Beside the picker deliberately: a per-task choice is a spending decision,
   * and the numbers that would justify it should not live somewhere else.
   */
  it("carries the running spend and the date the rates were read", async () => {
    const body = (await makeApp("spend").inject({ method: "GET", url: "/api/models" })).json();
    expect(body.spend).toMatchObject({ usd: expect.any(Number), calls: expect.any(Number) });
    expect(body.spend.byTask).toBeTypeOf("object");
    expect(body.ratesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("marks a model whose provider has no key as unavailable", async () => {
    const body = (await makeApp("keys").inject({ method: "GET", url: "/api/models" })).json();
    const openai = body.models.find((model: { id: string }) => model.id === "gpt-4.1");
    expect(openai.available).toBe(false);
    expect(body.providers).toEqual({ anthropic: true, openai: false });
  });
});

describe("PUT /api/models", () => {
  it("routes one action without touching the others", async () => {
    const app = makeApp("one");
    const put = await app.inject({
      method: "PUT",
      url: "/api/models",
      payload: { task: "widget", model: "claude-opus-5" },
    });
    expect(put.statusCode).toBe(200);

    const tasks = put.json().tasks as Array<{ id: string; effective: string; source: string }>;
    expect(tasks.find((task) => task.id === "widget")).toMatchObject({
      effective: "claude-opus-5",
      source: "task",
    });
    expect(tasks.find((task) => task.id === "chat")).toMatchObject({
      effective: "claude-haiku-4-5",
      source: "tier",
    });

    // Read back through a fresh request, because persisting and reporting are
    // two different things and only one of them was just proved.
    const again = (await app.inject({ method: "GET", url: "/api/models" })).json();
    expect(
      again.tasks.find((task: { id: string }) => task.id === "widget").selected,
    ).toBe("claude-opus-5");
  });

  it("clears a choice back to the default", async () => {
    const app = makeApp("clear");
    await app.inject({
      method: "PUT",
      url: "/api/models",
      payload: { task: "widget", model: "claude-opus-5" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/models",
      payload: { task: "widget", model: null },
    });

    const widget = (cleared.json().tasks as Array<{ id: string; source: string }>).find(
      (task) => task.id === "widget",
    );
    expect(widget).toMatchObject({ selected: null, source: "tier" });
  });

  it("applies a global override to every action", async () => {
    const app = makeApp("global");
    const put = await app.inject({
      method: "PUT",
      url: "/api/models",
      payload: { model: "claude-opus-5" },
    });

    const tasks = put.json().tasks as Array<{ effective: string; source: string }>;
    expect(tasks.every((task) => task.effective === "claude-opus-5")).toBe(true);
    expect(tasks.every((task) => task.source === "global")).toBe(true);
  });

  it("refuses a task name it does not perform", async () => {
    const reply = await makeApp("bad-task").inject({
      method: "PUT",
      url: "/api/models",
      payload: { task: "author", model: "claude-opus-5" },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toContain("author");
  });

  it("refuses a model whose provider has no key, rather than routing to silence", async () => {
    const reply = await makeApp("no-key").inject({
      method: "PUT",
      url: "/api/models",
      payload: { task: "widget", model: "gpt-4.1" },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toContain("OPENAI_API_KEY");
  });

  it("refuses something that is not a model id at all", async () => {
    const reply = await makeApp("nonsense").inject({
      method: "PUT",
      url: "/api/models",
      payload: { model: "llama-3-70b" },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toContain("Anthropic or OpenAI");
  });
});
