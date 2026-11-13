import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CallPlacer } from "@freebirdai/phone";

/**
 * LiveKit, the SIP media layer calls ride (Dash Phone, Phase 3). The carrier
 * sends a line's calls over its SIP trunk to LiveKit; LiveKit puts each in a
 * room; Dash's voice worker joins the room as the line's agent. Calls the
 * business places go the other way: Dash makes a room and asks LiveKit to
 * dial the number into it through the carrier.
 *
 * LiveKit runs beside Dash in a self-hosted install (`dash/docker/`), or is
 * a LiveKit Cloud project whose key the business brings: the same
 * `DASH_LIVEKIT_URL`, `DASH_LIVEKIT_API_KEY`, `DASH_LIVEKIT_API_SECRET` and
 * `DASH_LIVEKIT_SIP_URI` either way.
 *
 * This is LiveKit's server API (its Twirp endpoints, JSON over HTTP) with a
 * token signed here (HS256), and its webhooks checked here: no SDK.
 */

export interface LiveKitConfig {
  /** wss:// or https://: the server, or the LiveKit Cloud project. */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** Where carriers send calls: `sip:<project>.sip.livekit.cloud`, or the self-hosted SIP service's address. */
  readonly sipUri: string;
}

export const liveKitFromEnv = (env: NodeJS.ProcessEnv = process.env): LiveKitConfig | null => {
  const url = env["DASH_LIVEKIT_URL"]?.trim();
  const apiKey = env["DASH_LIVEKIT_API_KEY"]?.trim();
  const apiSecret = env["DASH_LIVEKIT_API_SECRET"]?.trim();
  const sipUri = env["DASH_LIVEKIT_SIP_URI"]?.trim();
  return url && apiKey && apiSecret && sipUri ? { url, apiKey, apiSecret, sipUri } : null;
};

export type HttpPost = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ readonly status: number; text(): Promise<string> }>;

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** A LiveKit access token: HS256 over the API key and secret. */
export const liveKitToken = (config: Pick<LiveKitConfig, "apiKey" | "apiSecret">, claims: Record<string, unknown>, now: number, ttlSeconds = 600): string => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const seconds = Math.floor(now / 1000);
  const body = b64url(JSON.stringify({ iss: config.apiKey, nbf: seconds, exp: seconds + ttlSeconds, ...claims }));
  const signature = createHmac("sha256", config.apiSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
};

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * A LiveKit webhook, checked before it is read: its Authorization header is
 * a token signed with this API secret whose `sha256` claim is the body's own
 * hash. Null when it is not one.
 */
