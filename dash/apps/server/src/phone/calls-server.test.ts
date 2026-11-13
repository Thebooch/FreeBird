import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { PhoneLineView, Task } from "@freebirdai/dash-spec";
import { FAKE_SECRET, FakeCarrier } from "@freebirdai/phone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAgentStore } from "../agents/store.js";
import { MemoryContactStore } from "../contacts/store.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { MemoryCaseStore, MemoryTaskStore, MemoryWorkflowStore } from "../workflows/store.js";
import { agentOf, node, owner, workflowOf } from "../workflows/testing.js";
import { liveKitToken } from "./livekit.js";
import type { MediaSession } from "./voice-worker.js";

/*
 * Calls through the server, with a fake media session in place of LiveKit's
 * audio: a signed LiveKit webhook brings the voice worker in, the call is
 * kept in Communications and starts the workflows that listen for calls,
 * and an Approve tool's promise waits in Waiting for you until approved.
 */

const LK = { url: "wss://lk.example", apiKey: "APIkey", apiSecret: "lk-secret-lk-secret", sipUri: "sip:lk.example" };
const CALLER = "+15550100200";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-calls-server-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("calls through the server", () => {
  it("carries a call from LiveKit's webhook, keeps it in Comms, starts call workflows, and runs an approved promise", async () => {
    const store = new SpecStore(join(dir, "d"), join(dir, "c"), join(dir, "r"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 2)), join(dir, "vault.json"));
    const agents = new MemoryAgentStore();
    await agents.put(
      agentOf({
        id: "desk",
        name: "Front desk",
        tools: [{ id: "callback", kind: "run_workflow", workflow: "callback", mode: "approve", enabled: true, scope: {}, label: "Book a callback", description: "", whenToUse: "", denyReply: "" }],
      }),
    );
    const workflows = new MemoryWorkflowStore();
    await workflows.put(workflowOf({ id: "after-call", name: "Note each call", trigger: { kind: "message_received", channels: ["call"] }, enabledBy: owner, nodes: [node("note", "create.todo", { title: "Call from {{ from.address }}" })] }));
    await workflows.put(workflowOf({ id: "callback", name: "Callback", trigger: { kind: "agent" }, enabledBy: owner, nodes: [node("todo", "create.todo", { title: "Call them back" })] }));
    const tasks = new MemoryTaskStore();
    const cases = new MemoryCaseStore();
    const contacts = new MemoryContactStore();
    const carrier = new FakeCarrier({ numbers: ["+15550100100"] });
    let replies = 0;
    const llm: LlmAdapter = {
      defaultModel: "scripted",
      generate: async () => ({
        text: "",
        toolCalls: [{ id: `c${replies}`, name: "respond", args: [{ say: "Sure.", tool: "callback", promise: "book you a callback this afternoon" }, { say: "Bye!", end: true }][Math.min(replies++, 1)]! }],
      }),
      stream: async function* () {},
    };
    const spoken: string[] = [];
    const media = {
      join: async (): Promise<MediaSession> => ({
        utterances: async function* () {
          yield "Can someone call me back this afternoon?";
          yield "Thanks, bye.";
        },
        speak: async (text) => void spoken.push(text),
        transfer: async () => undefined,
        hangUp: async () => undefined,
      }),
    };
    const app = buildServer({ store, keys, llm, agents, workflows, tasks, cases, contacts, phoneProviders: { fake: carrier.open }, liveKit: LK, speech: null, callMedia: media, publicOrigin: "https://dash.example" });
    try {
      const line = (await app.inject({ method: "POST", url: "/api/comms/lines", payload: { provider: "fake", number: "+15550100100", keys: { secret: FAKE_SECRET }, owner: { kind: "agent", id: "desk" } } })).json() as PhoneLineView;
      expect((await app.inject({ method: "PUT", url: `/api/comms/lines/${line.id}/calls`, payload: { answer: "forward", recording: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: `/api/comms/lines/${line.id}/calls`, payload: { answer: "agent", recording: true, disclosure: "Thanks for calling Acme!" } })).statusCode).toBe(200);

      const event = JSON.stringify({ event: "participant_joined", room: { name: `call-in-${line.id}-abc` }, participant: { kind: "SIP", identity: "sip_caller", attributes: { "sip.phoneNumber": CALLER } } });
      const signed = liveKitToken(LK, { sha256: createHash("sha256").update(event).digest("base64") }, Date.now());
      const hook = "/api/public/local/phone/livekit";
      expect((await app.inject({ method: "POST", url: hook, headers: { authorization: `Bearer ${signed}`, "content-type": "application/webhook+json" }, payload: `${event} ` })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: hook, headers: { authorization: `Bearer ${signed}`, "content-type": "application/webhook+json" }, payload: event })).statusCode).toBe(200);
      for (let i = 0; i < 50 && !(await cases.list({ limit: 10 })).some((one) => one.workflow === "after-call"); i++) await new Promise((resolve) => setTimeout(resolve, 20));

      expect(spoken[0]).toMatch(/^Thanks for calling Acme! I'm .+'s automated assistant\. This call is recorded\. How can I help\?$/);
      expect(spoken[1]).toContain("You'll get a text to confirm once it's approved.");
      const threads = (await app.inject({ method: "GET", url: `/api/comms/lines/${line.id}/threads` })).json() as { threads: Array<{ number: string; startedBy: string; last: { kind?: string; body: string } }> };
      expect(threads.threads).toEqual([expect.objectContaining({ number: CALLER, startedBy: "them", last: expect.objectContaining({ kind: "call", body: expect.stringContaining("Caller: Can someone call me back this afternoon?") }) })]);
      expect(await contacts.byKey(`phone:${CALLER}`)).toMatchObject({ origin: "call" });
      const afterCall = (await cases.list({ limit: 10 })).find((one) => one.workflow === "after-call")!;
      expect(afterCall.data.row).toMatchObject({ channel: "call", text: expect.stringContaining("Caller: Thanks, bye."), inbound: { trust: "unknown" } });

      /* The promise waits for a person; approving it starts the workflow and texts the caller, who called first. */
      const waiting = (await tasks.list({ status: "waiting_approval", limit: 10 })) as Task[];
      expect(waiting).toEqual([expect.objectContaining({ action: "call.follow_up", pending: expect.objectContaining({ tool: "callback", during: "after" }) })]);
      expect((await cases.list({ limit: 10 })).some((one) => one.workflow === "callback")).toBe(false);
      const approved = await app.inject({ method: "POST", url: `/api/tasks/${waiting[0]!.id}/approve`, payload: {} });
      expect(approved.statusCode).toBe(200);
      expect((await tasks.get(waiting[0]!.id))).toMatchObject({ status: "done", delivery: { status: "queued", basis: "texted_first" } });
      expect((await cases.list({ limit: 10 })).some((one) => one.workflow === "callback")).toBe(true);
      expect(carrier.sent.at(-1)).toMatchObject({ to: CALLER, body: expect.stringContaining("is confirmed") });
    } finally {
      await app.close();
    }
  });

  it("refuses to connect calls without LiveKit, and says how to set it up", async () => {
    const store = new SpecStore(join(dir, "d2"), join(dir, "c2"), join(dir, "r2"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 2)), join(dir, "vault2.json"));
    const carrier = new FakeCarrier({ numbers: ["+15550100100"] });
    const app = buildServer({ store, keys, llm: null, phoneProviders: { fake: carrier.open }, liveKit: null, speech: null });
    try {
      const line = (await app.inject({ method: "POST", url: "/api/comms/lines", payload: { provider: "fake", number: "+15550100100", keys: { secret: FAKE_SECRET } } })).json() as PhoneLineView;
      const refused = await app.inject({ method: "POST", url: `/api/comms/lines/${line.id}/calls/connect` });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: expect.stringContaining("DASH_LIVEKIT_URL") });
      expect((await app.inject({ method: "POST", url: "/api/public/local/phone/livekit", payload: "{}" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
