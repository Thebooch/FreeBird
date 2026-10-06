import type { CredentialMetaStore } from "../auth/credential-meta.js";
import type { ConnectorTokenStore, KeptToken } from "./host.js";

/**
 * A connector's session tokens, kept the way OAuth's are: the token in the
 * vault, and when it expires beside it in the credential meta store. Removed
 * with the connection like every other secret (`authTokenRefs`).
 */
export class VaultConnectorTokens implements ConnectorTokenStore {
  constructor(
    private readonly vault: {
      get(keyRef: string): string | null;
      set(keyRef: string, value: string): void;
      delete(keyRef: string): void;
    },
    private readonly meta: CredentialMetaStore,
    private readonly now: () => number = Date.now,
  ) {}

  async get(keyRef: string): Promise<KeptToken | null> {
    const value = this.vault.get(keyRef);
    if (!value) return null;
    const meta = await this.meta.get(keyRef);
    return { value, expiresAt: meta?.expiresAt ?? null, fields: meta?.fields ?? {} };
  }

  async put(keyRef: string, connection: string, token: KeptToken): Promise<void> {
    this.vault.set(keyRef, token.value);
    await this.meta.put({
      keyRef,
      connection,
      ...(token.expiresAt !== null ? { expiresAt: token.expiresAt } : {}),
      fields: token.fields,
      updatedAt: this.now(),
    });
  }

  async forget(keyRef: string): Promise<void> {
    this.vault.delete(keyRef);
    await this.meta.forget(keyRef);
  }
}
