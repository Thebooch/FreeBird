import type { SecretRepository } from "@freebirdai/connect/host";
import type { PhoneLineView } from "@freebirdai/dash-spec";
import type { PhoneProviders } from "@freebirdai/phone";
import { PhoneLineError, type PhoneLines } from "./lines.js";
import { ROOM_IN, type LiveKitApi } from "./livekit.js";

/**
 * Connecting a line's calls (Dash Phone, Phase 3): Dash does the wiring
 * through both APIs, so nothing is typed into the carrier or LiveKit by
 * hand.
 *
 * 1. The carrier's trunk (`VoiceAdapter.connectTrunk`) points the number's
 *    calls at LiveKit's SIP address, and gives a credential for calls out;
 *    its password goes to the vault (`phone-<line>-sip-password`).
 * 2. LiveKit's inbound trunk takes the number, and a dispatch rule puts each
 *    call in a room of its own (`call-in-…`), carrying the line's id.
 * 3. LiveKit's outbound trunk dials out through the carrier's trunk.
 *
 * Disconnecting undoes all three.
 */

export const sipPasswordRef = (line: string): string => `phone-${line}-sip-password`;

export class CallSetup {
  constructor(
    private readonly deps: {
      readonly lines: PhoneLines;
      readonly providers: PhoneProviders;
      readonly keys: Pick<SecretRepository, "set" | "delete">;
      /** LiveKit, when the server has it. */
      readonly liveKit: () => LiveKitApi | null;
    },
  ) {}

  async connect(id: string): Promise<PhoneLineView> {
    const line = this.deps.lines.get(id);
    if (!line?.phone.number) throw new PhoneLineError(`There is no phone line "${id}".`, 404);
    const liveKit = this.deps.liveKit();
    if (!liveKit) throw new PhoneLineError("Calls need LiveKit: run it beside Dash (dash/docker) or set DASH_LIVEKIT_URL, DASH_LIVEKIT_API_KEY, DASH_LIVEKIT_API_SECRET and DASH_LIVEKIT_SIP_URI for a LiveKit Cloud project.", 409);
    const voice = this.deps.providers[line.phone.provider]?.(this.deps.lines.keysFor(line)).voice;
    if (!voice) throw new PhoneLineError("This line's provider does not carry calls.", 501);
    if (line.phone.voice.media) throw new PhoneLineError("This line's calls are already connected.", 409);
    const trunk = await voice.connectTrunk({ sipUri: liveKit.config.sipUri, numbers: [line.phone.number] });
    if (trunk.termination) this.deps.keys.set(sipPasswordRef(id), trunk.termination.password);
    const name = `Dash ${line.title}`.slice(0, 60);
    const inbound = await liveKit.createInboundTrunk(name, [line.phone.number]);
    const dispatch = await liveKit.createDispatchRule(inbound, `${ROOM_IN}${id}-`, { line: id });
    const outbound = trunk.termination ? await liveKit.createOutboundTrunk(name, trunk.termination.address, [line.phone.number], { username: trunk.termination.username, password: trunk.termination.password }) : "";
    this.deps.lines.setVoice(id, { status: "ready", trunk: trunk.id, media: { inbound, dispatch, outbound } });
    return this.deps.lines.view(this.deps.lines.get(id)!);
  }

  async disconnect(id: string): Promise<PhoneLineView> {
    const line = this.deps.lines.get(id);
    if (!line) throw new PhoneLineError(`There is no phone line "${id}".`, 404);
    const liveKit = this.deps.liveKit();
    const media = line.phone.voice.media;
    if (liveKit && media) {
      await liveKit.deleteDispatchRule(media.dispatch).catch(() => undefined);
      await liveKit.deleteTrunk(media.inbound).catch(() => undefined);
      if (media.outbound) await liveKit.deleteTrunk(media.outbound).catch(() => undefined);
    }
    const voice = this.deps.providers[line.phone.provider]?.(this.deps.lines.keysFor(line)).voice;
    if (voice && line.phone.voice.trunk) await voice.disconnectTrunk(line.phone.voice.trunk);
    this.deps.keys.delete(sipPasswordRef(id));
    this.deps.lines.setVoice(id, { status: "not_connected" });
    return this.deps.lines.view(this.deps.lines.get(id)!);
  }

  /** The outbound trunk for calls placed from this number. */
  outboundFor(number: string): string | null {
    return this.deps.lines.all().find((one) => one.phone.number === number)?.phone.voice.media?.outbound || null;
  }
}
