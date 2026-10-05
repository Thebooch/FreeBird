import { evidenceSchema, type Evidence } from "@freebirdai/connect-spec";
import { sql } from "kysely";
import type { DashDb } from "../platform/db.js";

/**
 * Where evidence about reading an endpoint is kept.
 *
 * A plug-in point: the open-source build keeps it in the embedded database
 * (`DbEvidenceStore`), a test in memory, and a hosted build wherever it keeps
 * everything else. Append-only — a later observation never rewrites an
 * earlier one — and bounded per endpoint, since only recent evidence about a
 * configuration still in use says anything.
 */
export interface EvidenceStore {
  record(evidence: Evidence): Promise<void>;
  /** Everything kept for one connection, newest first. */
  forConnection(connection: string, workspace?: string): Promise<Evidence[]>;
  /** A connection was removed: its evidence goes with it. */
  forget(connection: string, workspace?: string): Promise<void>;
}

/** How many records are kept per endpoint. */
export const EVIDENCE_PER_OP = 20;

/**
 * One workspace's view of a store several share:
 * what it records is its own, whatever the record says, and it sees nothing
 * of any other workspace's.
 */
export const scopedEvidence = (store: EvidenceStore, workspace: string): EvidenceStore => ({
  record: (evidence) => store.record({ ...evidence, workspace }),
  forConnection: (connection) => store.forConnection(connection, workspace),
  forget: (connection) => store.forget(connection, workspace),
});

export class MemoryEvidenceStore implements EvidenceStore {
  private readonly rows: Evidence[] = [];

  async record(evidence: Evidence): Promise<void> {
    this.rows.unshift(evidenceSchema.parse(evidence));
    const same = this.rows.filter(
      (one) =>
        one.workspace === evidence.workspace &&
        one.connection === evidence.connection &&
        one.op === evidence.op,
    );
    for (const stale of same.slice(EVIDENCE_PER_OP)) this.rows.splice(this.rows.indexOf(stale), 1);
  }

  async forConnection(connection: string, workspace = "local"): Promise<Evidence[]> {
    return this.rows.filter((one) => one.connection === connection && one.workspace === workspace);
  }

  async forget(connection: string, workspace = "local"): Promise<void> {
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const one = this.rows[index]!;
      if (one.connection === connection && one.workspace === workspace) this.rows.splice(index, 1);
    }
  }
}

export class DbEvidenceStore implements EvidenceStore {
  constructor(private readonly db: DashDb) {}

  async record(evidence: Evidence): Promise<void> {
    const parsed = evidenceSchema.parse(evidence);
    await sql`
      INSERT INTO dash_evidence (workspace, connection, op, level, config_version, at, record)
      VALUES (${parsed.workspace}, ${parsed.connection}, ${parsed.op}, ${parsed.level},
              ${parsed.configVersion}, ${parsed.at}, ${JSON.stringify(parsed)}::jsonb)
    `.execute(this.db.kysely);
    await sql`
      DELETE FROM dash_evidence
      WHERE workspace = ${parsed.workspace} AND connection = ${parsed.connection} AND op = ${parsed.op}
        AND id NOT IN (
          SELECT id FROM dash_evidence
          WHERE workspace = ${parsed.workspace} AND connection = ${parsed.connection} AND op = ${parsed.op}
          ORDER BY at DESC, id DESC
          LIMIT ${EVIDENCE_PER_OP}
        )
    `.execute(this.db.kysely);
  }

  async forConnection(connection: string, workspace = "local"): Promise<Evidence[]> {
    const result = await sql<{ record: unknown }>`
      SELECT record FROM dash_evidence
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
      DELETE FROM dash_evidence WHERE workspace = ${workspace} AND connection = ${connection}
    `.execute(this.db.kysely);
  }
}
