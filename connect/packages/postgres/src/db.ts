import { mkdirSync } from "node:fs";
import { PostgresAdapter as FreeBirdPostgresAdapter } from "@freebirdai/adapters-db-postgres";
import { PGliteDialect } from "@freebirdai/adapters-db-postgres/pglite";
import { Kysely, sql } from "kysely";

/**
 * The engine's relational state: what is appended and queried rather than
 * edited as a document. Evidence, the write journal, credential expiry, seen
 * values, leases, accepted shapes and jobs.
 *
 *   DATABASE_URL set    → that Postgres.
 *   DATABASE_URL unset  → PGlite, an embedded Postgres in a local directory.
 *
 * Every table carries a `workspace` column from the first row, so a hosted
 * build that keeps many workspaces in one database needs no migration. Every
 * statement is `IF NOT EXISTS`, so applying the schema on every open is a
 * no-op after the first.
 */
export const CONNECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connect_evidence (
  id             BIGSERIAL PRIMARY KEY,
  workspace      TEXT NOT NULL,
  connection     TEXT NOT NULL,
  op             TEXT NOT NULL,
  level          TEXT NOT NULL,
  config_version TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL,
  record         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS connect_evidence_connection_idx
  ON connect_evidence (workspace, connection, op, at DESC);

CREATE TABLE IF NOT EXISTS connect_journal (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  connection TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  event      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS connect_journal_connection_idx
  ON connect_journal (workspace, connection, at DESC);

CREATE TABLE IF NOT EXISTS connect_credential_meta (
  workspace  TEXT NOT NULL,
  key_ref    TEXT NOT NULL,
  connection TEXT NOT NULL,
  meta       JSONB NOT NULL,
  PRIMARY KEY (workspace, key_ref)
);

CREATE TABLE IF NOT EXISTS connect_seen_values (
  workspace  TEXT NOT NULL,
  connection TEXT NOT NULL,
  op         TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  seen       JSONB NOT NULL,
  PRIMARY KEY (workspace, connection, op)
);

CREATE TABLE IF NOT EXISTS connect_leases (
  workspace TEXT NOT NULL,
  key       TEXT NOT NULL,
  holder    TEXT NOT NULL,
  until     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace, key)
);

CREATE TABLE IF NOT EXISTS connect_shapes (
  workspace  TEXT NOT NULL,
  connection TEXT NOT NULL,
  op         TEXT NOT NULL,
  accepted   JSONB NOT NULL,
  drift      JSONB,
  since      TIMESTAMPTZ,
  PRIMARY KEY (workspace, connection, op)
);

CREATE TABLE IF NOT EXISTS connect_jobs (
  workspace  TEXT NOT NULL,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  connection TEXT NOT NULL,
  op         TEXT,
  state      TEXT NOT NULL,
  priority   INTEGER NOT NULL,
  not_before TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  record     JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS connect_jobs_connection_idx
  ON connect_jobs (workspace, connection);

CREATE TABLE IF NOT EXISTS connect_job_rows (
  workspace TEXT NOT NULL,
  job       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  rows      TEXT NOT NULL,
  PRIMARY KEY (workspace, job, seq)
);
`;

export interface ConnectDb {
  readonly kind: "postgres" | "pglite";
  readonly kysely: Kysely<never>;
  close(): Promise<void>;
}

export interface OpenConnectDbOptions {
  /** Overrides `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string | undefined;
  /** Where the embedded database lives. Ignored when a URL is given. */
  readonly dataDir?: string;
  /** Run the embedded database in memory, for tests. */
  readonly inMemory?: boolean;
  /**
   * More schema to apply after the engine's, for a host keeping its own
   * tables in the same database. Must be idempotent, like the engine's.
   */
  readonly schema?: readonly string[];
}

export const openConnectDb = async (options: OpenConnectDbOptions = {}): Promise<ConnectDb> => {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  const schema = [CONNECT_SCHEMA_SQL, ...(options.schema ?? [])];
  if (url) {
    const adapter = new FreeBirdPostgresAdapter({ connectionString: url });
    for (const part of schema) await sql.raw(part).execute(adapter.db);
    return {
      kind: "postgres",
      kysely: adapter.db as unknown as Kysely<never>,
      close: async () => {
        await adapter.db.destroy();
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.inMemory ? "memory://" : (options.dataDir ?? ".connect/db");
  if (!options.inMemory) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  for (const part of schema) await client.exec(part);
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
