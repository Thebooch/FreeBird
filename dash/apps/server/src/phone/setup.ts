import { randomBytes } from "node:crypto";
import type { SecretRepository } from "@freebirdai/connect/host";
import type { AccountInfo, AvailableNumber, MailboxOwner, OwnedNumber, PhoneLineView } from "@freebirdai/dash-spec";
import { PhoneKeysError, type PhoneKeys, type PhoneProviders } from "@freebirdai/phone";
import { PhoneLineError, type PhoneLines } from "./lines.js";
import type { PhoneLineOffer, PhoneLineSource } from "./line-source.js";

/**
 * Settings → Phone: connecting a provider and a number, so a person never
 * opens the provider's console after the first copy-paste.
 *
 * 1. **Keys.** Pasted once per provider, checked with `verify` (the account's
 *    name comes back, and a trial is named), then kept in the vault as
 *    `phone-account-<provider>-<field>` and never shown again.
 * 2. **The public address**, checked before anything is bought: Dash asks
 *    itself through the address it believes is public and expects its own
 *    one-time answer back. Without it no webhook can arrive, so setup stops
 *    and says how to fix it.
 * 3. **A number:** a new one bought, one already in the account, or a new
 *    one to receive on while the business keeps its own number by forwarding
 *    calls to it.
 * 4. **Wiring:** the number's texts are pointed at the line's webhook through
 *    the provider's API. Nothing is typed into the provider by hand.
 */

export const accountKeyRef = (provider: string, field: string): string => `phone-account-${provider}-${field}`;

export interface AddressCheck {
  readonly ok: boolean;
  /** The address providers will call. */
  readonly origin?: string;
  readonly problem?: string;
  /** The two ways to fix it, in plain words, with what to type. */
  readonly fixes?: readonly { readonly title: string; readonly steps: readonly string[] }[];
}

export type NumberChoice = "new" | "existing" | "forward";

export interface PhoneSetupDeps {
  readonly providers: PhoneProviders;
  /** Lines the server's host provides. Default: none, so setup offers only connecting your own provider. */
  readonly source?: PhoneLineSource;
  readonly keys: Pick<SecretRepository, "get" | "set" | "delete" | "has">;
  readonly lines: PhoneLines;
  readonly workspace: string;
  /** Where providers reach this server. Absent: not known, and setup says so. */
  readonly publicOrigin?: string;
  /** Asks this server something through its public address. Default: `fetch`, five seconds. */
  readonly probe?: (url: string) => Promise<{ readonly status: number; readonly text: string }>;
  readonly now: () => number;
}

const FIXES = (port: string): AddressCheck["fixes"] => [
  {
    title: "Use a tunnel",
    steps: [
      "Install Cloudflare Tunnel (cloudflared) on this machine.",
      `Run: cloudflared tunnel --url http://localhost:${port}`,
      "Copy the https address it prints, and start Dash with DASH_PUBLIC_ORIGIN set to it.",
    ],
  },
  {
    title: "Use this server's own domain",
    steps: ["Point a domain at this server with https (a reverse proxy such as Caddy or nginx).", "Start Dash with DASH_PUBLIC_ORIGIN=https://your-domain."],
  },
];

const defaultProbe = async (url: string): Promise<{ status: number; text: string }> => {
  const answer = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  return { status: answer.status, text: await answer.text() };
};

/** Forwarding from the number customers know to the line, by carrier. Codes vary by plan: say so. */
export const forwardingSteps = (line: string): readonly string[] => [
  `Most US carriers (Verizon, AT&T, US Cellular): on the business phone, dial *72${line.replace(/^\+1/, "")} and wait for the confirmation.`,
  `T-Mobile: dial **21*${line}# and press call.`,
  "A desk phone or a phone system: set its call forwarding to the number above, in its settings or with your phone company.",
  "Forwarding moves calls only. Texts sent to the business number still reach that phone; ask customers to text the new number.",
];

export class PhoneSetup {
  /** One-time answers this server is waiting to hear from itself, and when each was asked. */
  private readonly asked = new Map<string, number>();

