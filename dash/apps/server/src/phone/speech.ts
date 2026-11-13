/**
 * Speech for calls (Dash Phone, Phase 3): speech-to-text and text-to-speech,
 * each its own model task (`speech-to-text`, `text-to-speech`), bring your
 * own. The local default speaks the OpenAI audio API's shape, which other
 * providers and self-hosted servers also offer: `DASH_SPEECH_URL` (default
 * https://api.openai.com/v1), `DASH_SPEECH_API_KEY` (else `OPENAI_API_KEY`),
 * and `DASH_MODEL_SPEECH_TO_TEXT` / `DASH_MODEL_TEXT_TO_SPEECH` /
 * `DASH_SPEECH_VOICE` for the models and the voice.
 *
 * Audio here is 16-bit mono PCM.
 */

export interface Pcm {
  readonly samples: Int16Array;
  readonly sampleRate: number;
}

export interface SpeechModels {
  transcribe(audio: Pcm): Promise<string>;
  speak(text: string): Promise<Pcm>;
}

export interface SpeechConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly voice: string;
}

export const speechFromEnv = (env: NodeJS.ProcessEnv = process.env): SpeechConfig | null => {
  const apiKey = env["DASH_SPEECH_API_KEY"]?.trim() || env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) return null;
  return {
    url: (env["DASH_SPEECH_URL"]?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    sttModel: env["DASH_MODEL_SPEECH_TO_TEXT"]?.trim() || "gpt-4o-mini-transcribe",
    ttsModel: env["DASH_MODEL_TEXT_TO_SPEECH"]?.trim() || "gpt-4o-mini-tts",
    voice: env["DASH_SPEECH_VOICE"]?.trim() || "alloy",
  };
};

/** PCM as a WAV file, for a transcription upload. */
export const wavOf = (audio: Pcm): Uint8Array => {
  const data = Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
};

/** The rate the speech API's raw PCM comes back at. */
export const TTS_SAMPLE_RATE = 24_000;

export type SpeechFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string | FormData }) => Promise<{ readonly status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export const openAiSpeech = (config: SpeechConfig, doFetch: SpeechFetch = async (url, init) => fetch(url, init)): SpeechModels => ({
  transcribe: async (audio) => {
    const form = new FormData();
    form.append("model", config.sttModel);
    form.append("file", new Blob([wavOf(audio)], { type: "audio/wav" }), "speech.wav");
    const answer = await doFetch(`${config.url}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}` }, body: form });
    const text = await answer.text();
    if (answer.status >= 400) throw new Error(`Speech-to-text answered ${answer.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  },
  speak: async (text) => {
    const answer = await doFetch(`${config.url}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.ttsModel, voice: config.voice, input: text, response_format: "pcm" }),
    });
    if (answer.status >= 400) throw new Error(`Text-to-speech answered ${answer.status}: ${(await answer.text()).slice(0, 200)}`);
    const bytes = await answer.arrayBuffer();
    return { samples: new Int16Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2))), sampleRate: TTS_SAMPLE_RATE };
  },
});
