import { Kysely, PostgresDialect, sql, type Selectable } from "kysely";
import type { Pool } from "pg";
import pg from "pg";
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
  ScratchPutInput,
  ScratchRecord,
} from "@freebirdai/core";
import type {
  ChatSessionCreateInput,
  ChatSessionUpdateInput,
  ChatMessageCreateInput,
  CustomTabCreateInput,
  CustomTabUpdateInput,
} from "@freebirdai/core";
import { newId } from "@freebirdai/core";
import type { FreeBirdSchema } from "./schema.js";

export type { FreeBirdSchema } from "./schema.js";

/**
 * Derive the tenant scope for a request. Mirrors the server's default tenant
 * key (`orgId`, then `extra.tenantId`). Returns null for single-tenant
 * deployments, which leaves `tenant_id` NULL and every tenant filter skipped.
 */
const tenantIdOf = (auth: AuthContext): string | null => {
  if (auth.orgId) return auth.orgId;
  const t = auth.extra?.["tenantId"];
  return typeof t === "string" && t.length > 0 ? t : null;
};

export interface PostgresAdapterOptions {
  /** Pass an existing `pg.Pool` or a connection string. */
  pool?: Pool;
  connectionString?: string;
  /**
   * Bring your own Kysely instance instead of a Pool — any Postgres-dialect
   * Kysely works (e.g. PGlite in tests, or a host app's shared instance with
   * an extended schema). Takes precedence over `pool`/`connectionString`.
   */
  db?: Kysely<FreeBirdSchema>;
}

/**
 * Postgres adapter built on Kysely. Applies the schema in
 * `migrations/001_init.sql`. Host apps may bring their own Kysely instance
 * if they want to extend the schema — the adapter exports `FreeBirdSchema`
 * so you can intersect types.
 *
 * Distributed locks are implemented with an `INSERT ... ON CONFLICT` against
 * `freebird_lock` and an expires_at column, so they're safe across replicas.
 */
export class PostgresAdapter implements DbAdapter {
  readonly db: Kysely<FreeBirdSchema>;
  readonly locks: LockAdapter;

  constructor(opts: PostgresAdapterOptions) {
    if (opts.db) {
      this.db = opts.db;
    } else {
      const pool =
        opts.pool ??
        new pg.Pool({ connectionString: opts.connectionString ?? process.env.DATABASE_URL });
      this.db = new Kysely<FreeBirdSchema>({
        dialect: new PostgresDialect({ pool }),
      });
    }
    this.locks = {
      acquire: async (key, leaseMs) => this.acquireLock(key, leaseMs),
    };
  }

