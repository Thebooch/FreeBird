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
  trigger_kind TEXT,
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

ALTER TABLE dash_workflow_runs ALTER COLUMN trigger_kind DROP NOT NULL;
CREATE INDEX IF NOT EXISTS dash_workflow_runs_finished ON dash_workflow_runs (workspace, finished_at);
CREATE INDEX IF NOT EXISTS dash_workflow_runs_workflow ON dash_workflow_runs (workspace, workflow, started_at);

CREATE TABLE IF NOT EXISTS dash_workflow_fired (
  workspace   TEXT NOT NULL,
  workflow    TEXT NOT NULL,
  row_key     TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  fired_at    TEXT,
  PRIMARY KEY (workspace, workflow, row_key)
);

ALTER TABLE dash_workflow_fired ADD COLUMN IF NOT EXISTS fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dash_workflow_fired ADD COLUMN IF NOT EXISTS last_at TEXT;
ALTER TABLE dash_workflow_fired ALTER COLUMN fired_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS dash_workflow_cases (
  workspace  TEXT NOT NULL,
  id         TEXT NOT NULL,
  workflow   TEXT NOT NULL,
  status     TEXT NOT NULL,
  wait_key   TEXT,
  wait_kind  TEXT,
  deadline   TEXT,
  started_at TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0,
  record     JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_workflow_cases_wait ON dash_workflow_cases (workspace, status, wait_key);
CREATE INDEX IF NOT EXISTS dash_workflow_cases_deadline ON dash_workflow_cases (workspace, status, deadline);

CREATE TABLE IF NOT EXISTS dash_tasks (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  workflow  TEXT,
  case_id   TEXT,
  status    TEXT NOT NULL,
  at        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_tasks_status ON dash_tasks (workspace, status, at);
CREATE INDEX IF NOT EXISTS dash_tasks_case ON dash_tasks (workspace, case_id);

CREATE TABLE IF NOT EXISTS dash_workflow_templates (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

DROP TABLE IF EXISTS dash_proposals;

CREATE TABLE IF NOT EXISTS dash_workflow_signals (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  key       TEXT NOT NULL,
  at        TEXT NOT NULL,
  payload   JSONB NOT NULL,
  taken_by  TEXT,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_workflow_signals_key ON dash_workflow_signals (workspace, key, taken_by, at);
ALTER TABLE dash_workflow_signals ADD COLUMN IF NOT EXISTS acked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dash_workflow_fired ADD COLUMN IF NOT EXISTS pending JSONB;

CREATE TABLE IF NOT EXISTS dash_calendar_events (
  workspace TEXT NOT NULL,
  id        TEXT NOT NULL,
  at        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE INDEX IF NOT EXISTS dash_calendar_events_at ON dash_calendar_events (workspace, at);
ALTER TABLE dash_calendar_events ADD COLUMN IF NOT EXISTS ends_at TEXT;
ALTER TABLE dash_calendar_events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS dash_calendar_events_dedupe ON dash_calendar_events (workspace, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS dash_scheduling (
  workspace TEXT NOT NULL,
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  record    JSONB NOT NULL,
  PRIMARY KEY (workspace, kind, id)
);

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
