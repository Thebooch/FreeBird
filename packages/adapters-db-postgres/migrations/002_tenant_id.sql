-- FreeBird Postgres schema (v2): multi-tenancy.
-- Adds a nullable tenant_id to the core tables so one database can back many
-- sites (FreeBird Studio's managed backend). Single-tenant deployments leave
-- it NULL and are unaffected.
-- Apply with: psql -d <db> -f 002_tenant_id.sql

ALTER TABLE freebird_chat_session ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE freebird_chat_message ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE freebird_custom_tab   ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE INDEX IF NOT EXISTS freebird_chat_session_tenant_idx
  ON freebird_chat_session (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS freebird_chat_message_tenant_idx
  ON freebird_chat_message (tenant_id);
CREATE INDEX IF NOT EXISTS freebird_custom_tab_tenant_idx
  ON freebird_custom_tab (tenant_id);

-- Managed deployments should additionally enable row-level security and add a
-- policy keyed on a session GUC (e.g. current_setting('freebird.tenant_id')).
-- That hardening lives in the deployment, not this baseline migration, so the
-- adapter stays usable without RLS configured.
