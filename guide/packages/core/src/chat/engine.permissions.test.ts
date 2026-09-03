import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatEngine, type ChatStreamEvent } from "./engine.js";
import { createComponentRegistry } from "../components/registry.js";
import { createKnowledgeGraph } from "../knowledge/graph.js";
import { FakeLlm } from "../testing/fakeLlm.js";
import { MemoryDb } from "../testing/memoryDb.js";
import { encodePerActionStartToolName } from "../actions/harness.js";
import type { AuthContext } from "../types.js";

const auth: AuthContext = { userId: "u1" };

/**
 * The engine half of the posture: what the model is allowed to propose.
 *
 * The action here declares `requiresConfirmation: "none"`, which is the whole
 * point — under `full` that means it goes straight to executing, and the
 * guarded rung has to turn it into something a person sees first.
 */
const setup = () => {
  const registry = createComponentRegistry();
  registry.register({
    id: "settings",
    title: "Settings",
    description: "User settings",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "set_theme",
        description: "Set the theme",
        requiresConfirmation: "none",
        schema: z.object({ theme: z.enum(["light", "dark"]) }),
        handler: async () => ({}),
      },
    ],
  });
  const db = new MemoryDb();
  const knowledge = createKnowledgeGraph(registry);
  return { registry, db, knowledge };
};

const collect = async (stream: AsyncIterable<ChatStreamEvent>) => {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const startTheme = () =>
  new FakeLlm([
    {
      kind: "toolCall",
      name: encodePerActionStartToolName("settings", "set_theme"),
      args: { theme: "dark" },
      followUpText: "Done.",
    },
  ]);

describe("permission modes in the chat engine", () => {
  it("lets a none-confirmation action go straight to executing under full", async () => {
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm: startTheme(), registry, knowledge });

    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "dark mode", activeComponentIds: ["settings"] },
        auth,
      ),
    );
    const started = events.find((e) => e.kind === "action_started");
    expect(started?.action?.requiresConfirmation).toBe("none");
  });

  it("raises it to preview under guarded, so nothing executes unseen", async () => {
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: startTheme(),
      registry,
      knowledge,
      permissionMode: "guarded",
    });

    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "dark mode", activeComponentIds: ["settings"] },
        auth,
      ),
    );
    const started = events.find((e) => e.kind === "action_started");
    expect(started?.action?.requiresConfirmation).toBe("preview");
  });

  it("opens no action at all under readonly, even if the model calls the tool", async () => {
    // The harness withholds the schema, so a well-behaved model never gets
    // here. This asserts the backstop for one that invents the name anyway.
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: startTheme(),
      registry,
      knowledge,
      permissionMode: "readonly",
    });

    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "dark mode", activeComponentIds: ["settings"] },
        auth,
      ),
    );
    expect(events.find((e) => e.kind === "action_started")).toBeUndefined();
  });

  it("resolves the posture from the turn's auth", async () => {
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: startTheme(),
      registry,
      knowledge,
      permissionMode: (ctx) => (ctx.orgId === "locked" ? "guarded" : "full"),
    });

    const events = await collect(
      engine.send(
        { sessionId: session.id, text: "dark mode", activeComponentIds: ["settings"] },
        { ...auth, orgId: "locked" },
      ),
    );
    expect(events.find((e) => e.kind === "action_started")?.action?.requiresConfirmation).toBe(
      "preview",
    );
  });
});

describe("session narrowing", () => {
  it("lets a session tighten below the tenant posture", async () => {
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({ db, llm: startTheme(), registry, knowledge });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "dark mode",
          activeComponentIds: ["settings"],
          permissionMode: "readonly",
        },
        auth,
      ),
    );
    expect(events.find((e) => e.kind === "action_started")).toBeUndefined();
    expect(events.find((e) => e.kind === "error")).toBeUndefined();
  });

  it("rejects a widening session rather than silently downgrading it", async () => {
    const { registry, db, knowledge } = setup();
    const session = await db.createSession({ title: "T" }, auth);
    const engine = new ChatEngine({
      db,
      llm: startTheme(),
      registry,
      knowledge,
      permissionMode: "guarded",
    });

    const events = await collect(
      engine.send(
        {
          sessionId: session.id,
          text: "dark mode",
          activeComponentIds: ["settings"],
          permissionMode: "full",
        },
        auth,
      ),
    );
    const error = events.find((e) => e.kind === "error");
    expect(error).toBeDefined();
    expect(String(error?.error)).toContain("narrow");
    // And it stopped there — the turn did not proceed under the tenant posture.
    expect(events.find((e) => e.kind === "action_started")).toBeUndefined();
  });
});
