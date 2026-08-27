import { mkdirSync } from "node:fs";
import { PostgresAdapter as FreeBirdPostgresAdapter } from "@freebirdai/adapters-db-postgres";
import type { DbAdapter } from "@freebirdai/core";
import { Kysely, sql } from "kysely";
/*
 * The dialect ships upstream now, on the adapter's own `./pglite` subpath.
 * It was vendored here first; keeping a second copy meant two definitions of
 * how PGlite is driven, and only one of them was ever exercised against the
 * adapter's own SQL.
 */
import { PGliteDialect } from "@freebirdai/adapters-db-postgres/pglite";

/**
 * Chat persistence.
 *
 * Chat is the one part of this product with genuinely relational, append-heavy
 * state — sessions, their messages, their ordering — and the rest of the repo's
 * "specs are files on disk" model is the wrong shape for it. So it gets a real
 * database, and the same one in every environment:
 *
 *   DATABASE_URL set    → that Postgres. What a hosted deployment runs.
 *   DATABASE_URL unset  → PGlite, an embedded Postgres under `.dash/chat-db/`.
 *
 * Both paths use `@freebirdai/adapters-db-postgres` over Kysely with identical
 * SQL, so local development exercises the production code path rather than a
 * stand-in that can quietly diverge from it.
 */

/**
 * The chat schema, from `@freebirdai/adapters-db-postgres/migrations`
 * (001_init + 002_tenant_id + 003_scratch), inlined.
 *
 * Inlined because `.sql` file resolution differs across tsx, vitest and a
 * built container, and a migration that cannot be found at run time is a
 * worse problem than a duplicated string. Every statement is `IF NOT EXISTS`,
 * so applying it repeatedly is a no-op.
 *
 * **If the OSS adapter ships a new migration, mirror it here.**
 */
export const CHAT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS freebird_chat_session (
  id               TEXT PRIMARY KEY,
  title            TEXT,
  topic            TEXT,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  user_id          TEXT,
  tenant_id        TEXT,
  active_layout_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_chat_session_user_idx
  ON freebird_chat_session (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS freebird_chat_session_tags_idx
  ON freebird_chat_session USING GIN (tags);
CREATE INDEX IF NOT EXISTS freebird_chat_session_tenant_idx
  ON freebird_chat_session (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS freebird_chat_message (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES freebird_chat_session(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         TEXT NOT NULL,
  references_json JSONB NOT NULL DEFAULT '[]',
  tool_name       TEXT,
  tool_payload    JSONB,
  tenant_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_chat_message_session_idx
  ON freebird_chat_message (session_id, created_at);
CREATE INDEX IF NOT EXISTS freebird_chat_message_tenant_idx
  ON freebird_chat_message (tenant_id);

CREATE TABLE IF NOT EXISTS freebird_custom_tab (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  slug        TEXT,
  owner_id    TEXT,
  tenant_id   TEXT,
  layout      JSONB NOT NULL,
  digest      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_custom_tab_owner_idx
  ON freebird_custom_tab (owner_id);
CREATE INDEX IF NOT EXISTS freebird_custom_tab_tenant_idx
  ON freebird_custom_tab (tenant_id);

CREATE TABLE IF NOT EXISTS freebird_lock (
  key        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

-- 003_scratch. Note the non-null identity columns: unlike the tables above,
-- scratch is addressed by a key the *host* chooses, which collides across
-- tenants by design. So identity is part of the primary key rather than a
-- filter that a blank auth context can drop.
CREATE TABLE IF NOT EXISTS freebird_scratch (
  tenant_id  TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL DEFAULT '',
  scope      TEXT NOT NULL,
  namespace  TEXT NOT NULL,
  data       JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, scope, namespace)
);

CREATE INDEX IF NOT EXISTS freebird_scratch_expiry_idx
  ON freebird_scratch (expires_at)
  WHERE expires_at IS NOT NULL;
`;

export interface ChatDb {
  readonly adapter: DbAdapter;
  /** Which backend answered, for the boot log and the health route. */
  readonly kind: "postgres" | "pglite";
  /**
   * The underlying query builder.
   *
   * Exposed for maintenance that is not part of the chat contract — a health
   * probe, a future migration step, clearing tables between tests — so those
   * do not each reach for a second connection to the same database.
   */
  readonly kysely: Kysely<never>;
  readonly close: () => Promise<void>;
}

/** Tables the chat schema owns, most dependent first. */
export const CHAT_TABLES = [
  "freebird_chat_message",
  "freebird_chat_session",
  "freebird_custom_tab",
  "freebird_lock",
  "freebird_scratch",
] as const;

/** Empty every chat table. Used by tests to reuse one expensive instance. */
export const truncateChat = async (db: ChatDb): Promise<void> => {
  await sql.raw(`TRUNCATE ${CHAT_TABLES.join(", ")} CASCADE`).execute(db.kysely);
};

export interface OpenChatDbOptions {
  /** Overrides `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string | undefined;
  /** Where the embedded database lives. Ignored when a URL is given. */
  readonly dataDir?: string;
  /**
   * Run the embedded database in memory.
   *
   * Tests want a database per case with nothing left on disk; `memory://` is
   * PGlite's own scheme for that.
   */
  readonly inMemory?: boolean;
}

/**
 * Open chat storage, applying the schema before returning.
 *
 * Migrating on open is safe because every statement is `IF NOT EXISTS`, and it
 * removes the failure mode where a fresh clone boots against an empty database
 * and every chat request 500s on a missing table.
 */
export const openChatDb = async (options: OpenChatDbOptions = {}): Promise<ChatDb> => {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;

  if (url) {
    /*
     * The adapter owns the pool. It already depends on `pg` and builds one
     * from a connection string, and it exposes the Kysely instance the
     * migration needs — so nothing here has to import `pg` itself.
     */
    const adapter = new FreeBirdPostgresAdapter({ connectionString: url });
    await sql.raw(CHAT_SCHEMA_SQL).execute(adapter.db);
    return {
      adapter,
      kind: "postgres",
      kysely: adapter.db as unknown as Kysely<never>,
      close: async () => {
        await adapter.db.destroy();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.inMemory ? "memory://" : (options.dataDir ?? ".dash/chat-db");
  if (!options.inMemory) mkdirSync(dataDir, { recursive: true });

  const client = new PGlite(dataDir);
  await client.waitReady;
  // PGlite runs the DDL directly: `exec` handles a multi-statement script,
  // which Kysely's single-statement path does not.
  await client.exec(CHAT_SCHEMA_SQL);

  const db = new Kysely<never>({ dialect: new PGliteDialect(client) });
  return {
    adapter: new FreeBirdPostgresAdapter({ db: db as never }),
    kind: "pglite",
    kysely: db,
    close: async () => {
      await db.destroy();
      await client.close();
    },
  };
};
