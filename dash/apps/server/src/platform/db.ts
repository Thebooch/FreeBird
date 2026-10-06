import { openConnectDb, type ConnectDb, type OpenConnectDbOptions } from "@freebirdai/connect-postgres";

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
 * a no-op after the first. The engine's own tables (evidence, journal, jobs,
 * shapes and the rest) are `@freebirdai/connect-postgres`'s; Dash's go here,
 * in the same database. **A new Dash table goes here, never in a second file.**
 */
export const DASH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dash_snapshots (
  workspace  TEXT NOT NULL,
  dashboard  TEXT NOT NULL,
  widget     TEXT NOT NULL,
  day        TEXT NOT NULL,
  value      DOUBLE PRECISION NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace, dashboard, widget, day)
);

CREATE TABLE IF NOT EXISTS dash_workspaces (
  id     TEXT PRIMARY KEY,
  record JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dash_members (
  workspace TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, user_id)
);

CREATE TABLE IF NOT EXISTS dash_agents (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE IF NOT EXISTS dash_agent_shared (
  workspace TEXT PRIMARY KEY,
  record    JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dash_workflows (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE IF NOT EXISTS dash_workflow_runs (
  workspace    TEXT NOT NULL,
  id           TEXT NOT NULL,
  workflow     TEXT NOT NULL,
  agent        TEXT,
  trigger_kind TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  matched      INTEGER NOT NULL DEFAULT 0,
  summary      TEXT NOT NULL DEFAULT '',
  outputs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  record       JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_workflow_runs_finished ON dash_workflow_runs (workspace, finished_at);
CREATE INDEX IF NOT EXISTS dash_workflow_runs_workflow ON dash_workflow_runs (workspace, workflow, started_at);

CREATE TABLE IF NOT EXISTS dash_workflow_fired (
  workspace   TEXT NOT NULL,
  workflow    TEXT NOT NULL,
  row_key     TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  fired_at    TEXT NOT NULL,
  PRIMARY KEY (workspace, workflow, row_key)
);

CREATE TABLE IF NOT EXISTS dash_proposals (
  workspace    TEXT NOT NULL,
  id           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  agent        TEXT,
  workflow     TEXT,
  run          TEXT,
  conversation TEXT,
  intent       JSONB NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  journal_id   TEXT,
  record       JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_proposals_status ON dash_proposals (workspace, status, created_at);

CREATE TABLE IF NOT EXISTS dash_calendar_events (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  at        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_calendar_events_at ON dash_calendar_events (workspace, at);

CREATE TABLE IF NOT EXISTS dash_invites (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  record     JSONB NOT NULL
);
`;

export type DashDb = ConnectDb;
export type OpenDashDbOptions = Omit<OpenConnectDbOptions, "schema">;

export const openDashDb = (options: OpenDashDbOptions = {}): Promise<DashDb> =>
  openConnectDb({ dataDir: ".dash/dash-db", ...options, schema: [DASH_SCHEMA_SQL] });
