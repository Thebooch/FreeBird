import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The secrets boundary, ported from FreeBird Studio's `vault.ts` (MIT, same
 * author).
 *
 * Connecting a dashboard to five APIs means holding five third-party
 * credentials — a honeypot. Keys are AES-256-GCM encrypted at rest and
 * decrypted only in memory, at the moment a request is built. Nothing
 * downstream (spec files, API responses, logs) ever sees plaintext, and the
 * public API only ever reports whether a key exists.
 *
 * Production swaps the master-key source for KMS behind this same interface;
 * the token format does not change.
 */
export interface SecretVault {
  encrypt(plaintext: string): string;
  decrypt(token: string): string;
  isEncrypted(value: string): boolean;
}

const PREFIX = "enc:v1:";

export class LocalAesVault implements SecretVault {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("LocalAesVault requires a 32-byte master key");
  }

  /** `DASH_MASTER_KEY` (64 hex chars) wins; otherwise a gitignored dev keyfile. */
  static fromEnvOrDevFile(devKeyPath: string): LocalAesVault {
    const envKey = process.env.DASH_MASTER_KEY;
    if (envKey) {
      if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
        throw new Error("DASH_MASTER_KEY must be 64 hex characters (32 bytes)");
      }
      return new LocalAesVault(Buffer.from(envKey, "hex"));
    }
    try {
      const existing = readFileSync(devKeyPath, "utf8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(existing)) {
        return new LocalAesVault(Buffer.from(existing, "hex"));
      }
    } catch {
      /* first boot */
    }
    const fresh = randomBytes(32);
    mkdirSync(dirname(devKeyPath), { recursive: true });
    writeFileSync(devKeyPath, fresh.toString("hex"), "utf8");
    return new LocalAesVault(fresh);
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  decrypt(token: string): string {
    if (!this.isEncrypted(token)) throw new Error("not a vault token");
    const parts = token.slice(PREFIX.length).split(":");
    if (parts.length !== 3) throw new Error("malformed vault token");
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    // GCM authenticates: tampered ciphertext throws rather than producing
    // garbage plaintext that would then be sent to a third party as a key.
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

/** Vault-file-backed key store: keyRef → encrypted secret. */
export class KeyStore {
  private secrets: Record<string, string> = {};

  constructor(
    private readonly vault: SecretVault,
    private readonly path: string,
  ) {
    try {
      this.secrets = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      this.secrets = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.secrets, null, 2), "utf8");
  }

  has(keyRef: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.secrets, keyRef);
  }

  set(keyRef: string, plaintext: string): void {
    this.secrets[keyRef] = this.vault.encrypt(plaintext);
    this.persist();
  }

  delete(keyRef: string): void {
    delete this.secrets[keyRef];
    this.persist();
  }

  /** In-memory only. Never logged, never returned over the API. */
  get(keyRef: string): string | null {
    const token = this.secrets[keyRef];
    if (!token) return null;
    try {
      return this.vault.decrypt(token);
    } catch {
      // A key encrypted under a different master key is unusable; say so
      // rather than sending garbage to a third party as a credential.
      return null;
    }
  }

  refs(): string[] {
    return Object.keys(this.secrets);
  }
}
