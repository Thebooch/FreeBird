import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelForTask, preferredProvider, sourceForTask } from "./llm.js";
import { DEFAULT_PROVIDER, TASKS, TIER_MODELS, findTask, isTask } from "./models.js";
import { SettingsStore } from "./settings.js";

/**
 * Which model runs which action, and why.
 *
 * The order is the whole feature: an env pin has to beat a stored choice, a
 * per-task choice has to beat the global one, and the defaults have to be
 * right with no configuration at all — because that is what almost every
 * install runs, and a default nobody checks is a default nobody has.
 */

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DASH_LLM_MODEL",
  "DASH_REVIEW_MODEL",
  ...TASKS.map((task) => `DASH_MODEL_${task.id.toUpperCase()}`),
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const NOTHING = { provider: null, model: null, models: {} };

describe("the defaults, with nothing configured", () => {
  /*
   * The measured split, asserted directly. Setup is rare and gets the better
   * model; use is constant and gets the cheap one. If this test is ever
   * changed to match the code rather than the other way round, the evidence
   * for the split is in `TASKS` and in the eval harness.
   */
  it("routes setting up to the capable model and using to the fast one", () => {
    expect(modelForTask("widget", NOTHING)).toBe(TIER_MODELS.anthropic.capable);
    expect(modelForTask("discover", NOTHING)).toBe(TIER_MODELS.anthropic.capable);
    expect(modelForTask("map", NOTHING)).toBe(TIER_MODELS.anthropic.capable);
    expect(modelForTask("record", NOTHING)).toBe(TIER_MODELS.anthropic.capable);

    expect(modelForTask("chat", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
    expect(modelForTask("label", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
    expect(modelForTask("narrow", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
    expect(modelForTask("suggest", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
  });

  it("resolves every task to something, so no action is unroutable", () => {
    for (const task of TASKS) {
      expect(modelForTask(task.id, NOTHING), task.id).toBeTruthy();
      expect(sourceForTask(task.id, NOTHING)).toBe("tier");
    }
  });

  it("follows the provider whose key exists", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    expect(preferredProvider()).toBe("openai");
    expect(modelForTask("widget", NOTHING)).toBe(TIER_MODELS.openai.capable);
    expect(modelForTask("chat", NOTHING)).toBe(TIER_MODELS.openai.fast);
  });

  it("says so rather than guessing when there is no key at all", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(modelForTask("widget", NOTHING)).toBeNull();
    expect(sourceForTask("widget", NOTHING)).toBe("none");
  });
});

describe("the resolution order", () => {
  const settings = { model: "gpt-4o", models: { widget: "claude-opus-5" as const } };

  it("prefers a task env pin over everything", () => {
    process.env.DASH_MODEL_WIDGET = "pinned-model";
    process.env.DASH_LLM_MODEL = "global-env-model";
    expect(modelForTask("widget", settings)).toBe("pinned-model");
    expect(sourceForTask("widget", settings)).toBe("env");
  });

  it("pins one task without touching the others", () => {
    process.env.DASH_MODEL_WIDGET = "pinned-model";
    expect(modelForTask("chat", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
    expect(sourceForTask("chat", NOTHING)).toBe("tier");
  });

  /*
   * The picker greys itself out when DASH_LLM_MODEL is set, and a control that
   * says it cannot change anything has to be telling the truth — so the env
   * pin outranks a choice stored before it was set.
   */
  it("prefers the global env pin over a stored choice", () => {
    process.env.DASH_LLM_MODEL = "global-env-model";
    expect(modelForTask("widget", settings)).toBe("global-env-model");
    expect(modelForTask("chat", settings)).toBe("global-env-model");
  });

  it("prefers an explicit per-task choice over the global one", () => {
    expect(modelForTask("widget", settings)).toBe("claude-opus-5");
    expect(sourceForTask("widget", settings)).toBe("task");
  });

  it("falls back to the global choice for a task with none", () => {
    expect(modelForTask("chat", settings)).toBe("gpt-4o");
    expect(sourceForTask("chat", settings)).toBe("global");
  });

  /** The one env name that predates this, kept working rather than renamed. */
  it("still honours DASH_REVIEW_MODEL for the review pass", () => {
    process.env.DASH_REVIEW_MODEL = "gpt-4.1-mini";
    expect(modelForTask("suggest", NOTHING)).toBe("gpt-4.1-mini");
    expect(sourceForTask("suggest", NOTHING)).toBe("env");
    // And only that pass — it was never a global setting.
    expect(modelForTask("chat", NOTHING)).toBe(TIER_MODELS.anthropic.fast);
  });
});

describe("the task table", () => {
  it("gives every task a tier and a note", () => {
    for (const task of TASKS) {
      expect(task.tier === "capable" || task.tier === "fast", task.id).toBe(true);
      expect(task.label.length, task.id).toBeGreaterThan(0);
      expect(task.note.length, task.id).toBeGreaterThan(0);
    }
  });

  it("recognises its own ids and refuses anything else", () => {
    expect(isTask("widget")).toBe(true);
    expect(isTask("author")).toBe(false);
    expect(findTask("nonsense")).toBeUndefined();
  });
});

describe("settings on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-settings-"));
  });

  /*
   * The key that predates per-task selection. An install that wrote
   * `{"model": "..."}` when it meant "the model" still parses and still does
   * what its author intended — it is now the "use one for everything"
   * override, which is the same behaviour under a better name.
   */
  it("reads a file written before per-task selection existed", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ model: "claude-opus-5" }), "utf8");

    const settings = new SettingsStore(path).read();
    expect(settings).toEqual({ provider: null, model: "claude-opus-5", models: {} });
    expect(modelForTask("chat", settings)).toBe("claude-opus-5");
  });

  it("treats an absent or corrupt file as no choice at all", () => {
    expect(new SettingsStore(join(dir, "missing.json")).read()).toEqual({
      provider: null,
      model: null,
      models: {},
    });

    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    expect(new SettingsStore(path).read()).toEqual({ provider: null, model: null, models: {} });
  });

  it("keeps a per-task choice and leaves the others alone", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    store.setTaskModel("widget", "claude-opus-5");
    store.setTaskModel("chat", "gpt-4o-mini");

    const settings = store.read();
    expect(settings.models).toEqual({ widget: "claude-opus-5", chat: "gpt-4o-mini" });
    expect(modelForTask("map", settings)).toBe(TIER_MODELS.anthropic.capable);
  });

  /*
   * Clearing deletes the key rather than storing null, so "no choice" is one
   * state on disk instead of two that read the same.
   */
  it("removes a cleared choice rather than storing an empty one", () => {
    const path = join(dir, "settings.json");
    const store = new SettingsStore(path);
    store.setTaskModel("widget", "claude-opus-5");
    store.setTaskModel("widget", null);

    expect(store.read().models).toEqual({});
    expect(JSON.parse(readFileSync(path, "utf8")).models).toEqual({});
  });

  it("keeps the global choice when a task choice is written, and the reverse", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    store.setModel("gpt-4o");
    store.setTaskModel("widget", "claude-opus-5");
    expect(store.read()).toEqual({
      provider: null,
      model: "gpt-4o",
      models: { widget: "claude-opus-5" },
    });

    store.setModel(null);
    expect(store.read()).toEqual({
      provider: null,
      model: null,
      models: { widget: "claude-opus-5" },
    });
  });

  /** A task name that has since been removed should not resurrect as a route. */
  it("drops stored keys that are no longer tasks", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ model: null, models: { author: "gpt-4o" } }), "utf8");
    expect(new SettingsStore(path).read().models).toEqual({});
  });
});

