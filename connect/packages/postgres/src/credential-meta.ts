import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import type { CredentialMeta, CredentialMetaStore } from "@freebirdai/connect/host";

export class DbCredentialMetaStore implements CredentialMetaStore {
  constructor(
    private readonly db: ConnectDb,
    private readonly workspace = "local",
  ) {}

  async get(keyRef: string): Promise<CredentialMeta | null> {
    const result = await sql<{ meta: unknown }>`
      SELECT meta FROM connect_credential_meta WHERE workspace = ${this.workspace} AND key_ref = ${keyRef}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    if (!row) return null;
    return (typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta) as CredentialMeta;
  }

  async put(meta: CredentialMeta): Promise<void> {
    await sql`
      INSERT INTO connect_credential_meta (workspace, key_ref, connection, meta)
      VALUES (${this.workspace}, ${meta.keyRef}, ${meta.connection}, ${JSON.stringify(meta)}::jsonb)
      ON CONFLICT (workspace, key_ref) DO UPDATE SET connection = EXCLUDED.connection, meta = EXCLUDED.meta
    `.execute(this.db.kysely);
  }

  async forget(keyRef: string): Promise<void> {
    await sql`
      DELETE FROM connect_credential_meta WHERE workspace = ${this.workspace} AND key_ref = ${keyRef}
    `.execute(this.db.kysely);
  }
}
