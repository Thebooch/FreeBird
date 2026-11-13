import type { CallRecord } from "@freebirdai/dash-spec";
import type { CallService } from "./call-service.js";
import { callId } from "./calls.js";
import type { SpeechModels } from "./speech.js";

/**
 * The voice worker (Dash Phone, Phase 3): joins a call's room as the line's
 * agent and carries it. What the caller says arrives as text (the media
 * session runs speech-to-text), goes to the call session, and its answer is
 * spoken back (text-to-speech). It ends the call at the line's daily minute
 * ceiling, hands it to a person on a transfer, and keeps the call when it
 * ends, with its minutes counted on the line.
 *
 * The loop is plain words over `MediaSession`, so it is tested with a fake
 * one. `liveKitMedia` is the real one: LiveKit's Node SDK
 * (`@livekit/rtc-node`, loaded only when calls are set up) with the
 * server's speech models.
 */

export interface MediaSession {
  /** What the caller says, one utterance at a time, as text. Ends when they hang up. */
  utterances(): AsyncIterable<string>;
  speak(text: string): Promise<void>;
  /** Hands the caller to this number, saying the whisper to whoever answers. */
  transfer(to: string, whisper: string): Promise<void>;
  hangUp(): Promise<void>;
}

export interface MediaConnector {
  join(room: string): Promise<MediaSession>;
}

export interface CallInfo {
  readonly room: string;
  readonly direction: "in" | "out";
  readonly line: string;
  readonly number: string;
  readonly purpose?: string;
  /** For a call placed out: its send key, so its end is counted on that send. */
  readonly key?: string;
  readonly maxMinutes: number;
}

export interface VoiceWorkerDeps {
  readonly calls: CallService;
  readonly media: MediaConnector;
  /** A call ended: its minutes go on the line's use. */
  readonly ended?: (info: CallInfo, call: CallRecord, minutes: number) => Promise<void>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

export const WRAP_UP = "We're out of time on this call. Someone from the team will follow up. Goodbye.";

export class VoiceWorker {
  private readonly attending = new Set<string>();

  constructor(private readonly deps: VoiceWorkerDeps) {}

