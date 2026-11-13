import { keywordOf, type InboundText, type PhoneKeyword } from "@freebirdai/dash-spec";
import type { PhoneLine, PhoneOutreach } from "./outreach.js";
import type { PhoneTextStore } from "./texts.js";

/**
 * Every text that arrives on a line, after its webhook was verified and
 * parsed. The server and the sandbox both come through here.
 *
 * - Kept once by its provider id: a webhook delivered twice does nothing more.
 * - **STOP, HELP and START are Dash's own**, on every provider: STOP
 *   withdraws consent for the number everywhere in the workspace (so every
 *   line stops texting it) and sends one confirmation; HELP says who this is
 *   and how to reach a person; START restores consent given before on a form
 *   or booking page, and says so. None of them reaches an agent, a workflow
 *   or the inbound screen as conversation, so no prompt can talk a contact
 *   back in.
 * - Anything else is conversation: `arrived` finds the contact, screens it
 *   and starts the workflows listening for texts.
 */

export interface PhoneInboxDeps {
  readonly texts: PhoneTextStore;
  readonly outreach: Pick<PhoneOutreach, "keywordReply">;
  readonly consent: {
    /** STOP: no more texts to this number, from any line. */
    withdraw(number: string): Promise<void>;
    /** START: true when there was consent to restore. */
    restore(number: string): Promise<boolean>;
  };
  /** The business's name, as texts sign it. */
  readonly brand: () => Promise<string>;
  /** A text that is conversation: the contact, the inbound screen, and workflows. What became of it. */
  readonly arrived: (line: PhoneLine, text: InboundText) => Promise<{ readonly contact?: string; readonly screen?: string; readonly held?: boolean }>;
  /** Reports a use (`PhoneLines.report`): each text received, once. Absent: nowhere. */
  readonly report?: (line: PhoneLine, use: { readonly kind: "text_received"; readonly quantity: number; readonly at: string; readonly key: string }) => void;
}

export type InboxOutcome = { readonly kind: "duplicate" } | { readonly kind: "keyword"; readonly keyword: PhoneKeyword } | { readonly kind: "arrived"; readonly held: boolean };

export const keywordAnswer = (keyword: PhoneKeyword, brand: string, restored: boolean): string => {
  switch (keyword) {
    case "stop":
      return `${brand}: You're unsubscribed and won't get more texts from us. Reply START to get them again.`;
    case "help":
      return `${brand}: For help, reply here with your question and a person will get back to you. Msg & data rates may apply. Reply STOP to opt out.`;
    case "start":
      return restored
        ? `${brand}: You're subscribed again. Msg & data rates may apply. Reply STOP to opt out.`
        : `${brand}: We don't have your agreement to texts on record, so we only answer messages you send us. Reply STOP to opt out.`;
  }
};

export class PhoneInbox {
  constructor(private readonly deps: PhoneInboxDeps) {}

  async receive(line: PhoneLine, text: InboundText): Promise<InboxOutcome> {
    const keyword = keywordOf(text.body);
    const kept = await this.deps.texts.add({ line: line.id, id: text.providerId, number: text.from, direction: "in", body: text.body, at: text.at, ...(keyword ? { keyword } : {}) });
    if (!kept) return { kind: "duplicate" };
    this.deps.report?.(line, { kind: "text_received", quantity: 1, at: text.at, key: `text-in:${line.id}:${text.providerId}` });
    if (keyword) {
      let restored = false;
      if (keyword === "stop") await this.deps.consent.withdraw(text.from);
      if (keyword === "start") restored = await this.deps.consent.restore(text.from);
      const brand = await this.deps.brand();
      await this.deps.outreach.keywordReply(line, text.from, keywordAnswer(keyword, brand, restored), keyword, `kw-${keyword}-${text.providerId}`);
      return { kind: "keyword", keyword };
    }
    const went = await this.deps.arrived(line, text);
    await this.deps.texts.update(line.id, text.providerId, { ...(went.contact ? { contact: went.contact } : {}), ...(went.screen ? { screen: went.screen } : {}), ...(went.held ? { held: true } : {}) });
    return { kind: "arrived", held: went.held === true };
  }
}
