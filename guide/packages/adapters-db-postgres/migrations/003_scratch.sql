-- FreeBird Postgres schema (v3): scratch storage.
-- A generic, namespaced blob a host app can park between requests, for the
-- multi-turn flows v1 deliberately kept in the browser. FreeBird stores it and
-- knows nothing about what is in it.
-- Apply with: psql -d <db> -f 003_scratch.sql

-- `tenant_id` and `user_id` are NOT NULL with an empty-string default here,
-- unlike the other tables, and that is the whole point.
--
-- Everywhere else, scoping is applied with `.$if(!!auth.userId, …)` — which
-- means a blank identity **drops the filter** and the query returns every
-- row. That is survivable for a table whose rows are addressed by an opaque
-- generated id, because a caller has to already know the id. Scratch is
-- addressed by (scope, namespace), which a host chooses and which will
-- collide across tenants by design — two tenants both keeping a "concierge"
-- draft for a board called "ops" is the ordinary case, not an edge one.
--
-- So the identity is part of the key rather than a filter that can be
-- skipped. An empty string is a real partition: a caller with no identity
-- can only ever see rows written with no identity.
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

-- Sweeping expired rows is the only query that is not by primary key.
CREATE INDEX IF NOT EXISTS freebird_scratch_expiry_idx
  ON freebird_scratch (expires_at)
  WHERE expires_at IS NOT NULL;
