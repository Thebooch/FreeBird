import { describe, expect, it, vi } from "vitest";
import {
  createComponentRegistry,
  type AuthContext,
  type DbAdapter,
  type LlmAdapter,
} from "@freebirdai/core";
import { createDepsResolver } from "./index.js";
import { meteredLlm, defaultTenantKey } from "./tenancy.js";

const stubDb = (): DbAdapter => ({}) as unknown as DbAdapter;

const stubLlm = (defaultModel = "test-model"): LlmAdapter => ({
  defaultModel,
   
  async *stream() {
    return;
  },
  async generate() {
    return { text: "", toolCalls: [] };
  },
});

const registryWith = (id: string) => {
  const r = createComponentRegistry();
  r.register({
    id,
    title: id,
    description: `component ${id}`,
    grid: { minW: 4, minH: 3 },
  });
  return r;
};

describe("defaultTenantKey", () => {
  it("prefers orgId then extra.tenantId", () => {
    expect(defaultTenantKey({ orgId: "org1" })).toBe("org1");
    expect(defaultTenantKey({ extra: { tenantId: "t2" } })).toBe("t2");
    expect(defaultTenantKey({})).toBeUndefined();
  });
});

describe("meteredLlm", () => {
  it("reports usage from generate()", async () => {
    const onUsage = vi.fn();
    const base: LlmAdapter = {
      defaultModel: "m",
      async *stream() {
        return;
      },
      async generate() {
        return {
          text: "hi",
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
          model: "gpt-x",
        };
      },
    };
    const ctx: AuthContext = { orgId: "org1" };
    const metered = meteredLlm(base, ctx, onUsage);
    await metered.generate({ messages: [] });
    expect(onUsage).toHaveBeenCalledWith(ctx, {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      model: "gpt-x",
    });
  });

  it("reports usage from the final stream chunk", async () => {
    const onUsage = vi.fn();
    const base: LlmAdapter = {
      defaultModel: "m",
      async *stream() {
        yield { textDelta: "he" };
        yield { textDelta: "llo" };
        yield { usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 }, model: "gpt-y" };
      },
      async generate() {
        return { text: "", toolCalls: [] };
      },
    };
    const metered = meteredLlm(base, { orgId: "o" }, onUsage);
    const chunks = [];
    for await (const c of metered.stream({ messages: [] })) chunks.push(c);
    expect(chunks).toHaveLength(3);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]![1]).toMatchObject({ inputTokens: 3, outputTokens: 5, model: "gpt-y" });
  });

  it("never lets a throwing hook break generation", async () => {
    const base = stubLlm();
    base.generate = async () => ({
      text: "",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const metered = meteredLlm(base, {}, () => {
      throw new Error("meter down");
    });
    await expect(metered.generate({ messages: [] })).resolves.toMatchObject({ text: "" });
  });
});

describe("createDepsResolver — static fast path", () => {
  it("returns the same deps instance every call", async () => {
    const registry = registryWith("alpha");
    const resolver = createDepsResolver({ db: stubDb(), llm: stubLlm(), registry });
    const a = await resolver.resolve({ userId: "u1" });
    const b = await resolver.resolve({ userId: "u2" });
    expect(a).toBe(b);
    expect(a.registry).toBe(registry);
  });
});

describe("createDepsResolver — multi-tenant", () => {
  it("isolates registries per tenant and caches per tenant", async () => {
    const registries: Record<string, ReturnType<typeof registryWith>> = {
      org1: registryWith("comp_one"),
      org2: registryWith("comp_two"),
    };
    const registryResolver = vi.fn((ctx: AuthContext) => registries[ctx.orgId!]!);
    const resolver = createDepsResolver({
      db: stubDb(),
      llm: stubLlm(),
      registry: registryResolver,
    });

    const d1 = await resolver.resolve({ orgId: "org1" });
    const d2 = await resolver.resolve({ orgId: "org2" });
    expect(d1.registry.list().map((c) => c.id)).toEqual(["comp_one"]);
    expect(d2.registry.list().map((c) => c.id)).toEqual(["comp_two"]);

    // Second resolve for org1 is a cache hit — resolver not called again.
    await resolver.resolve({ orgId: "org1" });
    expect(registryResolver).toHaveBeenCalledTimes(2);

    // Invalidation forces a re-resolve for that tenant only.
    resolver.invalidateRegistry("org1");
    await resolver.resolve({ orgId: "org1" });
    await resolver.resolve({ orgId: "org2" });
    expect(registryResolver).toHaveBeenCalledTimes(3);
  });

  it("resolves a per-tenant LLM on each request", async () => {
    const registry = registryWith("shared");
    const llmResolver = vi.fn((ctx: AuthContext) => stubLlm(`model-${ctx.orgId}`));
    const resolver = createDepsResolver({
      db: stubDb(),
      llm: llmResolver,
      registry,
    });
    await resolver.resolve({ orgId: "org1" });
    await resolver.resolve({ orgId: "org2" });
    expect(llmResolver).toHaveBeenCalledTimes(2);
    expect(llmResolver.mock.calls[0]![0]).toEqual({ orgId: "org1" });
    expect(llmResolver.mock.calls[1]![0]).toEqual({ orgId: "org2" });
  });

  it("enables metering when onLlmUsage is set, even with static registry/llm", async () => {
    const registry = registryWith("shared");
    const resolver = createDepsResolver({
      db: stubDb(),
      llm: stubLlm(),
      registry,
      onLlmUsage: vi.fn(),
    });
    // With onLlmUsage the resolver is in per-request mode: the static registry
    // is reused (same instance) but deps objects are freshly built.
    const a = await resolver.resolve({ orgId: "org1" });
    const b = await resolver.resolve({ orgId: "org1" });
    expect(a).not.toBe(b);
    expect(a.registry).toBe(registry);
  });

  it("rejects inProcess scheduler in multi-tenant mode", () => {
    expect(() =>
      createDepsResolver({
        db: stubDb(),
        llm: stubLlm(),
        registry: () => registryWith("x"),
        scheduler: "inProcess",
      }),
    ).toThrow(/inProcess/);
  });
});
