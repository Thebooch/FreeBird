import type {
  AuthContext,
  ChatMessage,
  ChatSession,
  CustomTab,
  DateRange,
  DbAdapter,
  DigestConfig,
  LockAdapter,
  LockHandle,
} from "@freebirdai/core";
import type {
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessageCreateInput,
  CustomTabCreateInput,
  CustomTabUpdateInput,
} from "@freebirdai/core";
import { newId } from "@freebirdai/core";

/**
 * Derive the tenant scope for a request. Mirrors the server's default tenant
 * key (`orgId`, then `extra.tenantId`). Returns null for single-tenant
 * deployments, which leaves `tenantId` NULL and every tenant filter skipped.
 */
const tenantIdOf = (auth: AuthContext): string | null => {
  if (auth.orgId) return auth.orgId;
  const t = auth.extra?.["tenantId"];
  return typeof t === "string" && t.length > 0 ? t : null;
};

/** Spread into a Prisma `where` to scope by tenant when one is present. */
const tenantWhere = (auth: AuthContext): { tenantId?: string } => {
  const tenantId = tenantIdOf(auth);
  return tenantId ? { tenantId } : {};
};

/**
 * Minimal structural type for the subset of the Prisma client we use.
 * Host apps pass their generated `PrismaClient` instance; it structurally
 * satisfies this interface as long as the four FreeBird models are present.
 */
export interface PrismaLike {
  freeBirdChatSession: {
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
    delete: (args: any) => Promise<any>;
  };
  freeBirdChatMessage: {
    create: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
  };
  freeBirdCustomTab: {
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
    delete: (args: any) => Promise<any>;
  };
  freeBirdLock: {
    deleteMany: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    delete: (args: any) => Promise<any>;
  };
}

export interface PrismaAdapterOptions {
  prisma: PrismaLike;
}

export class PrismaAdapter implements DbAdapter {
  readonly locks: LockAdapter;
  constructor(private readonly opts: PrismaAdapterOptions) {
    this.locks = {
      acquire: async (key, leaseMs) => this.acquireLock(key, leaseMs),
    };
  }

  private async acquireLock(key: string, leaseMs: number): Promise<LockHandle | null> {
    const now = new Date();
    await this.opts.prisma.freeBirdLock.deleteMany({
      where: { key, expiresAt: { lte: now } },
    });
    try {
      await this.opts.prisma.freeBirdLock.create({
        data: { key, expiresAt: new Date(Date.now() + leaseMs) },
      });
    } catch {
      return null;
    }
    return {
      release: async () => {
        await this.opts.prisma.freeBirdLock
          .delete({ where: { key } })
          .catch(() => {});
      },
    };
  }

  async createSession(input: ChatSessionCreateInput, auth: AuthContext): Promise<ChatSession> {
    const id = input.id ?? newId("cs");
    const row = await this.opts.prisma.freeBirdChatSession.create({
      data: {
        id,
        title: input.title ?? null,
        topic: input.topic ?? null,
        tags: input.tags ?? [],
        userId: auth.userId ?? null,
        tenantId: tenantIdOf(auth),
      },
    });
    return mapSession(row);
  }

  async updateSession(id: string, input: ChatSessionUpdateInput, auth: AuthContext): Promise<ChatSession> {
    const row = await this.opts.prisma.freeBirdChatSession.update({
      where: { id, ...(auth.userId ? { userId: auth.userId } : {}), ...tenantWhere(auth) },
      data: {
        title: input.title,
        topic: input.topic,
        tags: input.tags,
        activeLayoutId: input.activeLayoutId,
      },
    });
    return mapSession(row);
  }

  async getSession(id: string, auth: AuthContext): Promise<ChatSession | null> {
    const row = await this.opts.prisma.freeBirdChatSession.findUnique({ where: { id } });
    if (!row) return null;
    if (auth.userId && row.userId && row.userId !== auth.userId) return null;
    const tenantId = tenantIdOf(auth);
    if (tenantId && row.tenantId && row.tenantId !== tenantId) return null;
    return mapSession(row);
  }

  async listSessionsByDate(range: DateRange, auth: AuthContext): Promise<ChatSession[]> {
    const rows = await this.opts.prisma.freeBirdChatSession.findMany({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        ...(auth.userId ? { userId: auth.userId } : {}),
        ...tenantWhere(auth),
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapSession);
  }

  async listSessionsByTopic(topic: string, auth: AuthContext): Promise<ChatSession[]> {
    const rows = await this.opts.prisma.freeBirdChatSession.findMany({
      where: { topic, ...(auth.userId ? { userId: auth.userId } : {}), ...tenantWhere(auth) },
    });
    return rows.map(mapSession);
  }

  async listSessionsByTag(tag: string, auth: AuthContext): Promise<ChatSession[]> {
    const rows = await this.opts.prisma.freeBirdChatSession.findMany({
      where: { tags: { has: tag }, ...(auth.userId ? { userId: auth.userId } : {}), ...tenantWhere(auth) },
    });
    return rows.map(mapSession);
  }

  async deleteSession(id: string, auth: AuthContext): Promise<void> {
    await this.opts.prisma.freeBirdChatSession.delete({
      where: { id, ...(auth.userId ? { userId: auth.userId } : {}), ...tenantWhere(auth) },
    }).catch(() => {});
  }

  async appendMessage(input: ChatMessageCreateInput, auth: AuthContext): Promise<ChatMessage> {
    const session = await this.getSession(input.sessionId, auth);
    if (!session) throw new Error(`session "${input.sessionId}" not found`);
    const id = input.id ?? newId("cm");
    const row = await this.opts.prisma.freeBirdChatMessage.create({
      data: {
        id,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        referencesJson: input.references ?? [],
        toolName: input.toolName ?? null,
        toolPayload: input.toolPayload ?? null,
        tenantId: tenantIdOf(auth),
      },
    });
    return mapMessage(row);
  }

  async listMessages(sessionId: string, auth: AuthContext): Promise<ChatMessage[]> {
    const session = await this.getSession(sessionId, auth);
    if (!session) return [];
    const rows = await this.opts.prisma.freeBirdChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapMessage);
  }

