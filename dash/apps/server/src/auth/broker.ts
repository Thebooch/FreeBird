import { createHash, randomBytes } from "node:crypto";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import type { ConnectionSpec, OAuthSpec } from "@freebirdai/dash-spec";
import { sameSite } from "../integrate/patch.js";
import type { CredentialMetaStore } from "./credential-meta.js";

/**
 * The one place a credential is turned into what a request sends.
 *
 * For every static style — a key, a pair of headers, a username and password
 * — that is the vault's value, unchanged. For OAuth it is a token the broker
 * obtained: fetched with the app's own client id and secret, stored in the
 * vault, renewed a minute before it expires and again after a refusal, with
 * each refresh token used once when the provider rotates them. Nobody is asked
 * for a token, and nobody is asked to renew one; the one thing a person does
 * is sign in once, for a provider that needs that.
 *
 * Every adapter already asks for secrets through `resolveSecret`, so this is
 * where OAuth plugs in without any of them knowing it exists.
 */

export interface SecretVault {
  get(keyRef: string): string | null | Promise<string | null>;
  set(keyRef: string, value: string): void | Promise<void>;
  delete(keyRef: string): void | Promise<void>;
}

/**
 * Where an app's client id and secret come from.
 *
 * A plug-in point. The open-source build reads what the person pasted from
 * the vault; a hosted build that registered its own app with a provider
 * supplies that instead, and nobody has to register anything.
 */
export interface OAuthAppRegistry {
  client(
    connection: ConnectionSpec,
    auth: OAuthSpec,
  ): Promise<{ readonly clientId: string; readonly clientSecret?: string } | null>;
}

export const vaultApps = (vault: SecretVault): OAuthAppRegistry => ({
  async client(_connection, auth) {
    const clientId = await vault.get(auth.clientIdRef);
    if (!clientId) return null;
    const clientSecret = auth.clientSecretRef ? await vault.get(auth.clientSecretRef) : null;
    return { clientId, ...(clientSecret ? { clientSecret } : {}) };
  },
});

/** Identity providers that commonly sign in for an API on another domain. */
const KNOWN_PROVIDERS = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "login.microsoftonline.com",
  "github.com",
  "login.salesforce.com",
  "auth0.com",
  "okta.com",
];

/**
 * Whether the app's secret may be sent to this sign-in address.
 *
 * Only over https, and only to the API's own organisation — its address, or
 * its documentation's — or to a known identity provider. A specification
 * that named some other host as its token endpoint would otherwise collect
 * whatever client secret somebody pasted in.
 */
export const signInAddressAllowed = (connection: ConnectionSpec, url: string): boolean => {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  const own = [connection.baseUrl, connection.docsUrl].flatMap((one) => {
    try {
      return one ? [new URL(one).hostname] : [];
    } catch {
      return [];
    }
  });
  return (
    own.some((known) => sameSite(known, host)) ||
    KNOWN_PROVIDERS.some((provider) => host === provider || host.endsWith(`.${provider}`))
  );
};

/** PKCE: a verifier kept here, and the challenge sent to the provider. */
export const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

interface TokenAnswer {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresIn?: number | undefined;
  readonly scope?: string | undefined;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The provider withdrew the grant: nothing but signing in again will help. */
    readonly revoked = false,
  ) {
    super(message);
  }
}

const EARLY_MS = 60_000;

export interface BrokerDeps {
  readonly vault: SecretVault;
  readonly meta: CredentialMetaStore;
  readonly apps: OAuthAppRegistry;
  /** The guarded transport, pinned to the token endpoint's host. */
  readonly http: HttpFetch;
  readonly getConnection: (id: string) => ConnectionSpec | null | undefined;
  readonly listConnections: () => readonly ConnectionSpec[];
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

export class CredentialBroker {
  /** Token vault name → the connection it belongs to, learned as asked. */
  private owners = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: BrokerDeps) {}

  /** What a request sends for this vault name: a stored secret, or a live token. */
  resolve = async (keyRef: string): Promise<string | null> => {
    const connection = this.ownerOf(keyRef);
    if (!connection) return (await this.deps.vault.get(keyRef)) ?? null;
    return this.token(connection, false);
  };

  /** After a refusal: a new token if one can be had, without asking anybody. */
  refresh = async (connection: ConnectionSpec): Promise<boolean> =>
    connection.auth.type === "oauth2" && (await this.token(connection, true)) !== null;

  /** Whether this connection has a token, or can get one by itself. */
  async signedIn(connection: ConnectionSpec): Promise<boolean> {
    const auth = connection.auth;
    if (auth.type !== "oauth2") return true;
    if (auth.flow === "client_credentials") return true;
    return Boolean(await this.deps.vault.get(auth.keyRef)) || Boolean(auth.refreshRef && (await this.deps.vault.get(auth.refreshRef)));
  }