  /** Carries one call from the first words to the hang-up. Joining a room twice does nothing more. */
  async attend(info: CallInfo): Promise<CallRecord | null> {
    if (this.attending.has(info.room)) return null;
    this.attending.add(info.room);
    const id = callId(info.line, info.room);
    const started = this.deps.now();
    let media: MediaSession | null = null;
    try {
      media = await this.deps.media.join(info.room);
      const { turn } = await this.deps.calls.start({ id, line: info.line, number: info.number, direction: info.direction, ...(info.purpose ? { purpose: info.purpose } : {}) });
      if (turn.say) await media.speak(turn.say);
      let done = Boolean(turn.transfer);
      if (turn.transfer) await media.transfer(turn.transfer.to, turn.transfer.whisper);
      const deadline = started + Math.max(1, info.maxMinutes) * 60_000;
      if (!done) {
        for await (const heard of media.utterances()) {
          if (this.deps.now() >= deadline) {
            await media.speak(WRAP_UP);
            break;
          }
          const next = await this.deps.calls.hear(id, heard);
          if (next.say) await media.speak(next.say);
          if (next.transfer) {
            await media.transfer(next.transfer.to, next.transfer.whisper);
            done = true;
            break;
          }
          if (next.end) break;
        }
      }
      if (!done) await media.hangUp();
    } catch (error) {
      this.deps.log?.(`a call in ${info.room} stopped: ${error instanceof Error ? error.message : String(error)}`);
      await media?.hangUp().catch(() => undefined);
    } finally {
      this.attending.delete(info.room);
    }
    const call = await this.deps.calls.end(id).catch(() => null);
    if (call) await this.deps.ended?.(info, call, Math.max(1, Math.ceil((this.deps.now() - started) / 60_000)));
    return call;
  }
}

/* ── LiveKit's media, for real calls ───────────────────────────────────── */

/** How much quiet ends an utterance, and how loud is speech: a plain energy gate over 20 ms frames. */
const SILENCE_MS = 700;
const SPEECH_LEVEL = 900;

/**
 * Joins a LiveKit room with `@livekit/rtc-node` and runs speech through the
 * server's speech models. Loaded only when calls are configured, so nothing
 * else needs the SDK. Not exercised by the tests: it needs a LiveKit server
 * and real audio (Gate D).
 */
export const liveKitMedia = (deps: {
  readonly url: string;
  readonly token: (room: string) => string;
  readonly speech: SpeechModels;
  /** Dials a team member into the room and resolves once they answer (a warm transfer). */
  readonly dialIn: (room: string, to: string) => Promise<unknown>;
  readonly load?: () => Promise<unknown>;
}): MediaConnector => ({
  join: async (roomName) => {
    const rtc = (await (deps.load?.() ?? import("@livekit/rtc-node" as string))) as any;
    const room = new rtc.Room();
    await room.connect(deps.url, deps.token(roomName), { autoSubscribe: true, dynacast: true });
    const source = new rtc.AudioSource(24_000, 1);
    const track = rtc.LocalAudioTrack.createAudioTrack("agent", source);
    await room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (text: string) => {
      if (text) queue.push(text);
      wake?.();
    };
    room.on(rtc.RoomEvent.Disconnected, () => {
      closed = true;
      wake?.();
    });
    room.on(rtc.RoomEvent.TrackSubscribed, (remote: any) => {
      if (remote.kind !== rtc.TrackKind.KIND_AUDIO) return;
      void (async () => {
        const stream = new rtc.AudioStream(remote, 16_000, 1);
        let chunks: Int16Array[] = [];
        let quiet = 0;
        for await (const frame of stream) {
          const samples = frame.data as Int16Array;
          let energy = 0;
          for (const sample of samples) energy += Math.abs(sample);
          const loud = energy / Math.max(1, samples.length) > SPEECH_LEVEL;
          if (loud || chunks.length > 0) chunks.push(Int16Array.from(samples));
          quiet = loud ? 0 : quiet + (samples.length / 16_000) * 1000;
          if (chunks.length > 0 && quiet >= SILENCE_MS) {
            const all = new Int16Array(chunks.reduce((sum, one) => sum + one.length, 0));
            let at = 0;
            for (const one of chunks) {
              all.set(one, at);
              at += one.length;
            }
            chunks = [];
            quiet = 0;
            push(await deps.speech.transcribe({ samples: all, sampleRate: 16_000 }).catch(() => ""));
          }
        }
      })();
    });
    return {
      utterances: async function* () {
        while (!closed) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          while (queue.length > 0) yield queue.shift()!;
        }
      },
      speak: async (text) => {
        const audio = await deps.speech.speak(text);
        const frame = 480;
        for (let at = 0; at < audio.samples.length; at += frame) {
          const piece = audio.samples.subarray(at, at + frame);
          await source.captureFrame(new rtc.AudioFrame(piece, audio.sampleRate, 1, piece.length));
        }
      },
      /*
       * A warm transfer: the team member is dialled into the room, hears the
       * one-line whisper once they answer, and the agent leaves the two of
       * them talking. The room has one mix, so the caller hears the whisper too.
       */
      transfer: async (to, whisper) => {
        await deps.dialIn(roomName, to);
        const audio = await deps.speech.speak(whisper);
        const frame = 480;
        for (let at = 0; at < audio.samples.length; at += frame) {
          const piece = audio.samples.subarray(at, at + frame);
          await source.captureFrame(new rtc.AudioFrame(piece, audio.sampleRate, 1, piece.length));
        }
        await room.disconnect();
      },
      hangUp: async () => {
        await room.disconnect();
      },
    };
  },
});