export const verifyLiveKitWebhook = (config: Pick<LiveKitConfig, "apiKey" | "apiSecret">, body: string, authorization: string | undefined, now: number): Record<string, unknown> | null => {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts as [string, string, string];
  if (!same(signature, createHmac("sha256", config.apiSecret).update(`${header}.${claims}`).digest("base64url"))) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const seconds = Math.floor(now / 1000);
  if (decoded["iss"] !== config.apiKey || (typeof decoded["exp"] === "number" && decoded["exp"] < seconds) || (typeof decoded["nbf"] === "number" && decoded["nbf"] > seconds + 60)) return null;
  if (decoded["sha256"] !== createHash("sha256").update(body, "utf8").digest("base64")) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export class LiveKitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** LiveKit's server API, as Dash uses it. */
export class LiveKitApi {
  constructor(
    readonly config: LiveKitConfig,
    private readonly post: HttpPost = async (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private get base(): string {
    return this.config.url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
  }

  private async twirp(service: string, method: string, body: Record<string, unknown>, grants: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = liveKitToken(this.config, grants, this.now());
    const answer = await this.post(`${this.base}/twirp/livekit.${service}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await answer.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* An empty answer. */
    }
    if (answer.status >= 400) throw new LiveKitError(typeof parsed["msg"] === "string" ? parsed["msg"] : `LiveKit answered ${answer.status}.`, answer.status);
    return parsed;
  }

  /** A room, with what the voice worker needs to know about its call. */
  createRoom(name: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.twirp("RoomService", "CreateRoom", { name, metadata: JSON.stringify(metadata), empty_timeout: 60 }, { video: { roomCreate: true } });
  }

  async createInboundTrunk(name: string, numbers: readonly string[]): Promise<string> {
    const made = await this.twirp("SIP", "CreateSIPInboundTrunk", { trunk: { name, numbers } }, { sip: { admin: true } });
    return String(made["sip_trunk_id"] ?? "");
  }

  async createOutboundTrunk(name: string, address: string, numbers: readonly string[], auth: { readonly username: string; readonly password: string }): Promise<string> {
    const made = await this.twirp("SIP", "CreateSIPOutboundTrunk", { trunk: { name, address, numbers, auth_username: auth.username, auth_password: auth.password } }, { sip: { admin: true } });
    return String(made["sip_trunk_id"] ?? "");
  }

  /** Each call on the trunk in a room of its own, named `<prefix><call>`. */
  async createDispatchRule(trunkId: string, roomPrefix: string, metadata: Record<string, unknown>): Promise<string> {
    const made = await this.twirp("SIP", "CreateSIPDispatchRule", { trunk_ids: [trunkId], rule: { dispatch_rule_individual: { room_prefix: roomPrefix } }, metadata: JSON.stringify(metadata) }, { sip: { admin: true } });
    return String(made["sip_dispatch_rule_id"] ?? "");
  }

  async deleteTrunk(id: string): Promise<void> {
    await this.twirp("SIP", "DeleteSIPTrunk", { sip_trunk_id: id }, { sip: { admin: true } });
  }

  async deleteDispatchRule(id: string): Promise<void> {
    await this.twirp("SIP", "DeleteSIPDispatchRule", { sip_dispatch_rule_id: id }, { sip: { admin: true } });
  }

  /** Dial a number into a room, through the line's outbound trunk. */
  createSipParticipant(input: { readonly trunkId: string; readonly to: string; readonly from: string; readonly room: string; readonly identity: string }): Promise<Record<string, unknown>> {
    return this.twirp("SIP", "CreateSIPParticipant", { sip_trunk_id: input.trunkId, sip_call_to: input.to, sip_number: input.from, room_name: input.room, participant_identity: input.identity }, { sip: { call: true } });
  }

  /** "Let me get someone": the caller is moved to a team member's phone. */
  transferSipParticipant(room: string, identity: string, to: string): Promise<Record<string, unknown>> {
    return this.twirp("SIP", "TransferSIPParticipant", { room_name: room, participant_identity: identity, transfer_to: `tel:${to}` }, { sip: { call: true }, video: { roomAdmin: true, room } });
  }

  /** A token for the voice worker to join a room as the line's agent. */
  joinToken(room: string, identity: string): string {
    return liveKitToken(this.config, { sub: identity, name: identity, video: { roomJoin: true, room, canPublish: true, canSubscribe: true } }, this.now(), 3600);
  }
}

/** Rooms for calls are named by direction, so the worker knows what it joined. */
export const ROOM_IN = "call-in-";
export const ROOM_OUT = "call-out-";

/**
 * The `CallPlacer` for a server with LiveKit: a room with the call's
 * purpose, then LiveKit dials the number into it through the line's
 * outbound trunk. The voice worker joins when the room starts.
 */
export const liveKitPlacer = (api: LiveKitApi, outboundTrunkFor: (from: string) => string | null): CallPlacer => ({
  place: async (call) => {
    const trunk = outboundTrunkFor(call.from);
    if (!trunk) throw new Error("This line's calls are not connected to the media layer yet.");
    const room = `${ROOM_OUT}${createHash("sha1").update(call.key).digest("hex").slice(0, 20)}`;
    await api.createRoom(room, { direction: "out", from: call.from, to: call.to, purpose: call.purpose, key: call.key, maxMinutes: call.maxMinutes });
    await api.createSipParticipant({ trunkId: trunk, to: call.to, from: call.from, room, identity: `caller-${call.to}` });
    return { providerId: room, status: "queued" };
  },
});