/**
 * The choice above the table.
 *
 * Picking a provider has to move every action that has not been pinned
 * individually — that is the whole point of it — and it has to be honest about
 * the pins it cannot honour, because a switch that quietly leaves a third of
 * the actions on the old provider is worse than one that refuses.
 */
describe("choosing a provider", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("defaults to DEFAULT_PROVIDER when both keys are present", () => {
    expect(preferredProvider(NOTHING)).toBe(DEFAULT_PROVIDER);
    expect(modelForTask("widget", NOTHING)).toBe(TIER_MODELS[DEFAULT_PROVIDER].capable);
    expect(modelForTask("chat", NOTHING)).toBe(TIER_MODELS[DEFAULT_PROVIDER].fast);
  });

  it("moves every unpinned action at once", () => {
    const onClaude = { provider: "anthropic" as const, model: null, models: {} };
    for (const task of TASKS) {
      const tier = findTask(task.id)?.tier ?? "fast";
      expect(modelForTask(task.id, onClaude), task.id).toBe(TIER_MODELS.anthropic[tier]);
      expect(sourceForTask(task.id, onClaude), task.id).toBe("tier");
    }

    const onOpenAi = { provider: "openai" as const, model: null, models: {} };
    expect(modelForTask("widget", onOpenAi)).toBe(TIER_MODELS.openai.capable);
    expect(modelForTask("chat", onOpenAi)).toBe(TIER_MODELS.openai.fast);
  });

  /** A pin is more specific than a provider, and stays until it is dropped. */
  it("leaves a per-task pin alone", () => {
    const settings = { provider: "openai" as const, model: null, models: { widget: "claude-opus-5" } };
    expect(modelForTask("widget", settings)).toBe("claude-opus-5");
    expect(modelForTask("chat", settings)).toBe(TIER_MODELS.openai.fast);
  });

  /*
   * The one place the choice is not obeyed literally. Routing every action
   * into a 401 to be faithful to a stored preference is the difference between
   * a warning and an outage.
   */
  it("falls back rather than routing into a missing key", () => {
    delete process.env.OPENAI_API_KEY;
    const settings = { provider: "openai" as const, model: null, models: {} };
    expect(preferredProvider(settings)).toBe("anthropic");
    expect(modelForTask("chat", settings)).toBe(TIER_MODELS.anthropic.fast);
  });

  it("still says so rather than guessing when there is no key at all", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(preferredProvider({ provider: "openai", model: null, models: {} })).toBeNull();
  });
});

