import type { RegistrationManifest } from "@freebirdai/manifest";
import type { EmbedConfig } from "./config.js";
import type { ComponentSnapshot } from "./snapshot.js";

const handshakeTokenKey = (siteId: string): string => `freebird:handshake-token:${siteId}`;

/**
 * Managed-backend endpoints (only used when `data-site-id` is present):
 *
 *   POST {api}/v1/sites/{siteId}/handshake   { url, manifest } → { token }
 *   POST {api}/v1/sites/{siteId}/snapshots   { url, snapshots }  (Bearer token)
 *
 * The handshake validates the page origin against the site's allowed-domains
 * list, upserts the scanned manifest, and returns a short-lived signed session
 * token used for chat + snapshot requests.
 *
 * Self-hosted mode (no siteId) skips all of this.
 */
export interface HandshakeResult {
  token: string;
  /** Backend may redirect chat to a different base (e.g. a regional host). */
  chatBaseUrl?: string;
}

export class EmbedBackend {
  private token: string | null = null;

  constructor(
    private readonly config: EmbedConfig,
    private readonly fetchImpl: typeof fetch = (...args) =>
      globalThis.fetch(...args),
  ) {
    if (this.enabled && this.config.siteId && typeof sessionStorage !== "undefined") {
      const cached = sessionStorage.getItem(handshakeTokenKey(this.config.siteId));
      if (cached) this.token = cached;
    }
  }

  get enabled(): boolean {
    return this.config.siteId !== undefined;
  }

  get sessionToken(): string | null {
    return this.token;
  }

  async handshake(manifest: RegistrationManifest): Promise<HandshakeResult | null> {
    if (!this.enabled) return null;
    if (this.token) {
      return { token: this.token };
    }
    const res = await this.fetchImpl(
      `${this.config.api}/v1/sites/${encodeURIComponent(this.config.siteId!)}/handshake`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: typeof location !== "undefined" ? location.href : undefined,
          manifest,
        }),
      },
    );
    if (!res.ok) {
      console.warn(`[freebird] handshake failed (${res.status}) — chat runs without a site session.`);
      return null;
    }
    const data = (await res.json()) as HandshakeResult;
    this.token = data.token;
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(handshakeTokenKey(this.config.siteId!), data.token);
    }
    return data;
  }

  async postSnapshots(snapshots: ComponentSnapshot[]): Promise<void> {
    if (!this.enabled || !this.config.snapshots || snapshots.length === 0) return;
    try {
      await this.fetchImpl(
        `${this.config.api}/v1/sites/${encodeURIComponent(this.config.siteId!)}/snapshots`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({
            url: typeof location !== "undefined" ? location.href : undefined,
            snapshots,
          }),
        },
      );
    } catch (err) {
      console.warn("[freebird] snapshot post failed:", err);
    }
  }
}
