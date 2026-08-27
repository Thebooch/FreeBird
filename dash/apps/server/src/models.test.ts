import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicAdapter, availableProviders, defaultModelId, llmForModel, openAiAdapter } from "./llm.js";
import { MODELS, capabilitiesFor, findModel, providerFor } from "./models.js";
import { SettingsStore } from "./settings.js";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DASH_LLM_MODEL"] as const;
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "dash-settings-"));
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Captures the request body so the wire shape can be asserted directly. */
const captureBody = () => {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "ok" }], choices: [{ message: {} }] }),
      text: async () => "{}",
    } as unknown as Response;
  });
  return sent;
};

const ask = { messages: [{ role: "user" as const, content: "hi" }] };

describe("model capability table", () => {
  it("marks the models that removed sampling parameters", () => {
    // The live 400 that motivated this: "`temperature` is deprecated for this model."
    expect(findModel("claude-sonnet-5")?.supportsTemperature).toBe(false);
    expect(findModel("claude-opus-5")?.supportsTemperature).toBe(false);
    expect(findModel("claude-opus-4-8")?.supportsTemperature).toBe(false);
    expect(findModel("claude-sonnet-4-6")?.supportsTemperature).toBe(true);
  });

  it("assumes an unknown model supports nothing optional", () => {
    // Omitting a parameter never 400s; sending an unsupported one does.
    expect(capabilitiesFor("claude-something-unreleased").supportsTemperature).toBe(false);
  });

  it("routes ids to a provider, including ones not in the table", () => {
    expect(providerFor("claude-sonnet-5")).toBe("anthropic");
    expect(providerFor("gpt-4o-mini")).toBe("openai");
    expect(providerFor("claude-future-9")).toBe("anthropic");
    expect(providerFor("o3-mini")).toBe("openai");
    expect(providerFor("llama-3")).toBeNull();
  });

  it("every listed model routes to its own provider", () => {
    for (const model of MODELS) expect(providerFor(model.id)).toBe(model.provider);
  });
});

describe("temperature is omitted where it would 400", () => {
  it("does not send temperature to Claude Sonnet 5", async () => {
    const sent = captureBody();
    await anthropicAdapter("key", { model: "claude-sonnet-5" }).generate(ask);
    expect(sent[0]).not.toHaveProperty("temperature");
  });

  it("still sends it to a model that accepts it", async () => {
    const sent = captureBody();
    await anthropicAdapter("key", { model: "claude-sonnet-4-6" }).generate(ask);
    expect(sent[0]?.temperature).toBe(0.2);
  });

  it("decides per call, not per adapter", async () => {
    const sent = captureBody();
    // An adapter built for an old model, invoked for a new one.
    const adapter = anthropicAdapter("key", { model: "claude-sonnet-4-6" });
    await adapter.generate({ ...ask, model: "claude-opus-5" });
    expect(sent[0]).not.toHaveProperty("temperature");
  });

  it("omits it for OpenAI reasoning models too", async () => {
    const sent = captureBody();
    await openAiAdapter("key", { model: "o3-mini" }).generate(ask);
    expect(sent[0]).not.toHaveProperty("temperature");

    await openAiAdapter("key", { model: "gpt-4o-mini" }).generate(ask);
    expect(sent[1]?.temperature).toBe(0.2);
  });
});

describe("provider routing", () => {
  it("builds nothing when the model's provider has no key", () => {
    process.env.OPENAI_API_KEY = "sk-oai";
    expect(llmForModel("claude-sonnet-5")).toBeNull();
    expect(llmForModel("gpt-4o-mini")).not.toBeNull();
  });

  it("reports which providers are reachable", () => {
    expect(availableProviders()).toEqual({ anthropic: false, openai: false });
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(availableProviders()).toEqual({ anthropic: true, openai: false });
  });

  it("falls back to a provider default, and lets the env pin win", () => {
    expect(defaultModelId()).toBeNull();

    process.env.OPENAI_API_KEY = "sk-oai";
    expect(defaultModelId()).toBe("gpt-4.1-mini");

    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(defaultModelId()).toBe("claude-sonnet-5");

    process.env.DASH_LLM_MODEL = "claude-opus-5";
    expect(defaultModelId()).toBe("claude-opus-5");
  });
});

describe("SettingsStore", () => {
  it("round-trips a choice", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    expect(store.read().model).toBeNull();
    store.setModel("claude-opus-5");
    expect(new SettingsStore(join(dir, "settings.json")).read().model).toBe("claude-opus-5");
  });

  it("treats null and blank as clearing the choice", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    store.setModel("claude-opus-5");
    store.setModel("   ");
    expect(store.read().model).toBeNull();
  });

  it("survives a corrupt file rather than refusing to boot", () => {
    const path = join(dir, "settings.json");
    const store = new SettingsStore(path);
    store.setModel("claude-opus-5");
    require("node:fs").writeFileSync(path, "{not json", "utf8");
    expect(store.read().model).toBeNull();
  });
});
