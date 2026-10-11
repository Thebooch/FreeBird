import type { CommitResult, WriteIntent, WriteReview } from "@freebirdai/connect";
import type { ReadRequest, ReadResult, WriteOnBehalfOf } from "@freebirdai/connect/host";
import {
  areaOf,
  ignoredAddress,
  isEmptyMailQuery,
  mailboxOwnerSchema,
  mailDraftEditSchema,
  parseMailQuery,
  reachCovers,
  type AgentSpec,
  type CatalogEntry,
  type CommsArea,
  type CommsSettings,
  type CommsState,
  type ConnectionSpec,
  type Contact,
  type MailboxOwner,
  type MailboxView,
  type MailDraft,
  type MailMessage,
  type MailPage,
  type MailQuery,
  type MailThreadMessage,
  type Principal,
} from "@freebirdai/dash-spec";
import type { Policy } from "../identity/policy.js";
import { gmailProvider } from "./gmail.js";
import { graphProvider } from "./graph.js";
import { decodeToken, encodeToken, formatAddresses, replySubject, type MailOutgoing, type MailProvider, type MailRead } from "./mail.js";
import { KEPT_PER_MAILBOX, type CommsStore } from "./store.js";

/**
 * Communications: every mailbox, merged.
 *
 * The only code that reads mail, keeps the newest 100, decides which area a
 * mailbox shows in, and sends. Reads go through the engine (`read`), sends
 * through the write service's review (`writes`), as the person who clicks.
 * A draft written by an agent goes out from the agent's own mailbox, or from
 * a team mailbox only when the agent's reach lets it act there (`records.act`
 * on that connection, set on the agent's page).
 */

export class CommsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CommsError";
  }
}

/** Where a workspace's own OAuth app for a provider is kept: pasted once, copied to each mailbox. */
export const appRefs = (provider: "gmail" | "outlook") => ({ id: `comms-app-${provider}-id`, secret: `comms-app-${provider}-secret` });

export interface CommsDeps {
  readonly connections: {
    list(): ConnectionSpec[];
    get(id: string): ConnectionSpec | null;
    put(spec: ConnectionSpec): void;
    /** Made from a catalog entry, with its own vault names. */
    fromCatalog(entry: CatalogEntry, id: string): ConnectionSpec;
    /** A new or changed connection: the engine should know it. */
    saved?(spec: ConnectionSpec): void;
    /** Removed, with its secrets and everything the engine held for it. */
    remove(id: string): Promise<void>;
  };
  readonly catalog: { get(id: string): CatalogEntry | null };
  readonly keys: { has(ref: string): boolean; get(ref: string): string | null; set(ref: string, value: string): void };
  readonly read: (connection: string, request: ReadRequest) => Promise<ReadResult>;
  readonly writes: {
    prepare(principal: Principal, intent: WriteIntent, options: { readonly via: "form" | "workflow"; readonly onBehalfOf?: WriteOnBehalfOf }): Promise<WriteReview>;
    commit(principal: Principal, pendingId: string, digest: string): Promise<CommitResult>;
  };
  readonly policy: Policy;
  readonly agents: { get(id: string): Promise<AgentSpec | null>; list(): Promise<AgentSpec[]> };
  readonly store: CommsStore;
  /** Every new sender becomes a contact; absent, none do. */
  readonly contacts?: {
    findOrCreate(input: { readonly email: string; readonly name?: string; readonly origin: "email" }): Promise<Contact>;
    match(id: string): Promise<unknown>;
  };
  /** A draft a workflow step wrote was sent, saved or discarded: the step's case goes on. */
  readonly draftSettled?: (draft: MailDraft) => Promise<void>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly log?: { warn(line: string): void };
}

const PAGE = 50;
/** A mailbox read within this long is not read again just because the list was opened. */
const FRESH_MS = 60_000;

type Position =
  | { readonly k: number }
  | { readonly t: string; readonly i: number }
  | { readonly s: string; readonly i: number }
  | null;

type Cursor = Record<string, Position>;

interface Taken {
  readonly message: MailMessage;
  readonly after: Position;
}

const providerOf = (connection: ConnectionSpec): "gmail" | "outlook" | undefined => connection.mailbox?.provider;

