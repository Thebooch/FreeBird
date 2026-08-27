import { newId } from "../id.js";
import type {
  AuthContext,
  ChatMessage,
  ChatSession,
  CustomTab,
} from "../types.js";
import type {
  ChatMessageCreateInput,
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  CustomTabCreateInput,
  CustomTabUpdateInput,
  DateRange,
  DbAdapter,
  LockAdapter,
} from "../adapters/db.js";

/**
 * Zero-dependency in-memory adapter used by tests and the default dev
 * experience. Data disappears on process exit.
 *
 * This intentionally does NOT enforce strict auth scoping; instead it
 * partitions by `userId` when present and ignores `orgId`. That's good
 * enough for tests and local dev — production adapters should scope strictly.
 */
const matchAuth = (owner: string | undefined, auth: AuthContext): boolean =>
  owner === undefined || owner === auth.userId;

export class MemoryDb implements DbAdapter {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly tabs = new Map<string, CustomTab>();
  private readonly heldLocks = new Map<string, number>();

  readonly locks: LockAdapter = {
    acquire: async (key, leaseMs) => {
      const now = Date.now();
      const expiry = this.heldLocks.get(key);
      if (expiry && expiry > now) return null;
      this.heldLocks.set(key, now + leaseMs);
      return {
        release: async () => {
          this.heldLocks.delete(key);
        },
      };
    },
  };

  async createSession(input: ChatSessionCreateInput, auth: AuthContext): Promise<ChatSession> {
    const now = new Date();
    const session: ChatSession = {
      id: input.id ?? newId("cs"),
      title: input.title,
      topic: input.topic,
      tags: input.tags ?? [],
      userId: auth.userId,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async updateSession(
    id: string,
    input: ChatSessionUpdateInput,
    auth: AuthContext,
  ): Promise<ChatSession> {
    const s = this.sessions.get(id);
    if (!s || !matchAuth(s.userId, auth)) throw new Error(`session "${id}" not found`);
    const updated: ChatSession = { ...s, ...input, updatedAt: new Date() };
    this.sessions.set(id, updated);
    return updated;
  }

  async getSession(id: string, auth: AuthContext): Promise<ChatSession | null> {
    const s = this.sessions.get(id);
    if (!s || !matchAuth(s.userId, auth)) return null;
    return s;
  }

  async listSessionsByDate(range: DateRange, auth: AuthContext): Promise<ChatSession[]> {
    return Array.from(this.sessions.values()).filter(
      (s) =>
        matchAuth(s.userId, auth) &&
        s.createdAt >= range.from &&
        s.createdAt <= range.to,
    );
  }

  async listSessionsByTopic(topic: string, auth: AuthContext): Promise<ChatSession[]> {
    return Array.from(this.sessions.values()).filter(
      (s) => matchAuth(s.userId, auth) && s.topic === topic,
    );
  }

  async listSessionsByTag(tag: string, auth: AuthContext): Promise<ChatSession[]> {
    return Array.from(this.sessions.values()).filter(
      (s) => matchAuth(s.userId, auth) && s.tags.includes(tag),
    );
  }

  async deleteSession(id: string, auth: AuthContext): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || !matchAuth(s.userId, auth)) return;
    this.sessions.delete(id);
    this.messages.delete(id);
  }

  async appendMessage(input: ChatMessageCreateInput, auth: AuthContext): Promise<ChatMessage> {
    const session = this.sessions.get(input.sessionId);
    if (!session || !matchAuth(session.userId, auth)) {
      throw new Error(`session "${input.sessionId}" not found`);
    }
    const msg: ChatMessage = {
      id: input.id ?? newId("cm"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      references: input.references ?? [],
      toolName: input.toolName,
      toolPayload: input.toolPayload,
      createdAt: new Date(),
    };
    const arr = this.messages.get(input.sessionId) ?? [];
    arr.push(msg);
    this.messages.set(input.sessionId, arr);
    session.updatedAt = new Date();
    return msg;
  }

  async listMessages(sessionId: string, auth: AuthContext): Promise<ChatMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session || !matchAuth(session.userId, auth)) return [];
    return (this.messages.get(sessionId) ?? []).slice();
  }

  async listMessagesByTag(
    tag: string,
    opts: { limit: number; excludeSessionId?: string },
    auth: AuthContext,
  ): Promise<ChatMessage[]> {
    const sessionIds = new Set(
      Array.from(this.sessions.values())
        .filter((s) => matchAuth(s.userId, auth) && s.tags.includes(tag))
        .map((s) => s.id),
    );
    const results: ChatMessage[] = [];
    for (const sid of sessionIds) {
      if (opts.excludeSessionId === sid) continue;
      const msgs = this.messages.get(sid) ?? [];
      results.push(...msgs);
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return results.slice(0, opts.limit);
  }

  async createTab(input: CustomTabCreateInput, auth: AuthContext): Promise<CustomTab> {
    const now = new Date();
    const tab: CustomTab = {
      id: input.id ?? newId("tab"),
      title: input.title,
      slug: input.slug,
      ownerId: auth.userId,
      layout: input.layout,
      digest: input.digest,
      createdAt: now,
      updatedAt: now,
    };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  async updateTab(id: string, input: CustomTabUpdateInput, auth: AuthContext): Promise<CustomTab> {
    const t = this.tabs.get(id);
    if (!t || !matchAuth(t.ownerId, auth)) throw new Error(`tab "${id}" not found`);
    const digest = input.digest === null ? undefined : input.digest ?? t.digest;
    const updated: CustomTab = {
      ...t,
      title: input.title ?? t.title,
      slug: input.slug ?? t.slug,
      layout: input.layout ?? t.layout,
      digest,
      updatedAt: new Date(),
    };
    this.tabs.set(id, updated);
    return updated;
  }

  async getTab(id: string, auth: AuthContext): Promise<CustomTab | null> {
    const t = this.tabs.get(id);
    if (!t || !matchAuth(t.ownerId, auth)) return null;
    return t;
  }

  async listTabs(auth: AuthContext): Promise<CustomTab[]> {
    return Array.from(this.tabs.values()).filter((t) => matchAuth(t.ownerId, auth));
  }

  async deleteTab(id: string, auth: AuthContext): Promise<void> {
    const t = this.tabs.get(id);
    if (!t || !matchAuth(t.ownerId, auth)) return;
    this.tabs.delete(id);
  }

  async listDueDigests(now: Date): Promise<CustomTab[]> {
    return Array.from(this.tabs.values()).filter(
      (t) => t.digest && (!t.digest.nextRunAt || t.digest.nextRunAt <= now),
    );
  }
}

export const createMemoryDb = (): MemoryDb => new MemoryDb();
