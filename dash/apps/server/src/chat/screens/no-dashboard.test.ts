import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";
import { SpecStore } from "../../store.js";
import { openChatDb, type ChatDb } from "../db.js";

/**
 * The chat works the whole app, board or no board. A workspace that uses
 * only the calendar has no dashboard, and its chat still has every screen's
 * actions and the way to open them.
 */

type Seen = { tools: string[]; refs: string[] };

/** A model that notes what it was offered and says one line. */
const recording = (seen: Seen[]) => ({
  defaultModel: "recording-1",
  async *stream(opts: { tools?: Record<string, { schema?: { shape?: { action?: { options?: string[] } } } }> }) {
    const tools = opts.tools ?? {};
    seen.push({ tools: Object.keys(tools), refs: tools["start_action"]?.schema?.shape?.action?.options ?? [] });
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
});
