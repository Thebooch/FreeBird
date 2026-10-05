import { join } from "node:path";
import { type CredentialMetaStore, MemoryCredentialMetaStore } from "../auth/credential-meta.js";
import { type ConnectorSandbox, refusingSandbox } from "../connector/sandbox.js";
import { MemoryShapeStore, type ShapeStore } from "../drift/store.js";
import { type EvidenceStore, MemoryEvidenceStore } from "../evidence/store.js";
import { type JobStore, MemoryJobStore } from "../jobs/store.js";
import { RhythmStore } from "../rhythm-store.js";
import { MemorySeenValueStore, type SeenValueStore } from "../values/store.js";
import { KeyStore, LocalAesVault } from "../vault.js";
import { MemoryJournal, type WriteJournal } from "../writes/journal.js";
import { type LeaseLock, MemoryLeaseLock } from "./lease.js";

/**
 * The engine's relational state: everything appended and queried rather than
 * kept as a file. `@freebirdai/connect-postgres`'s `createDbStores` returns
 * the same shape over a database.
 */
export interface EngineStores {
  readonly evidence: EvidenceStore;
  readonly journal: WriteJournal;
  readonly credentialMeta: CredentialMetaStore;
  readonly seenValues: SeenValueStore;
  readonly shapes: ShapeStore;
  readonly jobs: JobStore;
  readonly leases: LeaseLock;
}

/** All of it in memory: right for tests and a single short-lived process. */
export const memoryStores = (): EngineStores => ({
  evidence: new MemoryEvidenceStore(),
  journal: new MemoryJournal(),
  credentialMeta: new MemoryCredentialMetaStore(),
  seenValues: new MemorySeenValueStore(),
  shapes: new MemoryShapeStore(),
  jobs: new MemoryJobStore(),
  leases: new MemoryLeaseLock(),
});

export interface LocalStores extends EngineStores {
  readonly vault: LocalAesVault;
  /** API keys and tokens, encrypted with `vault`, in a file under `dir`. */
  readonly keys: KeyStore;
  /** How often this account wants each endpoint asked again. */
  readonly rhythms: RhythmStore;
  /** Refuses generated connector code; pass `@freebirdai/connect-sandbox` to run it. */
  readonly sandbox: ConnectorSandbox;
}

/**
 * What the engine needs on one machine with nothing installed beside it: the
 * relational state in memory, and keys in a local encrypted file. The master
 * key comes from `DASH_MASTER_KEY`, or a key file under `dir` made on first use.
 */
export const createLocalStores = (options: { readonly dir: string }): LocalStores => {
  const vault = LocalAesVault.fromEnvOrDevFile(join(options.dir, "master-key"));
  return {
    ...memoryStores(),
    vault,
    keys: new KeyStore(vault, join(options.dir, "vault.json")),
    rhythms: new RhythmStore(join(options.dir, "rhythm")),
    sandbox: refusingSandbox,
  };
};