  private async acquireLock(key: string, leaseMs: number): Promise<LockHandle | null> {
    const expiresAt = new Date(Date.now() + leaseMs);
    const now = new Date();
    // Delete expired entries for the key, then try to insert fresh.
    await this.db
      .deleteFrom("freebird_lock")
      .where("key", "=", key)
      .where("expires_at", "<=", now)
      .execute();
    try {
      await this.db
        .insertInto("freebird_lock")
        .values({ key, expires_at: expiresAt })
        .execute();
    } catch {
      return null;
    }
    return {
      release: async () => {
        await this.db.deleteFrom("freebird_lock").where("key", "=", key).execute();
      },
    };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  async createSession(
    input: ChatSessionCreateInput,
    auth: AuthContext,
  ): Promise<ChatSession> {
    const id = input.id ?? newId("cs");
    const tenantId = tenantIdOf(auth);
    const row = await this.db
      .insertInto("freebird_chat_session")
      .values({
        id,
        title: input.title ?? null,
        topic: input.topic ?? null,
        tags: input.tags ?? [],
        user_id: auth.userId ?? null,
        tenant_id: tenantId,
        active_layout_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(row);
  }

  async updateSession(
    id: string,
    input: ChatSessionUpdateInput,
    auth: AuthContext,
  ): Promise<ChatSession> {
    const tenantId = tenantIdOf(auth);
    const row = await this.db
      .updateTable("freebird_chat_session")
      .set({
        title: input.title ?? undefined,
        topic: input.topic ?? undefined,
        tags: input.tags ?? undefined,
        active_layout_id: input.activeLayoutId ?? undefined,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(row);
  }

  async getSession(id: string, auth: AuthContext): Promise<ChatSession | null> {
    const tenantId = tenantIdOf(auth);
    const row = await this.db
      .selectFrom("freebird_chat_session")
      .selectAll()
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .executeTakeFirst();
    return row ? mapSession(row) : null;
  }

  async listSessionsByDate(range: DateRange, auth: AuthContext): Promise<ChatSession[]> {
    const tenantId = tenantIdOf(auth);
    const rows = await this.db
      .selectFrom("freebird_chat_session")
      .selectAll()
      .where("created_at", ">=", range.from)
      .where("created_at", "<=", range.to)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapSession);
  }

  async listSessionsByTopic(topic: string, auth: AuthContext): Promise<ChatSession[]> {
    const tenantId = tenantIdOf(auth);
    const rows = await this.db
      .selectFrom("freebird_chat_session")
      .selectAll()
      .where("topic", "=", topic)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .execute();
    return rows.map(mapSession);
  }

  async listSessionsByTag(tag: string, auth: AuthContext): Promise<ChatSession[]> {
    const tenantId = tenantIdOf(auth);
    const rows = await this.db
      .selectFrom("freebird_chat_session")
      .selectAll()
      .where(sql<boolean>`${sql.ref("tags")} @> ARRAY[${tag}]::text[]`)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .execute();
    return rows.map(mapSession);
  }

  async deleteSession(id: string, auth: AuthContext): Promise<void> {
    const tenantId = tenantIdOf(auth);
    await this.db
      .deleteFrom("freebird_chat_session")
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .execute();
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  async appendMessage(
    input: ChatMessageCreateInput,
    auth: AuthContext,
  ): Promise<ChatMessage> {
    // Authorization: ensure the session belongs to the caller.
    const session = await this.getSession(input.sessionId, auth);
    if (!session) throw new Error(`session "${input.sessionId}" not found`);
    const id = input.id ?? newId("cm");
    const row = await this.db
      .insertInto("freebird_chat_message")
      .values({
        id,
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        references_json: JSON.stringify(input.references ?? []) as any,
        tool_name: input.toolName ?? null,
        tool_payload:
          input.toolPayload === undefined ? null : (JSON.stringify(input.toolPayload) as any),
        tenant_id: tenantIdOf(auth),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.db
      .updateTable("freebird_chat_session")
      .set({ updated_at: new Date() })
      .where("id", "=", input.sessionId)
      .execute();
    return mapMessage(row);
  }

  async listMessages(sessionId: string, auth: AuthContext): Promise<ChatMessage[]> {
    const session = await this.getSession(sessionId, auth);
    if (!session) return [];
    const rows = await this.db
      .selectFrom("freebird_chat_message")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapMessage);
  }

  async listMessagesByTag(
    tag: string,
    opts: { limit: number; excludeSessionId?: string },
    auth: AuthContext,
  ): Promise<ChatMessage[]> {
    const tenantId = tenantIdOf(auth);
    const rows = await this.db
      .selectFrom("freebird_chat_message as m")
      .innerJoin("freebird_chat_session as s", "s.id", "m.session_id")
      .selectAll("m")
      .where(sql<boolean>`${sql.ref("s.tags")} @> ARRAY[${tag}]::text[]`)
      .$if(!!auth.userId, (qb) => qb.where("s.user_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("s.tenant_id", "=", tenantId!))
      .$if(!!opts.excludeSessionId, (qb) => qb.where("m.session_id", "!=", opts.excludeSessionId!))
      .orderBy("m.created_at", "desc")
      .limit(opts.limit)
      .execute();
    return rows.map((r) => mapMessage(r as any));
  }

  // -------------------------------------------------------------------------
  // Custom tabs
  // -------------------------------------------------------------------------
  async createTab(input: CustomTabCreateInput, auth: AuthContext): Promise<CustomTab> {
    const id = input.id ?? newId("tab");
    const row = await this.db
      .insertInto("freebird_custom_tab")
      .values({
        id,
        title: input.title,
        slug: input.slug ?? null,
        owner_id: auth.userId ?? null,
        tenant_id: tenantIdOf(auth),
        layout: JSON.stringify(input.layout) as any,
        digest:
          input.digest === undefined
            ? null
            : (JSON.stringify(input.digest) as any),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTab(row);
  }

  async updateTab(id: string, input: CustomTabUpdateInput, auth: AuthContext): Promise<CustomTab> {
    const tenantId = tenantIdOf(auth);
    const patch: Partial<Record<keyof FreeBirdSchema["freebird_custom_tab"], any>> = {
      updated_at: new Date(),
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.layout !== undefined) patch.layout = JSON.stringify(input.layout);
    if (input.digest !== undefined) {
      patch.digest = input.digest === null ? null : JSON.stringify(input.digest);
    }
    const row = await this.db
      .updateTable("freebird_custom_tab")
      .set(patch)
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("owner_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTab(row);
  }

  async getTab(id: string, auth: AuthContext): Promise<CustomTab | null> {
    const tenantId = tenantIdOf(auth);
    const row = await this.db
      .selectFrom("freebird_custom_tab")
      .selectAll()
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("owner_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .executeTakeFirst();
    return row ? mapTab(row) : null;
  }

  async listTabs(auth: AuthContext): Promise<CustomTab[]> {
    const tenantId = tenantIdOf(auth);
    const rows = await this.db
      .selectFrom("freebird_custom_tab")
      .selectAll()
      .$if(!!auth.userId, (qb) => qb.where("owner_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapTab);
  }

  async deleteTab(id: string, auth: AuthContext): Promise<void> {
    const tenantId = tenantIdOf(auth);
    await this.db
      .deleteFrom("freebird_custom_tab")
      .where("id", "=", id)
      .$if(!!auth.userId, (qb) => qb.where("owner_id", "=", auth.userId!))
      .$if(!!tenantId, (qb) => qb.where("tenant_id", "=", tenantId!))
      .execute();
  }

  async listDueDigests(now: Date): Promise<CustomTab[]> {
    // The scheduler runs as the system.
    const rows = await this.db
      .selectFrom("freebird_custom_tab")
      .selectAll()
      .where("digest", "is not", null)
      .where(
        sql<boolean>`((${sql.ref("digest")}->>'nextRunAt') IS NULL OR (${sql.ref(
          "digest",
        )}->>'nextRunAt')::timestamptz <= ${now})`,
      )
      .execute();
    return rows.map(mapTab);
  }

  // -------------------------------------------------------------------------
  // Scratch
  // -------------------------------------------------------------------------

  /**
   * Scratch is scoped by key, not by an optional filter.
   *
   * Every other table here narrows with `.$if(!!auth.userId, …)`, which drops
   * the condition entirely when the identity is blank. That is tolerable for
   * rows addressed by a generated id — you have to know the id to ask for it.
   * It is not tolerable here, because a host chooses (scope, namespace) and
   * two tenants will legitimately pick the same pair. So identity is folded
   * into the primary key, and a blank identity is a real partition of its own
   * rather than a wildcard.
   */
  private scratchKey(auth: AuthContext): { tenant_id: string; user_id: string } {
    return { tenant_id: tenantIdOf(auth) ?? "", user_id: auth.userId ?? "" };
  }

  async getScratch<T = unknown>(
    scope: string,
    namespace: string,
    auth: AuthContext,
  ): Promise<ScratchRecord<T> | null> {
    const key = this.scratchKey(auth);
    const row = await this.db
      .selectFrom("freebird_scratch")
      .selectAll()
      .where("tenant_id", "=", key.tenant_id)
      .where("user_id", "=", key.user_id)
      .where("scope", "=", scope)
      .where("namespace", "=", namespace)
      // An expired row is absent, not stale. Reading it and then deciding in
      // JavaScript would hand a caller data it had already been told to forget.
      .where((eb) =>
        eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`NOW()`)]),
      )
      .executeTakeFirst();
    return row ? (mapScratch(row) as ScratchRecord<T>) : null;
  }

  async putScratch(input: ScratchPutInput, auth: AuthContext): Promise<ScratchRecord> {
    const key = this.scratchKey(auth);
    const now = new Date();
    const row = await this.db
      .insertInto("freebird_scratch")
      .values({
        ...key,
        scope: input.scope,
        namespace: input.namespace,
        data: JSON.stringify(input.data) as never,
        expires_at: input.expiresAt ?? null,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "user_id", "scope", "namespace"]).doUpdateSet({
          data: JSON.stringify(input.data) as never,
          expires_at: input.expiresAt ?? null,
          updated_at: now,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapScratch(row);
  }

  async deleteScratch(scope: string, namespace: string, auth: AuthContext): Promise<void> {
    const key = this.scratchKey(auth);
    await this.db
      .deleteFrom("freebird_scratch")
      .where("tenant_id", "=", key.tenant_id)
      .where("user_id", "=", key.user_id)
      .where("scope", "=", scope)
      .where("namespace", "=", namespace)
      .execute();
  }

  async purgeExpiredScratch(now: Date): Promise<number> {
    // Housekeeping runs as the system, like `listDueDigests`. It reads no
    // data — it only drops rows whose own expiry has already passed.
    const result = await this.db
      .deleteFrom("freebird_scratch")
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", now)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}

export const createPostgresAdapter = (opts: PostgresAdapterOptions): PostgresAdapter =>
  new PostgresAdapter(opts);

// ---------------------------------------------------------------------------
// Row -> domain mappers
// ---------------------------------------------------------------------------

const mapSession = (row: Selectable<FreeBirdSchema["freebird_chat_session"]>): ChatSession => ({
  id: row.id,
  title: row.title ?? undefined,
  topic: row.topic ?? undefined,
  tags: row.tags,
  userId: row.user_id ?? undefined,
  activeLayoutId: row.active_layout_id ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapMessage = (row: Selectable<FreeBirdSchema["freebird_chat_message"]>): ChatMessage => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: row.content,
  references: (row.references_json as unknown as ChatMessage["references"]) ?? [],
  toolName: row.tool_name ?? undefined,
  toolPayload: row.tool_payload ?? undefined,
  createdAt: row.created_at,
});

const mapScratch = (row: Selectable<FreeBirdSchema["freebird_scratch"]>): ScratchRecord => ({
  scope: row.scope,
  namespace: row.namespace,
  data: row.data,
  expiresAt: row.expires_at,
  updatedAt: row.updated_at,
});

const mapTab = (row: Selectable<FreeBirdSchema["freebird_custom_tab"]>): CustomTab => ({
  id: row.id,
  title: row.title,
  slug: row.slug ?? undefined,
  ownerId: row.owner_id ?? undefined,
  layout: row.layout as unknown as CustomTab["layout"],
  digest: (row.digest as unknown as DigestConfig) ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