  constructor(private readonly deps: PhoneSetupDeps) {}

  private open(provider: string): PhoneProviders[string] {
    const open = this.deps.providers[provider];
    if (!open) throw new PhoneLineError(`This server has no phone provider "${provider}".`, 404);
    return open;
  }

  /** The keys pasted for a provider, from the vault. */
  accountKeys(provider: string): PhoneKeys {
    const out: Record<string, string> = {};
    for (const field of this.open(provider)({}).credentials) {
      const value = this.deps.keys.get(accountKeyRef(provider, field.key));
      if (value !== null) out[field.key] = value;
    }
    return out;
  }

  /** Each provider this server knows, whether its keys are in, and what they ask for. */
  accounts(): Array<{ readonly id: string; readonly title: string; readonly connected: boolean; readonly credentials: ReturnType<PhoneProviders[string]>["credentials"]; readonly capabilities: ReturnType<PhoneProviders[string]>["capabilities"] }> {
    return Object.values(this.deps.providers).map((open) => {
      const provider = open({});
      return { id: provider.id, title: provider.title, connected: provider.credentials.every((field) => this.deps.keys.has(accountKeyRef(provider.id, field.key))), credentials: provider.credentials, capabilities: provider.capabilities };
    });
  }

  /** Checks the keys with the provider, then keeps them. Nothing is kept for keys it refuses. */
  async connect(providerId: string, given: PhoneKeys): Promise<AccountInfo> {
    const provider = this.open(providerId)({});
    const keys = this.deps.lines.keysGiven(provider.credentials, given);
    let account: AccountInfo;
    try {
      account = await provider.verify(keys);
    } catch (error) {
      if (error instanceof PhoneKeysError) throw new PhoneLineError(error.message, 400);
      throw error;
    }
    for (const [field, value] of Object.entries(keys)) this.deps.keys.set(accountKeyRef(providerId, field), value);
    return account;
  }

  disconnect(providerId: string): void {
    for (const field of this.open(providerId)({}).credentials) this.deps.keys.delete(accountKeyRef(providerId, field.key));
  }

  private connected(providerId: string): PhoneKeys {
    const open = this.open(providerId);
    const keys = this.accountKeys(providerId);
    if (!open({}).credentials.every((field) => keys[field.key])) throw new PhoneLineError("Connect the provider's account first: paste its keys.", 409);
    return keys;
  }

  search(providerId: string, areaCode?: string): Promise<AvailableNumber[]> {
    return this.open(providerId)(this.connected(providerId)).numbers.search(areaCode ? { areaCode } : {});
  }

  owned(providerId: string): Promise<OwnedNumber[]> {
    return this.open(providerId)(this.connected(providerId)).numbers.list();
  }

  /** The public address, checked by asking this server through it. */
  async checkAddress(): Promise<AddressCheck> {
    const origin = this.deps.publicOrigin?.replace(/\/+$/, "");
    const port = process.env.PORT ?? "4600";
    if (!origin) return { ok: false, problem: "This server does not know the address the internet reaches it at, so texts and calls could not arrive.", fixes: FIXES(port) };
    if (!origin.startsWith("https://")) return { ok: false, origin, problem: `${origin} is not an https address. Phone providers should call this server over https.`, fixes: FIXES(port) };
    const nonce = randomBytes(18).toString("base64url");
    this.asked.set(nonce, this.deps.now());
    try {
      const answer = await (this.deps.probe ?? defaultProbe)(`${origin}/api/public/${this.deps.workspace}/phone-check/${nonce}`);
      if (answer.status === 200 && answer.text.includes(nonce)) return { ok: true, origin };
      return { ok: false, origin, problem: `Something answered at ${origin}, but it was not this server.`, fixes: FIXES(port) };
    } catch {
      return { ok: false, origin, problem: `Nothing answered at ${origin}. It may be down, or not pointed at this server.`, fixes: FIXES(port) };
    } finally {
      this.asked.delete(nonce);
    }
  }

