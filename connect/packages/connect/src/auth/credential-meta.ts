import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * What is known about a token the broker obtained: whose it is and when it
 * stops working. Never the token itself — that lives in the vault.
 *
 * A plug-in point: memory in tests, Dash's database in the open-source build,
 * wherever a hosted build keeps it.
 */
export interface CredentialMeta {
  readonly keyRef: string;
  readonly connection: string;
  /** Epoch milliseconds, when the provider said. */
  readonly expiresAt?: number | undefined;
  readonly scopes?: readonly string[] | undefined;
  /** What a connector's login answered beside its token, that the code may see. Never secret. */
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly updatedAt: number;
}

export interface CredentialMetaStore {
  get(keyRef: string): Promise<CredentialMeta | null>;
  put(meta: CredentialMeta): Promise<void>;
  forget(keyRef: string): Promise<void>;
}

export class MemoryCredentialMetaStore implements CredentialMetaStore {
  private readonly rows = new Map<string, CredentialMeta>();
  async get(keyRef: string): Promise<CredentialMeta | null> {
    return this.rows.get(keyRef) ?? null;
  }
  async put(meta: CredentialMeta): Promise<void> {
    this.rows.set(meta.keyRef, meta);
  }
  async forget(keyRef: string): Promise<void> {
    this.rows.delete(keyRef);
  }
}

export class DbCredentialMetaStore implements CredentialMetaStore {
  constructor(
    private readonly db: DashDb,
    private readonly workspace = "local",
  ) {}

  async get(keyRef: string): Promise<CredentialMeta | null> {
    const result = await sql<{ meta: unknown }>`
      SELECT meta FROM dash_credential_meta WHERE workspace = ${this.workspace} AND key_ref = ${keyRef}
    `.execute(this.db.kysely);
    const row = result.rows[0];
    if (!row) return null;
    return (typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta) as CredentialMeta;
  }

  async put(meta: CredentialMeta): Promise<void> {
    await sql`
      INSERT INTO dash_credential_meta (workspace, key_ref, connection, meta)
      VALUES (${this.workspace}, ${meta.keyRef}, ${meta.connection}, ${JSON.stringify(meta)}::jsonb)
      ON CONFLICT (workspace, key_ref) DO UPDATE SET connection = EXCLUDED.connection, meta = EXCLUDED.meta
    `.execute(this.db.kysely);
  }

  async forget(keyRef: string): Promise<void> {
    await sql`
      DELETE FROM dash_credential_meta WHERE workspace = ${this.workspace} AND key_ref = ${keyRef}
    `.execute(this.db.kysely);
  }
}