  /** Signing in with the provider, finished: the code it sent back, exchanged for tokens. */
  async exchangeCode(
    connection: ConnectionSpec,
    input: { code: string; verifier: string; redirectUri: string },
  ): Promise<void> {
    const auth = connection.auth;
    if (auth.type !== "oauth2") throw new OAuthError("This connection does not sign in with OAuth.");
    const answer = await this.request(connection, auth, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    });
    await this.keep(connection, auth, answer);
  }

  /** Forget a connection's tokens: it was removed, or its app changed. */
  async forget(connection: ConnectionSpec): Promise<void> {
    const auth = connection.auth;
    if (auth.type !== "oauth2") return;
    for (const ref of [auth.keyRef, ...(auth.refreshRef ? [auth.refreshRef] : [])]) {
      await this.deps.vault.delete(ref);
      await this.deps.meta.forget(ref);
    }
  }

  private ownerOf(keyRef: string): ConnectionSpec | null {
    const known = this.owners.get(keyRef);
    const cached = known ? this.deps.getConnection(known) : null;
    if (cached?.auth.type === "oauth2" && cached.auth.keyRef === keyRef) return cached;
    this.owners = new Map();
    for (const connection of this.deps.listConnections())
      if (connection.auth.type === "oauth2") this.owners.set(connection.auth.keyRef, connection.id);
    const id = this.owners.get(keyRef);
    return id ? (this.deps.getConnection(id) ?? null) : null;
  }

  /** One at a time per connection: two reads that both find a token stale share one refresh. */
  private token(connection: ConnectionSpec, force: boolean): Promise<string | null> {
    const running = this.inFlight.get(connection.id);
    if (running) return running;
    const started = this.obtain(connection, force).finally(() => this.inFlight.delete(connection.id));
    this.inFlight.set(connection.id, started);
    return started;
  }

  private async obtain(connection: ConnectionSpec, force: boolean): Promise<string | null> {
    const auth = connection.auth;
    if (auth.type !== "oauth2") return null;
    const current = await this.deps.vault.get(auth.keyRef);
    const meta = await this.deps.meta.get(auth.keyRef);
    const fresh = meta?.expiresAt === undefined || meta.expiresAt - this.deps.now() > EARLY_MS;
    if (current && fresh && !force) return current;

    try {
      if (auth.flow === "client_credentials") {
        const answer = await this.request(connection, auth, {
          grant_type: "client_credentials",
          ...(auth.scopes.length > 0 ? { scope: auth.scopes.join(" ") } : {}),
        });
        await this.keep(connection, auth, answer);
        return answer.accessToken;
      }
      const refresh = auth.refreshRef ? await this.deps.vault.get(auth.refreshRef) : null;
      if (!refresh) return force ? null : current;
      const answer = await this.request(connection, auth, { grant_type: "refresh_token", refresh_token: refresh });
      await this.keep(connection, auth, answer);
      return answer.accessToken;
    } catch (error) {
      this.deps.log?.(`${connection.id}: ${error instanceof Error ? error.message : String(error)}`);
      /* A withdrawn grant cannot be renewed: the tokens go, and the connection asks to sign in again. */
      if (error instanceof OAuthError && error.revoked) await this.forget(connection);
      return null;
    }
  }

  private async keep(connection: ConnectionSpec, auth: OAuthSpec, answer: TokenAnswer): Promise<void> {
    await this.deps.vault.set(auth.keyRef, answer.accessToken);
    /* A rotated refresh token replaces the old one, which the provider has already spent. */
    if (auth.refreshRef && answer.refreshToken) await this.deps.vault.set(auth.refreshRef, answer.refreshToken);
    await this.deps.meta.put({
      keyRef: auth.keyRef,
      connection: connection.id,
      ...(answer.expiresIn !== undefined ? { expiresAt: this.deps.now() + answer.expiresIn * 1000 } : {}),
      ...(answer.scope ? { scopes: answer.scope.split(/\s+/).filter(Boolean) } : {}),
      updatedAt: this.deps.now(),
    });
  }

  private async request(
    connection: ConnectionSpec,
    auth: OAuthSpec,
    grant: Readonly<Record<string, string>>,
  ): Promise<TokenAnswer> {
    if (!signInAddressAllowed(connection, auth.tokenUrl))
      throw new OAuthError(
        `The sign-in address ${auth.tokenUrl} is not on ${connection.title}'s own domain, so nothing was sent to it.`,
      );
    const client = await this.deps.apps.client(connection, auth);
    if (!client) throw new OAuthError(`${connection.title} needs its app's client ID before it can sign in.`);

    const form = new URLSearchParams(grant);
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (auth.clientAuth === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret ?? ""}`).toString("base64")}`;
    } else {
      form.set("client_id", client.clientId);
      if (client.clientSecret) form.set("client_secret", client.clientSecret);
    }
    const host = new URL(auth.tokenUrl).hostname;
    const response = await this.deps.http(
      auth.tokenUrl,
      { method: "POST", body: form.toString(), headers, purpose: "write" },
      host,
    );
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(response.text) as Record<string, unknown>;
    } catch {
      /* A provider answering in a form body is rare; said below if it happens. */
    }
    if (response.status >= 400 || typeof body.access_token !== "string") {
      const code = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new OAuthError(`${connection.title}'s sign-in refused: ${code}`, code === "invalid_grant");
    }
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number" ? { expiresIn: body.expires_in } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    };
  }
}
