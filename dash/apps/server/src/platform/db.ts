import { mkdirSync } from "node:fs";
import { PostgresAdapter as FreeBirdPostgresAdapter } from "@freebirdai/adapters-db-postgres";
import { PGliteDialect } from "@freebirdai/adapters-db-postgres/pglite";
import { Kysely, sql } from "kysely";

/**
 * Dash's own relational state: what is appended and queried rather than
 * edited as a document — evidence now, and the journal, snapshots and
 * memberships as they arrive.
 *
 * The same shape as chat storage (`chat/db.ts`), for the same reason:
 *
 *   DATABASE_URL set    → that Postgres. What a hosted deployment runs.
 *   DATABASE_URL unset  → PGlite, an embedded Postgres under `.dash/dash-db/`.
 *
 * A separate database from chat's, because PGlite allows one process per data
 * directory and the two open independently — losing one must not cost the
 * other. Every table carries a `workspace` column from the first row, so a
 * hosted build that keeps many workspaces in one database needs no migration.
 *
 * Every statement is `IF NOT EXISTS`, so applying the schema on every open is
 * a no-op after the first. **A new table goes here, never in a second file.**
 */
export const DASH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dash_evidence (
  id             BIGSERIAL PRIMARY KEY,
  workspace      TEXT NOT NULL,
  connection     TEXT NOT NULL,
  op             TEXT NOT NULL,
  level          TEXT NOT NULL,
  config_version TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL,
  record         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS dash_evidence_connection_idx
  ON dash_evidence (workspace, connection, op, at DESC);

CREATE TABLE IF NOT EXISTS dash_journal (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  connection TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  event      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS dash_journal_connection_idx
  ON dash_journal (workspace, connection, at DESC);

CREATE TABLE IF NOT EXISTS dash_credential_meta (
  workspace  TEXT NOT NULL,
  key_ref    TEXT NOT NULL,
  connection TEXT NOT NULL,
  meta       JSONB NOT NULL,
  PRIMARY KEY (workspace, key_ref)
);
`;

export interface DashDb {
  readonly kind: "postgres" | "pglite";
  readonly kysely: Kysely<never>;
  close(): Promise<void>;
}

export interface OpenDashDbOptions {
  /** Overrides `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string | undefined;
  /** Where the embedded database lives. Ignored when a URL is given. */
  readonly dataDir?: string;
  /** Run the embedded database in memory, for tests. */
  readonly inMemory?: boolean;
}

export const openDashDb = async (options: OpenDashDbOptions = {}): Promise<DashDb> => {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const adapter = new FreeBirdPostgresAdapter({ connectionString: url });
    await sql.raw(DASH_SCHEMA_SQL).execute(adapter.db);
    return {
      kind: "postgres",
      kysely: adapter.db as unknown as Kysely<never>,
      close: async () => {
        await adapter.db.destroy();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.inMemory ? "memory://" : (options.dataDir ?? ".dash/dash-db");
  if (!options.inMemory) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  await client.exec(DASH_SCHEMA_SQL);
  const db = new Kysely<never>({ dialect: new PGliteDialect(client) });
  return {
    kind: "pglite",
    kysely: db,
    close: async () => {
      await db.destroy();
      await client.close();
    },
  };
};