export class CommsService {
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly deps: CommsDeps) {}

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /* ── mailboxes ────────────────────────────────────────────────────── */

  private mailboxConnections(): ConnectionSpec[] {
    return this.deps.connections.list().filter((one) => one.mailbox !== undefined);
  }

  private need(id: string): ConnectionSpec {
    const connection = this.deps.connections.get(id);
    if (!connection?.mailbox) throw new CommsError(`There is no mailbox "${id}".`, 404);
    return connection;
  }

  private statusOf(connection: ConnectionSpec): MailboxView["status"] {
    const auth = connection.auth;
    if (auth.type !== "oauth2") return "ready";
    if (!this.deps.keys.has(auth.clientIdRef)) return "needs_app";
    return this.deps.keys.has(auth.keyRef) || (auth.refreshRef !== undefined && this.deps.keys.has(auth.refreshRef)) ? "ready" : "needs_sign_in";
  }

  async view(connection: ConnectionSpec): Promise<MailboxView> {
    const mark = await this.deps.store.mark(connection.id);
    const kept = (await this.deps.store.recent(connection.id)).length;
    return {
      id: connection.id,
      title: connection.title,
      provider: connection.mailbox!.provider,
      ...(connection.mailbox!.address ? { address: connection.mailbox!.address } : {}),
      owner: connection.mailbox!.owner,
      status: this.statusOf(connection),
      kept,
      ...(mark.refreshedAt ? { refreshedAt: mark.refreshedAt } : {}),
      ...(mark.error ? { error: mark.error } : {}),
    };
  }

  /** Every mailbox this person may read. */
  async mailboxes(principal: Principal): Promise<MailboxView[]> {
    const out: MailboxView[] = [];
    for (const connection of this.mailboxConnections()) {
      if (!(await this.deps.policy.can(principal, "records.read", { connection: connection.id })).ok) continue;
      out.push(await this.view(connection));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Whether each provider's OAuth app has been given, and the address the provider must send people back to. */
  apps(): { readonly gmail: boolean; readonly outlook: boolean } {
    return { gmail: this.deps.keys.has(appRefs("gmail").id), outlook: this.deps.keys.has(appRefs("outlook").id) };
  }

  /** The workspace's own OAuth app for a provider, given once and copied to every mailbox of it. */
  setApp(provider: "gmail" | "outlook", clientId: string, clientSecret: string): void {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) throw new CommsError("Give both the client ID and the client secret.");
    const refs = appRefs(provider);
    this.deps.keys.set(refs.id, id);
    this.deps.keys.set(refs.secret, secret);
    for (const connection of this.mailboxConnections()) if (providerOf(connection) === provider) this.copyApp(connection);
  }

  private copyApp(connection: ConnectionSpec): void {
    const provider = providerOf(connection);
    const auth = connection.auth;
    if (!provider || auth.type !== "oauth2") return;
    const refs = appRefs(provider);
    const id = this.deps.keys.get(refs.id);
    const secret = this.deps.keys.get(refs.secret);
    if (id) this.deps.keys.set(auth.clientIdRef, id);
    if (secret && auth.clientSecretRef) this.deps.keys.set(auth.clientSecretRef, secret);
  }

  private async checkOwner(owner: MailboxOwner): Promise<MailboxOwner> {
    const parsed = mailboxOwnerSchema.safeParse(owner);
    if (!parsed.success) throw new CommsError("Say whose mailbox it is: the team's, or one agent's.");
    if (parsed.data.kind === "agent") {
      const agent = await this.deps.agents.get(parsed.data.id);
      if (!agent || agent.archived) throw new CommsError("That agent does not exist.", 404);
    }
    return parsed.data;
  }

  /** A new mailbox, ready for its sign-in: the connection, its owner, and the workspace's app copied in. */
  async addMailbox(input: { readonly provider: "gmail" | "outlook"; readonly owner: MailboxOwner; readonly title?: string }): Promise<MailboxView> {
    const owner = await this.checkOwner(input.owner);
    const entry = this.deps.catalog.get(input.provider);
    if (!entry) throw new CommsError(`${input.provider === "gmail" ? "Gmail" : "Outlook"} is not in this server's catalog.`, 501);
    let id = input.provider as string;
    for (let suffix = 2; this.deps.connections.get(id); suffix++) id = `${input.provider}-${suffix}`;
    const made = this.deps.connections.fromCatalog(entry, id);
    const connection: ConnectionSpec = {
      ...made,
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
      mailbox: { provider: input.provider, owner },
    };
    this.deps.connections.put(connection);
    this.copyApp(connection);
    this.deps.connections.saved?.(connection);
    return this.view(connection);
  }

  /** Whose it is: only where it is shown changes. */
  async setOwner(id: string, owner: MailboxOwner): Promise<MailboxView> {
    const connection = this.need(id);
    const checked = await this.checkOwner(owner);
    const next: ConnectionSpec = { ...connection, mailbox: { ...connection.mailbox!, owner: checked } };
    this.deps.connections.put(next);
    return this.view(next);
  }

  async removeMailbox(id: string): Promise<void> {
    this.need(id);
    await this.deps.connections.remove(id);
    await this.deps.store.forget(id);
  }

  /* ── reading ──────────────────────────────────────────────────────── */

  private provider(connection: ConnectionSpec): MailProvider {
    const read: MailRead = async (op, params, options = {}) => {
      const answer = await this.deps.read(connection.id, { op, params, ...(options.fresh !== undefined ? { fresh: options.fresh } : {}), wait: false });
      return { rows: answer.rows, body: answer.body };
    };
    return providerOf(connection) === "outlook"
      ? graphProvider(read, connection.id, () => this.deps.connections.get(connection.id)?.mailbox?.address)
      : gmailProvider(read, connection.id);
  }

  /** Every address the workspace sends from: never made a contact. */
  private ownAddresses(): Set<string> {
    return new Set(this.mailboxConnections().flatMap((one) => (one.mailbox?.address ? [one.mailbox.address.toLowerCase()] : [])));
  }

  /**
   * What is new in a mailbox: its newest page read fresh, and anything not
   * already kept read and kept; the first time, the newest 100. Senders
   * become contacts.
   */
  refresh(id: string): Promise<void> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const run = this.refreshNow(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, run);
    return run;
  }

  private async refreshNow(id: string): Promise<void> {
    let connection = this.need(id);
    if (this.statusOf(connection) !== "ready") return;
    const provider = this.provider(connection);
    try {
      if (!connection.mailbox!.address) {
        const profile = await provider.profile();
        if (profile.address) {
          connection = { ...connection, mailbox: { ...connection.mailbox!, address: profile.address } };
          this.deps.connections.put(connection);
        }
      }
      const kept = await this.deps.store.recent(id);
      const known = new Set(kept.map((one) => one.id));
      const fresh: MailMessage[] = [];
      /* A provider that answers a list with each message whole (Outlook) refreshes the kept copies' flags too. */
      const updated = new Map<string, MailMessage>();
      let token: string | undefined;
      /* The newest page; more only while every message on it is new and fewer than 100 are kept. */
      for (let pages = 0; pages < 4; pages++) {
        const page = await provider.list(token, kept.length === 0 ? KEPT_PER_MAILBOX : 25);
        const unseen = page.messages.filter((one) => !known.has(one.id));
        for (const one of page.messages) if (known.has(one.id)) updated.set(one.id, one);
        fresh.push(...unseen);
        if (unseen.length < page.messages.length || !page.next || fresh.length >= KEPT_PER_MAILBOX) break;
        token = page.next;
      }
      await this.deps.store.keep(id, [...fresh, ...kept.map((one) => updated.get(one.id) ?? one)]);
      await this.deps.store.setMark(id, { ...(await this.deps.store.mark(id)), refreshedAt: this.iso(), error: undefined });
      await this.senders(fresh);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.store.setMark(id, { ...(await this.deps.store.mark(id)), refreshedAt: this.iso(), error: message.slice(0, 400) });
      throw error;
    }
  }

  /** Each new sender, once: a contact, matched to the workspace's records when new. */
  private async senders(messages: readonly MailMessage[]): Promise<void> {
    const contacts = this.deps.contacts;
    if (!contacts) return;
    const own = this.ownAddresses();
    const { contactIgnore } = await this.deps.store.settings();
    const seen = new Set<string>();
    for (const message of messages) {
      const from = message.from;
      if (message.sent || !from || seen.has(from.address) || own.has(from.address) || ignoredAddress(from.address, contactIgnore)) continue;
      seen.add(from.address);
      try {
        const contact = await contacts.findOrCreate({ email: from.address, ...(from.name ? { name: from.name } : {}), origin: "email" });
        const madeNow = contact.origin === "email" && contact.links.length === 0 && this.deps.now() - Date.parse(contact.createdAt) < 60_000;
        if (madeNow) await contacts.match(contact.id).catch(() => undefined);
      } catch (error) {
        this.deps.log?.warn(`a contact for ${from.address} could not be made: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The mailboxes a list reads: in the area, among those named, that this person may read and that are signed in. */
  private async selected(principal: Principal, area: CommsArea, wanted: readonly string[] | undefined): Promise<ConnectionSpec[]> {
    const out: ConnectionSpec[] = [];
    for (const connection of this.mailboxConnections()) {
      const at = areaOf(connection.mailbox!.owner);
      if (at.kind !== area.kind || (at.kind === "agent" && area.kind === "agent" && at.id !== area.id)) continue;
      if (wanted && wanted.length > 0 && !wanted.includes(connection.id)) continue;
      if (this.statusOf(connection) !== "ready") continue;
      if (!(await this.deps.policy.can(principal, "records.read", { connection: connection.id })).ok) continue;
      out.push(connection);
    }
    return out;
  }

  /** Up to `size` of one mailbox's stream, from where it stood. */
  private async take(connection: ConnectionSpec, position: Position, size: number, query: MailQuery | null): Promise<{ readonly items: Taken[]; readonly capped?: boolean }> {
    if (position === null) return { items: [] };
    const provider = this.provider(connection);
    const items: Taken[] = [];
    let capped = false;
    if ("k" in position) {
      const kept = await this.deps.store.recent(connection.id);
      /* Only a full 100 has more beyond it; fewer is the whole mailbox. */
      const full = kept.length >= KEPT_PER_MAILBOX;
      for (let index = position.k; index < kept.length && items.length < size; index++) {
        items.push({ message: kept[index]!, after: index + 1 < kept.length ? { k: index + 1 } : full ? { t: "", i: 0 } : null });
      }
      if (items.length < size && full) {
        const more = await this.take(connection, { t: "", i: 0 }, size - items.length, null);
        items.push(...more.items);
      }
      return { items };
    }
    const searching = "s" in position;
    const keptIds = searching ? new Set<string>() : new Set((await this.deps.store.recent(connection.id)).map((one) => one.id));
    let token = searching ? position.s : position.t;
    let start = position.i;
    for (let pages = 0; pages < 4 && items.length < size; pages++) {
      const page = searching && query ? await provider.search(query, token || undefined, PAGE) : await provider.list(token || undefined, PAGE);
      if (page.capped) capped = true;
      const messages = page.messages;
      for (let index = start; index < messages.length && items.length < size; index++) {
        const at: Position = index + 1 < messages.length ? (searching ? { s: token, i: index + 1 } : { t: token, i: index + 1 }) : page.next ? (searching ? { s: page.next, i: 0 } : { t: page.next, i: 0 }) : null;
        if (!keptIds.has(messages[index]!.id)) items.push({ message: messages[index]!, after: at });
        else if (items.length > 0) items[items.length - 1] = { ...items[items.length - 1]!, after: at };
      }
      if (!page.next || messages.length === 0) {
        if (items.length > 0) items[items.length - 1] = { ...items[items.length - 1]!, after: null };
        break;
      }
      token = page.next;
      start = 0;
    }
    return { items, ...(capped ? { capped } : {}) };
  }

  /**
   * One page of the area's mail, newest first, merged across the mailboxes
   * asked for. A query searches each provider's own index ("searched all mail").
   */
  async list(principal: Principal, input: { readonly area: CommsArea; readonly mailboxes?: readonly string[]; readonly cursor?: string; readonly q?: string; readonly size?: number }): Promise<MailPage> {
    const size = Math.min(Math.max(input.size ?? PAGE, 1), 100);
    const query = input.q ? parseMailQuery(input.q) : null;
    const searching = query !== null && !isEmptyMailQuery(query);
    const mailboxes = await this.selected(principal, input.area, input.mailboxes);
    const problems: { mailbox: string; message: string }[] = [];

    /* What is kept is shown at once; a mailbox not read lately is read first when nothing is kept, else in the background. */
    if (!searching && !input.cursor) {
      await Promise.all(
        mailboxes.map(async (connection) => {
          const mark = await this.deps.store.mark(connection.id);
          const stale = !mark.refreshedAt || this.deps.now() - Date.parse(mark.refreshedAt) > FRESH_MS;
          if (!stale) return;
          const kept = (await this.deps.store.recent(connection.id)).length;
          const run = this.refresh(connection.id);
          if (kept === 0) await run.catch((error: unknown) => problems.push({ mailbox: connection.id, message: error instanceof Error ? error.message : String(error) }));
          else void run.catch(() => undefined);
        }),
      );
    }

    const cursor: Cursor = decodeToken<Cursor>(input.cursor) ?? {};
    const capped: string[] = [];
    const streams = await Promise.all(
      mailboxes.map(async (connection) => {
        const start: Position = connection.id in cursor ? cursor[connection.id]! : searching ? { s: "", i: 0 } : { k: 0 };
        try {
          const taken = await this.take(connection, start, size, searching ? query : null);
          if (taken.capped) capped.push(connection.id);
          return { id: connection.id, start, items: taken.items };
        } catch (error) {
          problems.push({ mailbox: connection.id, message: error instanceof Error ? error.message : String(error) });
          return { id: connection.id, start, items: [] as Taken[] };
        }
      }),
    );
    const merged = streams
      .flatMap((stream) => stream.items.map((item) => ({ stream: stream.id, item })))
      .sort((a, b) => b.item.message.at.localeCompare(a.item.message.at) || a.stream.localeCompare(b.stream))
      .slice(0, size);
    const next: Cursor = {};
    for (const stream of streams) {
      const shown = merged.filter((one) => one.stream === stream.id);
      const failed = problems.some((one) => one.mailbox === stream.id);
      next[stream.id] = shown.length > 0 ? shown.at(-1)!.item.after : failed || stream.items.length > 0 ? stream.start : null;
    }
    const more = Object.values(next).some((one) => one !== null);
    return {
      messages: await this.decorate(merged.map((one) => one.item.message)),
      ...(more ? { cursor: encodeToken(next) } : {}),
      problems,
      ...(searching ? { searched: true } : {}),
      ...(capped.length > 0 ? { capped } : {}),
    };
  }

  /** What agents did with each message, its open draft, and which agent sent it. */
  private async decorate(messages: readonly MailMessage[]): Promise<MailPage["messages"]> {
    const byMailbox = new Map<string, MailMessage[]>();
    for (const one of messages) byMailbox.set(one.mailbox, [...(byMailbox.get(one.mailbox) ?? []), one]);
    const states = new Map<string, CommsState>();
    const drafts: MailDraft[] = [];
    for (const [mailbox, list] of byMailbox) {
      for (const state of await this.deps.store.states(mailbox, list.map((one) => one.id))) states.set(`${mailbox}\u0000${state.message}`, state);
      drafts.push(...(await this.deps.store.drafts({ mailbox })));
    }
    return messages.map((message) => {
      const state = states.get(`${message.mailbox}\u0000${message.id}`);
      const open = drafts.find((one) => one.status === "open" && one.mailbox === message.mailbox && one.replyTo === message.id);
      /* A sent message is the agent's when its draft went out on that thread within a few minutes of it. */
      const sentBy = message.sent
        ? drafts.find((one) => one.status === "sent" && one.agent && one.mailbox === message.mailbox && (one.sentId === message.id || (one.threadId === message.threadId && one.sentAt && Math.abs(Date.parse(one.sentAt) - Date.parse(message.at)) < 5 * 60_000)))
        : undefined;
      const agent = sentBy?.agent ?? state?.agent;
      return { ...message, ...(agent ? { agent } : {}), ...(state ? { status: state.status } : {}), ...(open ? { draft: open.id } : {}) };
    });
  }

  /** A conversation, read live, with the drafts waiting on it. */
  async thread(principal: Principal, mailbox: string, threadId: string): Promise<{ readonly messages: readonly MailThreadMessage[]; readonly drafts: readonly MailDraft[]; readonly mailbox: MailboxView }> {
    const connection = this.need(mailbox);
    if (!(await this.deps.policy.can(principal, "records.read", { connection: mailbox })).ok) throw new CommsError("You may not read this mailbox.", 403);
    const messages = await this.provider(connection).thread(threadId);
    const drafts = (await this.deps.store.drafts({ mailbox, threadId })).filter((one) => one.status === "open" || one.status === "failed");
    return { messages, drafts, mailbox: await this.view(connection) };
  }

  /* ── drafts and sending ───────────────────────────────────────────── */

  /** A reply's addresses and headers, from the message it answers. */
  private replyTo(connection: ConnectionSpec, message: MailMessage): MailOutgoing {
    const own = connection.mailbox?.address?.toLowerCase();
    const to = message.sent ? message.to : message.from ? [message.from] : [];
    const references = [message.references, message.messageId].filter(Boolean).join(" ").trim();
    return {
      to: formatAddresses(to.filter((one) => one.address !== own)),
      subject: replySubject(message.subject),
      text: "",
      threadId: message.threadId,
      ...(message.messageId ? { inReplyTo: message.messageId } : {}),
      ...(references ? { references } : {}),
    };
  }

  /** The message a draft answers, from what is kept or from its thread. */
  private async messageOf(connection: ConnectionSpec, id: string, threadId?: string): Promise<MailMessage | undefined> {
    const kept = (await this.deps.store.recent(connection.id)).find((one) => one.id === id);
    if (kept) return kept;
    if (!threadId) return undefined;
    return (await this.provider(connection).thread(threadId)).find((one) => one.id === id);
  }

  /**
   * A draft reply. Written by an agent (a workflow step, `agent` set) or
   * started by a person; either way nothing is sent until a person sends it.
   */
  async draft(input: { readonly mailbox: string; readonly replyTo: string; readonly threadId?: string; readonly text: string; readonly agent?: string; readonly workflow?: string; readonly task?: string }): Promise<MailDraft> {
    const connection = this.need(input.mailbox);
    const message = await this.messageOf(connection, input.replyTo, input.threadId);
    if (!message) throw new CommsError("That message could not be found.", 404);
    const reply = this.replyTo(connection, message);
    const now = this.iso();
    const draft: MailDraft = {
      id: `dr-${this.deps.newId()}`,
      mailbox: connection.id,
      replyTo: message.id,
      threadId: message.threadId,
      to: reply.to,
      cc: "",
      subject: reply.subject ?? "",
      text: input.text,
      ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(reply.references ? { references: reply.references } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.workflow ? { workflow: input.workflow } : {}),
      ...(input.task ? { task: input.task } : {}),
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.putDraft(draft);
    await this.deps.store.putState({ mailbox: connection.id, message: message.id, status: "drafted", ...(input.agent ? { agent: input.agent } : {}), updatedAt: now });
    return draft;
  }

  private async openDraft(principal: Principal, id: string): Promise<{ readonly draft: MailDraft; readonly connection: ConnectionSpec }> {
    const draft = await this.deps.store.draft(id);
    if (!draft) throw new CommsError("That draft is gone.", 404);
    if (draft.status !== "open" && draft.status !== "failed") throw new CommsError(`This draft was already ${draft.status}.`, 409, { draft });
    const connection = this.need(draft.mailbox);
    if (!(await this.deps.policy.can(principal, "records.act", { connection: connection.id })).ok) throw new CommsError("You may not send from this mailbox.", 403);
    return { draft, connection };
  }

  async editDraft(principal: Principal, id: string, edit: unknown): Promise<MailDraft> {
    const parsed = mailDraftEditSchema.safeParse(edit);
    if (!parsed.success) throw new CommsError("Those changes cannot be saved.");
    const { draft } = await this.openDraft(principal, id);
    const next: MailDraft = { ...draft, ...parsed.data, status: "open", updatedAt: this.iso() };
    delete (next as { error?: string }).error;
    await this.deps.store.putDraft(next);
    return next;
  }

  /**
   * Whether the agent a draft is from may send it from this mailbox: its own
   * always; a team mailbox only when its reach lets it act there; another
   * agent's never.
   */
  async agentMaySend(agentId: string, connection: ConnectionSpec): Promise<string | null> {
    const agent = await this.deps.agents.get(agentId);
    if (!agent || agent.archived) return "The agent that wrote it no longer exists.";
    const owner = connection.mailbox?.owner;
    if (owner?.kind === "agent") return owner.id === agent.id ? null : `${agent.name} cannot send from another agent's mailbox.`;
    return reachCovers(agent.reach, "records.act", { connection: connection.id })
      ? null
      : `${agent.name} sends from its own address. Let it send from ${connection.mailbox?.address ?? connection.title} on its page first.`;
  }

  /** The review for sending a draft (or saving it in the provider's drafts), prepared as this person. */
  async review(principal: Principal, id: string, how: { readonly save?: boolean } = {}): Promise<WriteReview> {
    const { draft, connection } = await this.openDraft(principal, id);
    if (!draft.to.trim()) throw new CommsError("Say who it goes to.");
    if (draft.agent && !how.save) {
      const refused = await this.agentMaySend(draft.agent, connection);
      if (refused) throw new CommsError(refused, 403);
    }
    const provider = this.provider(connection);
    const mail: MailOutgoing = {
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text: draft.text,
      ...(draft.threadId ? { threadId: draft.threadId } : {}),
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
      ...(draft.references ? { references: draft.references } : {}),
    };
    return this.deps.writes.prepare(principal, how.save ? provider.draftIntent(mail) : provider.sendIntent(mail), {
      via: draft.workflow ? "workflow" : "form",
      ...(draft.agent ? { onBehalfOf: { kind: "agent" as const, id: draft.agent } } : {}),
    });
  }

  /** Send (or save) the review this person approved, once. */
  async commit(principal: Principal, id: string, approval: { readonly pendingId: string; readonly digest: string; readonly save?: boolean }): Promise<MailDraft> {
    const { draft, connection } = await this.openDraft(principal, id);
    let result: CommitResult;
    try {
      result = await this.deps.writes.commit(principal, approval.pendingId, approval.digest);
    } catch (error) {
      const failed: MailDraft = { ...draft, status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 1000), updatedAt: this.iso() };
      await this.deps.store.putDraft(failed);
      throw error;
    }
    const now = this.iso();
    const sentId = approval.save ? undefined : this.provider(connection).sentId(result.record);
    const done: MailDraft = { ...draft, status: approval.save ? "saved" : "sent", sentAt: now, sentBy: principal.userId, ...(sentId ? { sentId } : {}), updatedAt: now };
    delete (done as { error?: string }).error;
    await this.deps.store.putDraft(done);
    if (!approval.save && draft.replyTo) await this.deps.store.putState({ mailbox: connection.id, message: draft.replyTo, status: "replied", ...(draft.agent ? { agent: draft.agent } : {}), updatedAt: now });
    /* What was sent shows in the list at the next read. */
    await this.deps.store.setMark(connection.id, { ...(await this.deps.store.mark(connection.id)), refreshedAt: undefined });
    await this.deps.draftSettled?.(done).catch((error: unknown) => this.deps.log?.warn(`a workflow waiting on draft ${id} was not woken: ${String(error)}`));
    return done;
  }

  async discard(principal: Principal, id: string): Promise<MailDraft> {
    const { draft } = await this.openDraft(principal, id);
    const gone: MailDraft = { ...draft, status: "discarded", updatedAt: this.iso() };
    await this.deps.store.putDraft(gone);
    await this.deps.draftSettled?.(gone).catch(() => undefined);
    return gone;
  }

  /** A person starts a reply of their own. */
  async startReply(principal: Principal, mailbox: string, message: string, threadId?: string): Promise<MailDraft> {
    if (!(await this.deps.policy.can(principal, "records.act", { connection: mailbox })).ok) throw new CommsError("You may not send from this mailbox.", 403);
    return this.draft({ mailbox, replyTo: message, ...(threadId ? { threadId } : {}), text: "" });
  }

  async drafts(principal: Principal, mailbox?: string): Promise<MailDraft[]> {
    const out: MailDraft[] = [];
    for (const one of await this.deps.store.drafts({ ...(mailbox ? { mailbox } : {}), status: "open" })) {
      if ((await this.deps.policy.can(principal, "records.read", { connection: one.mailbox })).ok) out.push(one);
    }
    return out;
  }

  settings(): Promise<CommsSettings> {
    return this.deps.store.settings();
  }

  async putSettings(settings: CommsSettings): Promise<CommsSettings> {
    await this.deps.store.putSettings(settings);
    return this.deps.store.settings();
  }
}
