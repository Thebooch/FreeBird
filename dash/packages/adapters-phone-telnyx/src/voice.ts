import { randomBytes } from "node:crypto";
import type { TrunkInfo } from "@freebirdai/dash-spec";
import type { VoiceAdapter } from "@freebirdai/phone";

/**
 * Telnyx's calls, as Dash Phone's `VoiceAdapter`: an FQDN connection whose
 * address is the media layer's SIP host, as LiveKit's Telnyx guide sets it up
 * (https://docs.livekit.io/sip/quickstarts/configuring-telnyx-trunk/), over
 * Telnyx's API reference (checked 2026-11-13):
 *
 * - An outbound voice profile (`POST /outbound_voice_profiles`, `name`;
 *   https://developers.telnyx.com/api-reference/outbound-voice-profiles/create-an-outbound-voice-profile.md),
 *   which LiveKit's guide says outbound calls need.
 * - The connection (`POST /fqdn_connections`, `connection_name` required,
 *   https://developers.telnyx.com/api-reference/fqdn-connections/create-an-fqdn-connection.md):
 *   TCP, numbers as +E.164 both ways, the profile on `outbound`, and a
 *   `user_name` and `password` the media layer signs in with to dial out
 *   through `sip.telnyx.com`. The request schema does not list `user_name`
 *   and `password`, though its answer does and LiveKit's guide sends them on
 *   create (unconfirmed).
 * - The media layer's host on it (`POST /fqdns`: `connection_id`, `fqdn`,
 *   `port`, `dns_record_type` "a" with a port).
 * - Each number on the connection (`PATCH /phone_numbers/{id}`,
 *   `connection_id`; update-a-phone-number.md).
 *
 * `disconnectTrunk` deletes the connection (`DELETE /fqdn_connections/{id}`)
 * and its voice profile (`DELETE /outbound_voice_profiles/{id}`, unconfirmed:
 * the delete page was not read); the numbers stay in the account.
 */

export const TELNYX_SIP_HOST = "sip.telnyx.com";

type Call = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

export interface TelnyxVoiceDeps {
  readonly call: Call;
  readonly numberId: (number: string) => Promise<string>;
  /** Random hex, for names and the connection's credential. */
  readonly random?: (bytes: number) => string;
}

/** `sip:host[:port][;params]` → host and port. */
export const sipHostOf = (uri: string): { host: string; port: number } => {
  const match = /^sips?:(?:[^@]+@)?([^:;>]+)(?::(\d+))?/i.exec(uri.trim());
  if (!match?.[1]) throw new Error(`"${uri}" is not a SIP address like sip:example.sip.livekit.cloud.`);
  return { host: match[1], port: match[2] ? Number(match[2]) : 5060 };
};

const idOf = (answer: Record<string, unknown>, what: string): string => {
  const data = (answer["data"] ?? answer) as Record<string, unknown>;
  const id = data["id"];
  if ((typeof id !== "string" && typeof id !== "number") || id === "") throw new Error(`Telnyx did not say which ${what} it made.`);
  return String(id);
};

export const telnyxVoice = (deps: TelnyxVoiceDeps): VoiceAdapter => {
  const random = deps.random ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const { call } = deps;
  return {
    connectTrunk: async (t): Promise<TrunkInfo> => {
      const { host, port } = sipHostOf(t.sipUri);
      const name = `dash-${random(4)}`;
      const profile = idOf(await call("POST", "/outbound_voice_profiles", { name: `Dash calls (${name})`, traffic_type: "conversational", service_plan: "global" }), "outbound voice profile");
      const username = `dash${random(6)}`;
      const password = `${random(12)}Aa1`;
      const connection = idOf(
        await call("POST", "/fqdn_connections", {
          connection_name: `Dash calls (${name})`,
          transport_protocol: "TCP",
          inbound: { ani_number_format: "+E.164", dnis_number_format: "+e164" },
          outbound: { outbound_voice_profile_id: profile },
          user_name: username,
          password,
        }),
        "FQDN connection",
      );
      await call("POST", "/fqdns", { connection_id: connection, fqdn: host, port, dns_record_type: "a" });
      for (const number of t.numbers) await call("PATCH", `/phone_numbers/${await deps.numberId(number)}`, { connection_id: connection });
      return { id: `${connection}/${profile}`, sipUri: t.sipUri, numbers: [...t.numbers], termination: { address: TELNYX_SIP_HOST, username, password } };
    },
    disconnectTrunk: async (id) => {
      const [connection, profile] = id.split("/");
      if (!connection) throw new Error(`"${id}" is not a connection Dash made.`);
      await call("DELETE", `/fqdn_connections/${connection}`);
      if (profile) await call("DELETE", `/outbound_voice_profiles/${profile}`);
    },
  };
};
