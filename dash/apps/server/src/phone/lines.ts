import type { SecretRepository } from "@freebirdai/connect/host";
import { e164Schema, mailboxOwnerSchema, type ConnectionSpec, type CredentialField, type MailboxOwner, type PhoneLineView, type Principal } from "@freebirdai/dash-spec";
import { FAKE_PROVIDER_ID, PhoneKeysError, type PhoneKeys, type PhoneProviders } from "@freebirdai/phone";
import type { Policy } from "../identity/policy.js";
import type { PhoneLine } from "./outreach.js";
import { utcDay, type PhoneUsageStore } from "./usage.js";

/**
 * A workspace's phone lines: connections with `phone`, listed in
 * Communications beside mailboxes and owned the same way. A line's keys are
 * in the vault, one entry per credential field (`lineKeyRef`), and read for
 * each use.
 *
 * Adding a line here takes a provider this server knows, its keys and a
 * number already in the account. Settings → Phone (buying a number, routing
 * it, the test call) comes with the first real provider.
 */

export class PhoneLineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const lineKeyRef = (line: string, field: string): string => `phone-${line}-${field}`;

export const isLine = (connection: ConnectionSpec): connection is ConnectionSpec & PhoneLine => connection.phone !== undefined;

export interface PhoneLinesDeps {
  readonly connections: {
    list(): readonly ConnectionSpec[];
    get(id: string): ConnectionSpec | null;
    put(spec: ConnectionSpec): void;
    remove(id: string): Promise<void>;
  };
  readonly keys: Pick<SecretRepository, "get" | "set" | "delete">;
  readonly providers: PhoneProviders;
  readonly usage: PhoneUsageStore;
  readonly policy: Policy;
  readonly agents: { get(id: string): Promise<{ readonly archived?: boolean | undefined } | null> };
  readonly now: () => number;
}

export class PhoneLines {
  constructor(private readonly deps: PhoneLinesDeps) {}

  all(): PhoneLine[] {
    return this.deps.connections.list().filter(isLine);
  }

  get(id: string): PhoneLine | null {
    const connection = this.deps.connections.get(id);
    return connection && isLine(connection) ? connection : null;
  }

  /** The line's keys, from the vault, for one use. */
  keysFor(line: PhoneLine): PhoneKeys {
    const open = this.deps.providers[line.phone.provider];
    if (!open) return {};
    const out: Record<string, string> = {};
    for (const field of open({}).credentials) {
      const value = this.deps.keys.get(lineKeyRef(line.id, field.key));
      if (value !== null) out[field.key] = value;
    }
    return out;
  }

  /** The providers this server knows, with what each asks for. */
  providers(): Array<{ readonly id: string; readonly title: string; readonly credentials: ReturnType<PhoneProviders[string]>["credentials"] }> {
    return Object.values(this.deps.providers).map((open) => {
      const provider = open({});
      return { id: provider.id, title: provider.title, credentials: provider.credentials };
    });
  }

  async view(line: PhoneLine): Promise<PhoneLineView> {
    const day = utcDay(this.deps.now());
    return {
      id: line.id,
      title: line.title,
      provider: line.phone.provider,
      ...(line.phone.number ? { number: line.phone.number } : {}),
      owner: line.phone.owner,
      text: line.phone.text.status,
      voice: line.phone.voice.status,
      today: {
        texts: await this.deps.usage.used(line.id, day, "text"),
        textsPerDay: line.phone.ceilings.textsPerDay,
        callMinutes: await this.deps.usage.used(line.id, day, "call"),
        callMinutesPerDay: line.phone.ceilings.callMinutesPerDay,
      },
    };
  }

