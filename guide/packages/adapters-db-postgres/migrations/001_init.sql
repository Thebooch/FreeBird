-- FreeBird Postgres schema (v1)
-- Apply with: psql -d <db> -f 001_init.sql

CREATE TABLE IF NOT EXISTS freebird_chat_session (
  id               TEXT PRIMARY KEY,
  title            TEXT,
  topic            TEXT,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  user_id          TEXT,
  active_layout_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_chat_session_user_idx
  ON freebird_chat_session (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS freebird_chat_session_tags_idx
  ON freebird_chat_session USING GIN (tags);

CREATE TABLE IF NOT EXISTS freebird_chat_message (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES freebird_chat_session(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content       TEXT NOT NULL,
  references_json JSONB NOT NULL DEFAULT '[]',
  tool_name     TEXT,
  tool_payload  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_chat_message_session_idx
  ON freebird_chat_message (session_id, created_at);

CREATE TABLE IF NOT EXISTS freebird_custom_tab (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  slug        TEXT,
  owner_id    TEXT,
  layout      JSONB NOT NULL,
  digest      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS freebird_custom_tab_owner_idx
  ON freebird_custom_tab (owner_id);
CREATE INDEX IF NOT EXISTS freebird_custom_tab_digest_next_idx
  ON freebird_custom_tab ((digest->>'nextRunAt'))
  WHERE digest IS NOT NULL;

-- Distributed lock table used by the in-process scheduler and digest worker.
CREATE TABLE IF NOT EXISTS freebird_lock (
  key        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
