import { createHash, createHmac } from "node:crypto";
import type { AgentSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { agentOf } from "../workflows/testing.js";
import { CallService } from "./call-service.js";
import { LiveKitApi, ROOM_OUT, liveKitFromEnv, liveKitPlacer, liveKitToken, verifyLiveKitWebhook, type HttpPost } from "./livekit.js";
import type { PhoneLine } from "./outreach.js";
import { openAiSpeech, speechFromEnv, wavOf, type SpeechFetch } from "./speech.js";
import { MemoryPhoneTextStore } from "./texts.js";
import { VoiceWorker, WRAP_UP, type MediaSession } from "./voice-worker.js";

/*
 * The media side of calls, without a media layer: LiveKit's server API
 * against recorded answers, the speech models against a pretend API, and
 * the voice worker over a fake media session.
 */

const T0 = Date.parse("2026-11-13T15:00:00.000Z");
const CONFIG = { url: "wss://dash.livekit.cloud", apiKey: "APIkey", apiSecret: "secret-secret-secret", sipUri: "sip:dash.sip.livekit.cloud" };

const recorded = (answers: Record<string, unknown> = {}) => {
  const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  const post: HttpPost = async (url, init) => {
    calls.push({ url, auth: init.headers["authorization"] ?? "", body: JSON.parse(init.body) as Record<string, unknown> });
    const method = url.split("/").pop()!;
    return { status: 200, text: async () => JSON.stringify(answers[method] ?? {}) };
  };
  return { calls, post };
};

const claimsOf = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

describe("LiveKit's server API", () => {
  it("reads its settings from the environment, all four or none", () => {
    expect(liveKitFromEnv({ DASH_LIVEKIT_URL: "wss://x", DASH_LIVEKIT_API_KEY: "k", DASH_LIVEKIT_API_SECRET: "s", DASH_LIVEKIT_SIP_URI: "sip:x" })).toMatchObject({ url: "wss://x" });
    expect(liveKitFromEnv({ DASH_LIVEKIT_URL: "wss://x" })).toBeNull();
  });

  it("signs its tokens with the key and secret, scoped to what each call needs", async () => {
    const token = liveKitToken(CONFIG, { video: { roomJoin: true, room: "r" } }, T0);
    const [header, body, signature] = token.split(".") as [string, string, string];
    expect(signature).toBe(createHmac("sha256", CONFIG.apiSecret).update(`${header}.${body}`).digest("base64url"));
    expect(claimsOf(token)).toMatchObject({ iss: "APIkey", nbf: T0 / 1000, exp: T0 / 1000 + 600, video: { roomJoin: true, room: "r" } });
    const lk = recorded({ CreateSIPInboundTrunk: { sip_trunk_id: "ST_in" }, CreateSIPDispatchRule: { sip_dispatch_rule_id: "SDR_1" }, CreateSIPOutboundTrunk: { sip_trunk_id: "ST_out" } });
    const api = new LiveKitApi(CONFIG, lk.post, () => T0);
    expect(await api.createInboundTrunk("Dash line-1", ["+15550100100"])).toBe("ST_in");
    expect(await api.createDispatchRule("ST_in", "call-in-", { line: "line-1" })).toBe("SDR_1");
    expect(await api.createOutboundTrunk("Dash line-1", "dash-1.pstn.twilio.com", ["+15550100100"], { username: "u", password: "p" })).toBe("ST_out");
    expect(lk.calls.map((one) => one.url)).toEqual([
      "https://dash.livekit.cloud/twirp/livekit.SIP/CreateSIPInboundTrunk",
      "https://dash.livekit.cloud/twirp/livekit.SIP/CreateSIPDispatchRule",
      "https://dash.livekit.cloud/twirp/livekit.SIP/CreateSIPOutboundTrunk",
    ]);
    expect(claimsOf(lk.calls[0]!.auth.replace("Bearer ", ""))).toMatchObject({ sip: { admin: true } });
    expect(lk.calls[1]!.body).toMatchObject({ trunk_ids: ["ST_in"], rule: { dispatch_rule_individual: { room_prefix: "call-in-" } }, metadata: JSON.stringify({ line: "line-1" }) });
    expect(lk.calls[2]!.body).toMatchObject({ trunk: { address: "dash-1.pstn.twilio.com", auth_username: "u", auth_password: "p" } });
  });

  it("takes a webhook only with a token over the body's own hash", () => {
    const body = JSON.stringify({ event: "participant_joined", room: { name: "call-in-1" } });
    const signed = liveKitToken(CONFIG, { sha256: createHash("sha256").update(body).digest("base64") }, T0);
    expect(verifyLiveKitWebhook(CONFIG, body, signed, T0)).toMatchObject({ event: "participant_joined" });
    expect(verifyLiveKitWebhook(CONFIG, `${body} `, signed, T0)).toBeNull();
    expect(verifyLiveKitWebhook({ ...CONFIG, apiSecret: "other" }, body, signed, T0)).toBeNull();
    expect(verifyLiveKitWebhook(CONFIG, body, signed, T0 + 3_600_000)).toBeNull();
    expect(verifyLiveKitWebhook(CONFIG, body, undefined, T0)).toBeNull();
  });

  it("places a call: a room with its purpose, then LiveKit dials the number into it through the line's trunk", async () => {
    const lk = recorded();
    const placer = liveKitPlacer(new LiveKitApi(CONFIG, lk.post, () => T0), (from) => (from === "+15550100100" ? "ST_out" : null));
    const placed = await placer.place({ from: "+15550100100", to: "+15550100200", purpose: "Confirm tomorrow's visit", key: "k1", maxMinutes: 10 });
    expect(placed.providerId).toMatch(new RegExp(`^${ROOM_OUT}[0-9a-f]{20}$`));
    expect(lk.calls[0]!.body).toMatchObject({ name: placed.providerId, metadata: expect.stringContaining('"purpose":"Confirm tomorrow\'s visit"') });
    expect(lk.calls[1]!.body).toEqual({ sip_trunk_id: "ST_out", sip_call_to: "+15550100200", sip_number: "+15550100100", room_name: placed.providerId, participant_identity: "caller-+15550100200" });
    await expect(placer.place({ from: "+15550100999", to: "+1", purpose: "", key: "k2", maxMinutes: 1 })).rejects.toThrow(/not connected/);
  });
});

describe("speech models", () => {
  it("are set from the environment, bring your own", () => {
    expect(speechFromEnv({ OPENAI_API_KEY: "sk" })).toMatchObject({ url: "https://api.openai.com/v1", sttModel: "gpt-4o-mini-transcribe", ttsModel: "gpt-4o-mini-tts" });
    expect(speechFromEnv({ DASH_SPEECH_API_KEY: "k", DASH_SPEECH_URL: "http://local/v1/", DASH_MODEL_SPEECH_TO_TEXT: "whisper-large" })).toMatchObject({ url: "http://local/v1", sttModel: "whisper-large" });
    expect(speechFromEnv({})).toBeNull();
  });

  it("send a WAV to transcribe and read raw PCM back from speaking", async () => {
    const asked: Array<{ url: string; body: unknown }> = [];
    const doFetch: SpeechFetch = async (url, init) => {
      asked.push({ url, body: init.body });
      return { status: 200, text: async () => JSON.stringify({ text: " Hello there " }), arrayBuffer: async () => new Int16Array([1, 2, 3]).buffer };
    };
    const speech = openAiSpeech({ url: "https://api.example/v1", apiKey: "k", sttModel: "stt", ttsModel: "tts", voice: "alloy" }, doFetch);
    expect(await speech.transcribe({ samples: new Int16Array(160), sampleRate: 16_000 })).toBe("Hello there");
    expect(asked[0]!.url).toBe("https://api.example/v1/audio/transcriptions");
    expect((asked[0]!.body as FormData).get("model")).toBe("stt");
    const spoken = await speech.speak("Hi");
    expect(spoken).toEqual({ samples: new Int16Array([1, 2, 3]), sampleRate: 24_000 });
    expect(JSON.parse(asked[1]!.body as string)).toEqual({ model: "tts", voice: "alloy", input: "Hi", response_format: "pcm" });
    const wav = wavOf({ samples: new Int16Array(10), sampleRate: 16_000 });
    expect(Buffer.from(wav.slice(0, 4)).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 20);
  });
});

/* ── the voice worker over a fake media session ─────────────────────── */

const line: PhoneLine = {
  id: "line-1",
  title: "Front desk",
  phone: { provider: "fake", number: "+15550100100", owner: { kind: "agent", id: "desk" }, text: { status: "approved" }, voice: { status: "ready" }, ceilings: { textsPerDay: 200, callMinutesPerDay: 120 }, calls: { answer: "agent", recording: true, disclosure: "" } },
};

const fakeMedia = (said: string[]) => {
  const spoken: string[] = [];
  const events: string[] = [];
  const session: MediaSession = {
    utterances: async function* () {
      for (const one of said) yield one;
    },
    speak: async (text) => void spoken.push(text),
    transfer: async (to, whisper) => void events.push(`transfer ${to}: ${whisper}`),
    hangUp: async () => void events.push("hang up"),
  };
  return { spoken, events, connector: { join: async () => session } };
};

const worker = (said: string[], replies: Array<Record<string, unknown>>, clock = { now: T0 }, step = 0) => {
  const agent: AgentSpec = agentOf({ id: "desk", name: "Front desk", tools: [] });
  let at = 0;
  const calls = new CallService({
    lines: { get: (id) => (id === line.id ? line : null) },
    agents: { get: async () => agent },
    llm: () => ({ defaultModel: "s", generate: async () => ((clock.now += step), { text: "", toolCalls: [{ id: "c", name: "respond", args: replies[Math.min(at++, replies.length - 1)]! }] }), stream: async function* () {} }),
    runTool: async () => "",
    teamPhone: async () => "+15550100999",
    business: async () => "Acme Plumbing",
    texts: new MemoryPhoneTextStore(),
    tasks: { get: async () => null, put: async () => undefined },
    now: () => clock.now,
    newId: () => "n",
  });
  const media = fakeMedia(said);
  const ended: Array<{ minutes: number; transcript: number }> = [];
  const voice = new VoiceWorker({ calls, media: media.connector, ended: async (_info, call, minutes) => void ended.push({ minutes, transcript: call.transcript.length }), now: () => clock.now });
  return { voice, media, ended };
};

describe("the voice worker", () => {
  const info = { room: "call-in-1", direction: "in" as const, line: "line-1", number: "+15550100200", maxMinutes: 10 };

  it("says the opening line, answers each utterance, and keeps the call when it ends", async () => {
    const w = worker(["When is my visit?", "Thanks, bye."], [{ say: "Tuesday at 9." }, { say: "Bye!", end: true }]);
    const call = await w.voice.attend(info);
    expect(w.media.spoken).toEqual(["Hi, you've reached Acme Plumbing. I'm Acme Plumbing's automated assistant. This call is recorded. How can I help?", "Tuesday at 9.", "Bye!"]);
    expect(w.media.events).toEqual(["hang up"]);
    expect(call!.transcript.map((one) => one.who)).toEqual(["agent", "caller", "agent", "caller", "agent"]);
    expect(w.ended).toEqual([{ minutes: 1, transcript: 5 }]);
    expect(await w.voice.attend(info)).not.toBeNull();
  });

  it("hands the call to a person with the whisper, and does not hang up on them", async () => {
    const w = worker(["Get me a person."], [{ say: "Sure.", transfer: true }]);
    await w.voice.attend(info);
    expect(w.media.events).toEqual(["transfer +15550100999: Call from +15550100200: Get me a person."]);
    expect(w.media.spoken.at(-1)).toBe("Sure. One moment while I connect you.");
  });

  it("wraps up at the line's minute ceiling", async () => {
    const clock = { now: T0 };
    const w = worker(["one", "two", "three"], [{ say: "Mm." }], clock, 6 * 60_000);
    await w.voice.attend({ ...info, maxMinutes: 10 });
    expect(w.media.spoken.at(-1)).toBe(WRAP_UP);
    expect(w.media.spoken.filter((one) => one === "Mm.")).toHaveLength(2);
    expect(w.ended[0]!.minutes).toBe(12);
  });
});
