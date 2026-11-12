import type { DeliveryUpdate, InboundText } from "@freebirdai/dash-spec";
import { PhoneParseError, type PhoneKeys, type PhoneProviders, type RawRequest } from "@freebirdai/phone";
import type { PhoneLine } from "./outreach.js";

/**
 * A phone provider's webhook for one line: an inbound text, or a status
 * update on something sent. The route (`routes/phone-hooks.ts`) and the
 * sandbox both come through here, so a sandbox text is checked exactly as a
 * real one.
 *
 * **The signature is checked on the raw request before a byte of it is
 * parsed.** A request whose line, provider or event is unknown is refused
 * before that too, so nothing a stranger sends is decoded until the line's
 * own provider has said its signature is good.
 */

export const PHONE_EVENTS = ["text", "status"] as const;
export type PhoneEvent = (typeof PHONE_EVENTS)[number];

export interface PhoneWebhookDeps {
  readonly line: (id: string) => PhoneLine | null;
  readonly providers: PhoneProviders;
  readonly keysFor: (line: PhoneLine) => PhoneKeys;
  readonly onText: (line: PhoneLine, text: InboundText) => Promise<void>;
  readonly onStatus: (line: PhoneLine, update: DeliveryUpdate) => Promise<void>;
}

export type PhoneWebhookAnswer = { readonly status: 200 } | { readonly status: 400 | 403 | 404; readonly error: string };

const isEvent = (value: string): value is PhoneEvent => (PHONE_EVENTS as readonly string[]).includes(value);

export const receivePhoneWebhook = async (deps: PhoneWebhookDeps, lineId: string, event: string, raw: RawRequest): Promise<PhoneWebhookAnswer> => {
  const line = deps.line(lineId);
  const text = line ? deps.providers[line.phone.provider]?.({}).text : undefined;
  if (!line || !text || !isEvent(event)) return { status: 404, error: "Not found." };
  /* Before anything is parsed. */
  if (!text.verify(raw, deps.keysFor(line))) return { status: 403, error: "The signature does not match." };
  try {
    if (event === "text") {
      const inbound = text.parseInbound(raw);
      if (line.phone.number && inbound.to !== line.phone.number) return { status: 400, error: "This text is for another number." };
      await deps.onText(line, inbound);
    } else {
      await deps.onStatus(line, text.parseStatus(raw));
    }
  } catch (error) {
    if (error instanceof PhoneParseError) return { status: 400, error: error.message };
    throw error;
  }
  return { status: 200 };
};