describe("switching provider on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-provider-"));
  });

  it("stores the choice", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    expect(store.setProvider("anthropic").settings.provider).toBe("anthropic");
    expect(store.read().provider).toBe("anthropic");
    expect(store.setProvider(null).settings.provider).toBeNull();
  });

  /*
   * The rule this file exists to hold: a pin at the provider being left is not
   * a preference being preserved, it is a switch that silently did not happen.
   */
  it("drops the pins that belong to the provider being left, and names them", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    store.setModel("claude-opus-5");
    store.setTaskModel("widget", "claude-opus-5");
    store.setTaskModel("chat", "gpt-5.4-nano");

    const change = store.setProvider("openai");
    expect(change.clearedTasks).toEqual(["widget"]);
    expect(change.clearedGlobal).toBe(true);
    expect(store.read().models).toEqual({ chat: "gpt-5.4-nano" });
    expect(store.read().model).toBeNull();
  });

  it("keeps everything when the choice is cleared rather than switched", () => {
    const store = new SettingsStore(join(dir, "settings.json"));
    store.setTaskModel("widget", "claude-opus-5");
    const change = store.setProvider(null);
    expect(change.clearedTasks).toEqual([]);
    expect(store.read().models).toEqual({ widget: "claude-opus-5" });
  });

  it("ignores a stored provider that is not one", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ provider: "mistral", model: null, models: {} }), "utf8");
    expect(new SettingsStore(path).read().provider).toBeNull();
  });
});
