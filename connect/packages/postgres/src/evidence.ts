import { sql } from "kysely";
import type { ConnectDb } from "./db.js";
import { evidenceSchema, type Evidence } from "@freebirdai/connect-spec";
import { EVIDENCE_PER_OP, type EvidenceStore } from "@freebirdai/connect/host";

export class DbEvidenceStore implements EvidenceStore {
  constructor(private readonly db: ConnectDb) {}

  async record(evidence: Evidence): Promise<void> {
    const parsed = evidenceSchema.parse(evidence);
    await sql`
      INSERT INTO connect_evidence (workspace, connection, op, level, config_version, at, record)
      VALUES (${parsed.workspace}, ${parsed.connection}, ${parsed.op}, ${parsed.level},
              ${parsed.configVersion}, ${parsed.at}, ${JSON.stringify(parsed)}::jsonb)
    `.execute(this.db.kysely);
    await sql`
      DELETE FROM connect_evidence
      WHERE workspace = ${parsed.workspace} AND connection = ${parsed.connection} AND op = ${parsed.op}
        AND id NOT IN (
          SELECT id FROM connect_evidence
          WHERE workspace = ${parsed.workspace} AND connection = ${parsed.connection} AND op = ${parsed.op}
          ORDER BY at DESC, id DESC
          LIMIT ${EVIDENCE_PER_OP}
        )
    `.execute(this.db.kysely);
  }

  async forConnection(connection: string, workspace = "local"): Promise<Evidence[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM connect_evidence
      WHERE workspace = ${workspace} AND connection = ${connection}
      ORDER BY at DESC, id DESC
    `.execute(this.db.kysely);
    return result.rows.flatMap((row) => {
      const record = typeof row.record === "string" ? JSON.parse(row.record) : row.record;
      const parsed = evidenceSchema.safeParse(record);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async forget(connection: string, workspace = "local"): Promise<void> {
    await sql`
      DELETE FROM connect_evidence WHERE workspace = ${workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
  }
}
