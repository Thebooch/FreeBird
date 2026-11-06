import { requesterKeys, type RequesterRule, type RequesterTrust, type ScreenSignal } from "@freebirdai/dash-spec";

/**
 * The inbound screen's rules: pure, so the server, the sandbox and the tests
 * screen an email the same way. Rules decide; nothing here calls a model.
 *
 * The patterns are known shapes, not a detector: the rule that defeats most
 * injection without detecting it is that values from an email never drive an
 * outside step on Auto (`workflows/inbound-mark.ts`).
 */

export interface ScreenInput {
  readonly from: { readonly address: string; readonly name?: string | undefined };
  readonly subject: string;
  readonly text: string;
  readonly hasAttachments?: boolean;
  /** The sender's contact is linked to a record the workspace holds. */
  readonly knownContact?: boolean;
  /** Rules a person set, by requester key. */
  readonly rules: ReadonlyMap<string, RequesterRule>;
  /** Messages from this sender that reached workflows in the last day. */
  readonly sentToday: number;
  readonly messagesPerDay: number;
  /** The same, for every sender at the sender's domain. */
  readonly domainSentToday?: number;
  readonly domainMessagesPerDay?: number;
  /** The workspace's people and its own addresses: nobody outside may claim to be them. */
  readonly members: readonly { readonly email: string }[];
}

export interface ScreenResult {
  readonly requester: { readonly key: string; readonly trust: RequesterTrust };
  readonly signals: ScreenSignal[];
  /** A rule would hold it. */
  readonly wouldHold: boolean;
}

/** Instructions aimed at whoever reads the email: a model, an agent, a workflow. */
const INJECTION: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i, "tells the reader to ignore its instructions"],
  [/\b(system prompt|developer message|you are now|act as (an?|the) (admin|assistant|system))\b/i, "speaks to an AI system directly"],
  [/<\/?\s*(system|assistant|instructions?)\s*>|\[\s*(system|inst)\s*\]|^\s*(system|assistant)\s*:/im, "carries text dressed as system instructions"],
  [/\b(mark|set|record|flag)\b[^.\n]{0,40}\b(as )?(paid|refunded|approved|cancelled|canceled|closed|vip|admin)\b/i, "asks for a record to be changed"],
  [/\b(set|change|update)\b[^.\n]{0,30}\b(tier|status|role|price|amount|balance|discount|credit)\b[^.\n]{0,20}\bto\b/i, "asks for a value to be changed"],
  [/\b(send|forward|email|export|share)\b[^.\n]{0,40}\b(all|every|other|list of)\b[^.\n]{0,30}\b(customers?|clients?|contacts?|records?|emails?|invoices?|addresses|phone numbers)\b/i, "asks for other people's details"],
  [/\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|notify|inform|ask|alert)\b[^.\n]{0,30}\b(anyone|the team|a human|a person|staff|owner)\b/i, "asks that nobody be told"],
];

/** Someone outside claiming to be one of the business's own people. */
const AUTHORITY = /\b(i am|i'm|this is|speaking as|on behalf of|message from)\b[^.\n]{0,30}\b(the )?(owner|manager|director|ceo|founder|administrator|admin|accountant|staff|your boss)\b/i;

const URLS = /\bhttps?:\/\/[^\s<>"')]+/gi;
const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly"]);

const trustOf = (input: ScreenInput): { key: string; trust: RequesterTrust } => {
  const keys = requesterKeys(input.from.address);
  const rule = input.rules.get(keys.address) ?? input.rules.get(keys.domain);
  if (rule) return { key: rule.key, trust: rule.trust };
  return { key: keys.address, trust: input.knownContact ? "known" : "unknown" };
};

const linkSignals = (text: string): ScreenSignal[] => {
  const out: ScreenSignal[] = [];
  for (const raw of text.match(URLS) ?? []) {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) out.push({ kind: "link", detail: `links to a bare address (${host})`, hold: false });
    else if (host.split(".").some((part) => part.startsWith("xn--"))) out.push({ kind: "link", detail: `links to a look-alike name (${host})`, hold: false });
    else if (SHORTENERS.has(host)) out.push({ kind: "link", detail: `hides where a link goes (${host})`, hold: false });
  }
  return out.slice(0, 3);
};

export const screenEmail = (input: ScreenInput): ScreenResult => {
  const requester = trustOf(input);
  const signals: ScreenSignal[] = [];
  const address = input.from.address.trim().toLowerCase();
  const words = `${input.subject}\n${input.text}`;

  if (requester.trust === "blocked") signals.push({ kind: "blocked", detail: "the sender is blocked", hold: true });
  if (requester.trust !== "trusted" && input.sentToday >= input.messagesPerDay) {
    signals.push({ kind: "over_limit", detail: `${input.sentToday} messages from this sender today, over the limit of ${input.messagesPerDay}`, hold: true });
  } else if (requester.trust !== "trusted" && input.domainMessagesPerDay !== undefined && (input.domainSentToday ?? 0) >= input.domainMessagesPerDay) {
    signals.push({ kind: "over_limit", detail: `${input.domainSentToday} messages from ${address.split("@")[1] ?? "this domain"} today, over the limit of ${input.domainMessagesPerDay}`, hold: true });
  }
  if (requester.trust !== "trusted") {
    for (const [pattern, detail] of INJECTION) if (pattern.test(words)) signals.push({ kind: "injection", detail, hold: true });
    const member = input.members.some((one) => one.email.trim().toLowerCase() === address);
    if (!member) {
      const name = (input.from.name ?? "").trim().toLowerCase();
      const claimed = input.members.find((one) => {
        const email = one.email.trim().toLowerCase();
        if (!email.includes("@")) return false;
        const local = email.split("@")[0] ?? "";
        return name !== "" && (name === email || name.includes(email) || (local.length > 2 && name.replace(/\s+/g, "") === local));
      });
      if (claimed) signals.push({ kind: "impersonation", detail: `the sender's name looks like ${claimed.email}, from another address`, hold: true });
      if (AUTHORITY.test(words)) signals.push({ kind: "impersonation", detail: "claims to be someone in charge, from an address that is not one of the team's", hold: true });
    }
    signals.push(...linkSignals(input.text));
    if (input.hasAttachments && requester.trust === "unknown") signals.push({ kind: "attachment", detail: "carries attachments from an unknown sender", hold: false });
  }
  return { requester, signals, wouldHold: signals.some((signal) => signal.hold) };
};
