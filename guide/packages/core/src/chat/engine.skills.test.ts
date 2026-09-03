import { describe, expect, it, vi } from "vitest";
import { ChatEngine, type ChatStreamEvent } from "./engine.js";
import { createComponentRegistry } from "../components/registry.js";
import { createKnowledgeGraph } from "../knowledge/graph.js";
import { FakeLlm } from "../testing/fakeLlm.js";
import { MemoryDb } from "../testing/memoryDb.js";
import { composeSkillProviders, dbSkillProvider } from "../skills/index.js";
import type { Skill, SkillProvider } from "../skills/types.js";
import type { AuthContext } from "../types.js";
import type { LlmGenerateOptions, LlmMessage, LlmStreamChunk, LlmTool } from "../adapters/llm.js";

/**
 * The engine half: is the block built from the right skills, for the right
 * caller, and does it stay out of the way when nothing is configured?
 *
 * Asserts on the system messages actually handed to the LLM rather than on
 * the reply, because the reply is the fake adapter's and proves nothing.
 */

const auth: AuthContext = { userId: "u1" };

/** A FakeLlm that records the messages it was given. */
class RecordingLlm extends FakeLlm {
  readonly seen: LlmMessage[][] = [];
  override async *stream<TTools extends Record<string, LlmTool> = {}>(
    opts: LlmGenerateOptions<TTools>,
  ): AsyncIterable<LlmStreamChunk> {
    this.seen.push(opts.messages);
    yield* super.stream(opts);
  }
}

const setup = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "orders",
    title: "Orders",
    description: "Orders",
    grid: { minW: 4, minH: 3 },
  });
  registry.register({
    id: "profile",
    title: "Profile",
    description: "Profile",
    grid: { minW: 4, minH: 3 },
  });
  const db = new MemoryDb();
  const knowledge = createKnowledgeGraph(registry);
  const llm = new RecordingLlm([{ kind: "text", text: "ok" }]);
  return { registry, db, knowledge, llm };
};

const collect = async (stream: AsyncIterable<ChatStreamEvent>) => {
  for await (const _ of stream) {
    /* drain */
  }
};

/** The system block this turn produced, or "" when there was none. */
const skillsBlockOf = (llm: RecordingLlm): string =>
  llm.seen[0]
    ?.filter((m) => m.role === "system")
    .map((m) => m.content)
    .find((c) => c.startsWith("## Skills")) ?? "";

const run = async (
  engine: ChatEngine,
  db: MemoryDb,
  who: AuthContext,
  activeComponentIds: string[] = [],
) => {
  const session = await db.createSession({ title: "T" }, who);
  await collect(engine.send({ sessionId: session.id, text: "hi", activeComponentIds }, who));
};

describe("skills in the engine", () => {
  it("injects nothing when no provider is configured", async () => {
    const { registry, db, knowledge, llm } = setup();
    const engine = new ChatEngine({ db, llm, registry, knowledge });
    await run(engine, db, auth);
    expect(skillsBlockOf(llm)).toBe("");
  });

  it("injects a block when a provider supplies skills", async () => {
    const { registry, db, knowledge, llm } = setup();
    const provider: SkillProvider = () => [
      { id: "refund", title: "Refunds", body: "Check the order date first." },
    ];
    const engine = new ChatEngine({ db, llm, registry, knowledge, skills: { provider } });
    await run(engine, db, auth);
    expect(skillsBlockOf(llm)).toContain("Check the order date first.");
  });

  it("passes the turn's context to the provider", async () => {
    const { registry, db, knowledge, llm } = setup();
    const provider = vi.fn<SkillProvider>(() => []);
    const engine = new ChatEngine({ db, llm, registry, knowledge, skills: { provider } });
    await run(engine, db, auth, ["orders"]);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ auth, text: "hi", activeComponentIds: ["orders"] }),
    );
  });

  it("scopes by active component", async () => {
    const scoped: Skill[] = [{ id: "refund", body: "Refund steps.", appliesTo: ["orders"] }];

    const a = setup();
    const engineA = new ChatEngine({ ...a, skills: { provider: () => scoped } });
    await run(engineA, a.db, auth, ["profile"]);
    expect(skillsBlockOf(a.llm)).toBe("");

    const b = setup();
    const engineB = new ChatEngine({ ...b, skills: { provider: () => scoped } });
    await run(engineB, b.db, auth, ["orders"]);
    expect(skillsBlockOf(b.llm)).toContain("Refund steps.");
  });

  it("serves two tenants different skills from one provider", async () => {
    // The multi-tenant property, checked end to end rather than at the port:
    // one engine, one provider, two auth contexts, two different prompts.
    const acme = setup();
    await acme.db.putSkill({ id: "acme", body: "Acme procedure." }, { orgId: "acme" });
    await acme.db.putSkill({ id: "globex", body: "Globex procedure." }, { orgId: "globex" });

    const engine = new ChatEngine({
      ...acme,
      skills: { provider: dbSkillProvider(acme.db) },
    });

    await run(engine, acme.db, { orgId: "acme" });
    const first = skillsBlockOf(acme.llm);
    expect(first).toContain("Acme procedure.");
    expect(first).not.toContain("Globex procedure.");

    // Second turn, different tenant, same engine.
    acme.llm.seen.length = 0;
    acme.llm.enqueue({ kind: "text", text: "ok" });
    await run(engine, acme.db, { orgId: "globex" });
    const second = skillsBlockOf(acme.llm);
    expect(second).toContain("Globex procedure.");
    expect(second).not.toContain("Acme procedure.");
  });

  it("layers defaults under tenant selections", async () => {
    const s = setup();
    await s.db.putSkill({ id: "refund", body: "Tenant version." }, { orgId: "acme" });
    const defaults: SkillProvider = () => [
      { id: "refund", body: "Default version." },
      { id: "greet", body: "Say hello." },
    ];
    const engine = new ChatEngine({
      ...s,
      skills: { provider: composeSkillProviders(defaults, dbSkillProvider(s.db)) },
    });

    await run(engine, s.db, { orgId: "acme" });
    const block = skillsBlockOf(s.llm);
    expect(block).toContain("Tenant version.");
    expect(block).not.toContain("Default version.");
    expect(block).toContain("Say hello.");
  });

  it("keeps the turn working when the provider throws", async () => {
    const { registry, db, knowledge, llm } = setup();
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      skills: {
        provider: () => {
          throw new Error("skill store unreachable");
        },
      },
    });
    await expect(run(engine, db, auth)).resolves.toBeUndefined();
    expect(skillsBlockOf(llm)).toBe("");
  });

  it("can be switched off while a provider is still configured", async () => {
    const { registry, db, knowledge, llm } = setup();
    const engine = new ChatEngine({
      db,
      llm,
      registry,
      knowledge,
      skills: { enabled: false, provider: () => [{ id: "a", body: "Nope." }] },
    });
    await run(engine, db, auth);
    expect(skillsBlockOf(llm)).toBe("");
  });
});
