import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toJsonSchema } from "../../llm.js";
import { buildServer } from "../../server.js";
import { SpecStore } from "../../store.js";
import { openChatDb, type ChatDb } from "../db.js";

/**
 * The chat works the whole app, board or no board. A workspace that uses
 * only the calendar has no dashboard, and its chat still has every screen's
 * actions and the way to open them.
 */

type Message = { role: string; content: string; cachePoint?: boolean };
type Seen = { tools: string[]; refs: string[]; wireTools: string; messages: Message[] };
type Tool = { name: string; description: string; schema: { shape?: { action?: { options?: string[] } } } };

/** A model that notes what it was offered, as the adapters would send it, and says one line. */
const recording = (seen: Seen[]) => ({
  defaultModel: "recording-1",
  async *stream(opts: { messages: Message[]; tools?: Record<string, Tool> }) {
    const tools = opts.tools ?? {};
    seen.push({
      tools: Object.keys(tools),
      refs: tools["start_action"]?.schema?.shape?.action?.options ?? [],
      wireTools: JSON.stringify(Object.values(tools).map((tool) => ({ name: tool.name, description: tool.description, schema: toJsonSchema(tool.schema as never) }))),
      messages: opts.messages.map((message) => ({ ...message })),
    });
    yield { textDelta: "Okay." };
  },
  async generate() {
    return { text: "", toolCalls: [] };
  },
});

let dir: string;
let chat: ChatDb;
let app: FastifyInstance;
const seen: Seen[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-no-board-"));
  chat = await openChatDb({ inMemory: true });
  app = buildServer({
    store: new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports")),
    keys: new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, "vault.json")),
    chat,
    llm: () => recording(seen) as never,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await chat.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the chat with no dashboard", () => {
  it("offers every screen's actions and a way to open them", async () => {
    const session = await app.inject({ method: "POST", url: "/freebird/sessions", payload: {} });
    expect(session.statusCode).toBe(201);
    const sessionId = (session.json() as { id: string }).id;

    const turn = await app.inject({ method: "POST", url: "/freebird/chat", payload: { sessionId, text: "Make the intro call 30 minutes", activeComponentIds: ["calendar-types"] } });
    expect(turn.statusCode).toBe(200);

    const first = seen[0];
    expect(first?.tools).toContain("start_action");
    expect(first?.tools).toContain("open_component");
    expect(first?.refs).toEqual(expect.arrayContaining(["calendar-types:update_type", "calendar-bookings:confirm_booking", "contacts:add_contact", "calendar:make_calendar_feed"]));
  });

  /*
   * What a provider that caches by itself (OpenAI, vLLM, SGLang, llama.cpp)
   * reuses: a request that opens exactly as the last one did. Here that is
   * the tools, the system prompt and the list of actions, whatever was asked
   * and whatever was on screen; Anthropic is told where it ends.
   */
  it("opens every turn the same way, up to its cache point, whatever is asked and wherever", async () => {
    const session = await app.inject({ method: "POST", url: "/freebird/sessions", payload: {} });
    const sessionId = (session.json() as { id: string }).id;
    const from = seen.length;
    await app.inject({ method: "POST", url: "/freebird/chat", payload: { sessionId, text: "Who is booked tomorrow?", activeComponentIds: ["calendar-bookings"] } });
    await app.inject({ method: "POST", url: "/freebird/chat", payload: { sessionId, text: "Add a field for pets", activeComponentIds: ["contact-fields"], focus: { componentId: "contact-fields", itemId: "pets", label: "Pets" } } });
    const firstSteps = seen.slice(from).filter((one) => one.tools.includes("start_action"));
    expect(firstSteps).toHaveLength(2);
    const [one, two] = firstSteps as [Seen, Seen];

    const point = one.messages.findIndex((message) => message.cachePoint);
    expect(one.messages.filter((message) => message.cachePoint)).toHaveLength(1);
    expect(one.messages[point]?.content).toContain("Everything you can do in this app");
    expect(two.wireTools).toBe(one.wireTools);
    expect(two.messages.slice(0, point + 1)).toEqual(one.messages.slice(0, point + 1));
    /* What differs comes after it: the question, and what is on screen. */
    expect(JSON.stringify(one.messages.slice(point + 1))).toContain("Who is booked tomorrow?");
    expect(JSON.stringify(two.messages.slice(point + 1))).toContain("Pets");
  });
});