  /** Every line this person may read. */
  async lines(principal: Principal): Promise<PhoneLineView[]> {
    const out: PhoneLineView[] = [];
    for (const line of this.all()) {
      if (!(await this.deps.policy.can(principal, "records.read", { connection: line.id })).ok) continue;
      out.push(await this.view(line));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A line on a number already in the provider's account: keys checked with the provider, then kept in the vault. */
  async add(input: { readonly provider: string; readonly number: string; readonly keys: PhoneKeys; readonly owner?: MailboxOwner; readonly title?: string }): Promise<PhoneLineView> {
    const open = this.provider(input.provider);
    const provider = open({});
    const keys = this.keysGiven(provider.credentials, input.keys);
    try {
      await provider.verify(keys);
    } catch (error) {
      if (error instanceof PhoneKeysError) throw new PhoneLineError(error.message, 400);
      throw error;
    }
    const number = this.number(input.number);
    const owned = await open(keys).numbers.list();
    if (!owned.some((one) => one.number === number)) throw new PhoneLineError(`${number} is not in this ${provider.title} account.`);
    return this.view(await this.create({ ...input, keys }));
  }

  private provider(id: string): PhoneProviders[string] {
    const open = this.deps.providers[id];
    if (!open) throw new PhoneLineError(`This server has no phone provider "${id}".`, 404);
    return open;
  }

  private number(raw: string): string {
    const number = e164Schema.safeParse(raw.trim());
    if (!number.success) throw new PhoneLineError("Give the number in international form, like +15551234567.");
    return number.data;
  }

  /** Every credential field the provider asks for, each filled in. */
  keysGiven(fields: readonly CredentialField[], given: PhoneKeys): Record<string, string> {
    const keys: Record<string, string> = {};
    for (const field of fields) {
      const value = given[field.key]?.trim();
      if (!value) throw new PhoneLineError(`Give the ${field.label}.`);
      keys[field.key] = value;
    }
    return keys;
  }

  async checkOwner(owner: MailboxOwner | undefined): Promise<MailboxOwner> {
    const parsed = mailboxOwnerSchema.parse(owner ?? { kind: "team" });
    if (parsed.kind === "agent") {
      const agent = await this.deps.agents.get(parsed.id);
      if (!agent || agent.archived) throw new PhoneLineError("That agent does not exist.", 404);
    }
    return parsed;
  }

  /**
   * The line itself, once its keys are checked and its number is in the
   * account: its keys copied into the vault under the line, its owner, and
   * where its texts and calls stand. A real provider's line starts unregistered
   * for texts and without calls; the fake carrier's account is pretend-registered
   * and pretend-trunked, so a local server can try a line end to end.
   */
  async create(input: { readonly provider: string; readonly number: string; readonly keys: PhoneKeys; readonly owner?: MailboxOwner; readonly title?: string }): Promise<PhoneLine> {
    const provider = this.provider(input.provider)({});
    const number = this.number(input.number);
    const owner = await this.checkOwner(input.owner);
    if (this.all().some((one) => one.phone.number === number)) throw new PhoneLineError(`${number} is already a line here.`, 409);
    const keys = this.keysGiven(provider.credentials, input.keys);
    const pretend = provider.id === FAKE_PROVIDER_ID;
    let id = `line-${number.slice(1)}`;
    for (let suffix = 2; this.deps.connections.get(id); suffix++) id = `line-${number.slice(1)}-${suffix}`;
    for (const [field, value] of Object.entries(keys)) this.deps.keys.set(lineKeyRef(id, field), value);
    const connection = {
      specVersion: 1,
      id,
      title: input.title?.trim().slice(0, 120) || `${provider.title} ${number}`,
      kind: "inline",
      auth: { type: "none" },
      authRequired: false,
      ops: [],
      resources: [],
      phone: { provider: provider.id, number, owner, text: { status: pretend ? "approved" : "needs_registration" }, voice: { status: pretend ? "ready" : "not_connected" }, ceilings: { textsPerDay: 200, callMinutesPerDay: 120 } },
    } as unknown as ConnectionSpec & PhoneLine;
    this.deps.connections.put(connection);
    return connection;
  }

  /** Whose it is: only where it is shown, and who may text from it, changes. */
  async setOwner(id: string, owner: MailboxOwner): Promise<PhoneLineView> {
    const line = this.get(id);
    if (!line) throw new PhoneLineError(`There is no phone line "${id}".`, 404);
    const next = { ...(line as unknown as ConnectionSpec), phone: { ...line.phone, owner: await this.checkOwner(owner) } } as ConnectionSpec & PhoneLine;
    this.deps.connections.put(next);
    return this.view(next);
  }

  async remove(id: string): Promise<void> {
    const line = this.get(id);
    if (!line) throw new PhoneLineError(`There is no phone line "${id}".`, 404);
    const open = this.deps.providers[line.phone.provider];
    for (const field of open ? open({}).credentials : []) this.deps.keys.delete(lineKeyRef(id, field.key));
    await this.deps.connections.remove(id);
  }
}
