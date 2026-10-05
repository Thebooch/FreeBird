import { scopedEvidence } from "@freebirdai/connect/evidence/store";
import type { RowCipher } from "@freebirdai/connect/jobs/store";
import type { EngineStores } from "@freebirdai/connect/platform/stores";
import { DbCredentialMetaStore } from "./credential-meta.js";
import type { ConnectDb } from "./db.js";
import { DbEvidenceStore } from "./evidence.js";
import { DbJobStore } from "./jobs.js";
import { DbWriteJournal } from "./journal.js";
import { DbLeaseLock } from "./lease.js";
import { DbShapeStore } from "./shapes.js";
import { DbSeenValueStore } from "./values.js";

/**
 * Every engine store over one database, for one workspace.
 *
 * `cipher` seals a running job's records and where it got to; pass the
 * vault. Rows of workspaces other than `local` carry their own key in every
 * table, so many workspaces can share one database.
 */
export const createDbStores = (
  db: ConnectDb,
  options: { readonly cipher: RowCipher; readonly workspace?: string },
): EngineStores => {
  const workspace = options.workspace;
  const evidence = new DbEvidenceStore(db);
  return {
    evidence: workspace ? scopedEvidence(evidence, workspace) : evidence,
    journal: new DbWriteJournal(db, workspace),
    credentialMeta: new DbCredentialMetaStore(db, workspace),
    seenValues: new DbSeenValueStore(db, workspace),
    shapes: new DbShapeStore(db, workspace),
    jobs: new DbJobStore(db, options.cipher, workspace),
    leases: new DbLeaseLock(db, workspace),
  };
};