  /** The public route's answer to this server's own question: only a nonce it is waiting on, for a minute. */
  answer(nonce: string): boolean {
    const at = this.asked.get(nonce);
    return at !== undefined && this.deps.now() - at < 60_000;
  }

  /** What the host offers this workspace: none unless the server has a line source. */
  async offers(): Promise<readonly PhoneLineOffer[]> {
    return this.deps.source ? this.deps.source.offers(this.deps.workspace) : [];
  }

  /**
   * A line the host provides: the address checked first, then the host makes
   * the number on its own account, then the line is made with the host's keys
   * and its texts pointed at the line's webhook, as for a line of one's own.
   * Its number goes back to the host if wiring it fails.
   */
  async provideLine(input: { readonly offer: string; readonly areaCode?: string; readonly owner?: MailboxOwner; readonly title?: string }): Promise<{ readonly line: PhoneLineView }> {
    const source = this.deps.source;
    if (!source || !(await source.offers(this.deps.workspace)).some((one) => one.id === input.offer)) throw new PhoneLineError("This server provides no such line.", 404);
    const address = await this.checkAddress();
    if (!address.ok || !address.origin) throw new PhoneLineError(address.problem ?? "This server cannot be reached from the internet yet.", 409);
    await this.deps.lines.checkOwner(input.owner);
    const made = await source.provision({ workspace: this.deps.workspace, offer: input.offer, ...(input.areaCode && /^\d{3}$/.test(input.areaCode) ? { areaCode: input.areaCode } : {}) });
    let line: Awaited<ReturnType<PhoneLines["createProvided"]>>;
    try {
      this.open(made.provider);
      line = await this.deps.lines.createProvided({ offer: input.offer, provider: made.provider, number: made.number, ref: made.ref, ...(input.owner ? { owner: input.owner } : {}), ...(input.title ? { title: input.title } : {}) });
    } catch (error) {
      await source.release({ workspace: this.deps.workspace, line: "", ref: made.ref });
      throw error;
    }
    const provider = this.open(made.provider);
    if (provider({}).capabilities.text) await provider(this.deps.lines.keysFor(line)).numbers.route(made.number, { textWebhook: new URL(`${address.origin}/api/public/${this.deps.workspace}/phone/${line.id}/text`) });
    return { line: await this.deps.lines.view(line) };
  }

  /**
   * A line, wired: the address checked first, then the number bought (new, or
   * to receive on for a forwarded business number) or found in the account,
   * then its texts pointed at the line's webhook.
   */
  async addLine(input: { readonly provider: string; readonly choice: NumberChoice; readonly number: string; readonly owner?: MailboxOwner; readonly title?: string }): Promise<{ readonly line: PhoneLineView; readonly forwarding?: readonly string[] }> {
    const address = await this.checkAddress();
    if (!address.ok || !address.origin) throw new PhoneLineError(address.problem ?? "This server cannot be reached from the internet yet.", 409);
    const open = this.open(input.provider);
    const keys = this.connected(input.provider);
    const numbers = open(keys).numbers;
    const texts = open({}).capabilities.text;
    if (!texts && input.choice !== "existing") throw new PhoneLineError("This provider's numbers come from the carrier: pick one already on the trunk.");
    await this.deps.lines.checkOwner(input.owner);
    let number = input.number.trim();
    if (input.choice === "existing") {
      if (!(await numbers.list()).some((one) => one.number === number)) throw new PhoneLineError(`${number} is not in this account.`);
    } else {
      number = (await numbers.buy(number)).number;
    }
    const line = await this.deps.lines.create({ provider: input.provider, number, keys, ...(input.owner ? { owner: input.owner } : {}), ...(input.title ? { title: input.title } : {}) });
    /* Texts point at the line's webhook; a calls-only line's calls are connected from the line itself. */
    if (texts) await numbers.route(number, { textWebhook: new URL(`${address.origin}/api/public/${this.deps.workspace}/phone/${line.id}/text`) });
    return { line: await this.deps.lines.view(line), ...(input.choice === "forward" ? { forwarding: forwardingSteps(number) } : {}) };
  }
}