  async listMessagesByTag(
    tag: string,
    opts: { limit: number; excludeSessionId?: string },
    auth: AuthContext,
  ): Promise<ChatMessage[]> {
    const rows = await this.opts.prisma.freeBirdChatMessage.findMany({
      where: {
        session: {
          tags: { has: tag },
          ...(auth.userId ? { userId: auth.userId } : {}),
          ...tenantWhere(auth),
        },
        ...(opts.excludeSessionId ? { sessionId: { not: opts.excludeSessionId } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts.limit,
    });
    return rows.map(mapMessage);
  }

  async createTab(input: CustomTabCreateInput, auth: AuthContext): Promise<CustomTab> {
    const id = input.id ?? newId("tab");
    const row = await this.opts.prisma.freeBirdCustomTab.create({
      data: {
        id,
        title: input.title,
        slug: input.slug ?? null,
        ownerId: auth.userId ?? null,
        tenantId: tenantIdOf(auth),
        layout: input.layout as any,
        digest: (input.digest ?? null) as any,
      },
    });
    return mapTab(row);
  }

  async updateTab(id: string, input: CustomTabUpdateInput, auth: AuthContext): Promise<CustomTab> {
    const row = await this.opts.prisma.freeBirdCustomTab.update({
      where: { id, ...(auth.userId ? { ownerId: auth.userId } : {}), ...tenantWhere(auth) },
      data: {
        title: input.title,
        slug: input.slug,
        layout: input.layout as any,
        digest: input.digest === undefined ? undefined : (input.digest as any),
      },
    });
    return mapTab(row);
  }

  async getTab(id: string, auth: AuthContext): Promise<CustomTab | null> {
    const row = await this.opts.prisma.freeBirdCustomTab.findUnique({ where: { id } });
    if (!row) return null;
    if (auth.userId && row.ownerId && row.ownerId !== auth.userId) return null;
    const tenantId = tenantIdOf(auth);
    if (tenantId && row.tenantId && row.tenantId !== tenantId) return null;
    return mapTab(row);
  }

  async listTabs(auth: AuthContext): Promise<CustomTab[]> {
    const rows = await this.opts.prisma.freeBirdCustomTab.findMany({
      where: { ...(auth.userId ? { ownerId: auth.userId } : {}), ...tenantWhere(auth) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapTab);
  }

  async deleteTab(id: string, auth: AuthContext): Promise<void> {
    await this.opts.prisma.freeBirdCustomTab
      .delete({ where: { id, ...(auth.userId ? { ownerId: auth.userId } : {}), ...tenantWhere(auth) } })
      .catch(() => {});
  }

  async listDueDigests(now: Date): Promise<CustomTab[]> {
    // Prisma can't filter on a JSON field's nested timestamp portably; filter
    // in-memory. Works fine for reasonable deployments; swap in @freebirdai/adapters-db-postgres
    // for a GIN-indexed alternative at scale.
    const rows = await this.opts.prisma.freeBirdCustomTab.findMany({
      where: { digest: { not: null as any } },
    });
    const due: CustomTab[] = [];
    for (const row of rows) {
      const mapped = mapTab(row);
      if (!mapped.digest?.nextRunAt || new Date(mapped.digest.nextRunAt) <= now) {
        due.push(mapped);
      }
    }
    return due;
  }
}

export const createPrismaAdapter = (opts: PrismaAdapterOptions): PrismaAdapter =>
  new PrismaAdapter(opts);

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const mapSession = (row: any): ChatSession => ({
  id: row.id,
  title: row.title ?? undefined,
  topic: row.topic ?? undefined,
  tags: row.tags ?? [],
  userId: row.userId ?? undefined,
  activeLayoutId: row.activeLayoutId ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapMessage = (row: any): ChatMessage => ({
  id: row.id,
  sessionId: row.sessionId,
  role: row.role,
  content: row.content,
  references: (row.referencesJson as ChatMessage["references"]) ?? [],
  toolName: row.toolName ?? undefined,
  toolPayload: row.toolPayload ?? undefined,
  createdAt: row.createdAt,
});

const mapTab = (row: any): CustomTab => ({
  id: row.id,
  title: row.title,
  slug: row.slug ?? undefined,
  ownerId: row.ownerId ?? undefined,
  layout: row.layout,
  digest: (row.digest as DigestConfig) ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
