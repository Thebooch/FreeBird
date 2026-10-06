
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
