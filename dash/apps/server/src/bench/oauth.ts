import type { ConnectionSpec } from "@freebirdai/dash-spec";
import { CredentialBroker, pkcePair, vaultApps } from "../auth/broker.js";
import { MemoryCredentialMetaStore } from "../auth/credential-meta.js";
import type { IntegrationEnv } from "./types.js";

/**
 * Credentials for one benchmark scenario, the way the server holds them: a
 * vault seeded with what the person pasted, and a broker that turns an OAuth
 * app's values into live tokens.
 */
export const benchCredentials = (
  env: IntegrationEnv,
  secrets: Readonly<Record<string, string>> | Map<string, string>,
  current: () => ConnectionSpec,
): CredentialBroker => {
  /* A map is the scenario's own vault, kept by the caller so values pasted later reach it. */
  const vault = secrets instanceof Map ? secrets : new Map<string, string>(Object.entries(secrets));
  const store = {
    get: (ref: string) => vault.get(ref) ?? null,
    set: (ref: string, value: string) => void vault.set(ref, value),
    delete: (ref: string) => void vault.delete(ref),
  };
  return new CredentialBroker({
    vault: store,
    meta: new MemoryCredentialMetaStore(),
    apps: vaultApps(store),
    http: env.http,
    getConnection: (id) => (current().id === id ? current() : null),
    listConnections: () => [current()],
    now: () => env.now,
  });
};

/**
 * The person signing in with the provider: the one step nobody else can take.
 *
 * Their browser opens the provider's sign-in page, they say yes, and the
 * provider sends them back with a code — here the provider's page is asked
 * directly and its redirect read, which is exactly what the browser would
 * follow. Counted as consent: allowed, and reported.
 */
export const signInAsThePerson = async (
  connection: ConnectionSpec,
  broker: CredentialBroker,
  env: IntegrationEnv,
): Promise<{ ok: true } | { ok: false; why: string }> => {
  const auth = connection.auth;
  if (auth.type !== "oauth2" || auth.flow !== "authorization_code" || !auth.authorizeUrl)
    return { ok: false, why: "no sign-in page" };
  const clientId = await broker.resolve(auth.clientIdRef);
  if (!clientId) return { ok: false, why: "no client ID" };
  const { verifier, challenge } = pkcePair();
  const redirectUri = "http://127.0.0.1:4600/api/oauth/callback";
  const url = new URL(auth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", "bench");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scopes.length > 0) url.searchParams.set("scope", auth.scopes.join(" "));
  const page = await env.http(url.toString(), { headers: {} }, url.hostname);
  const location = page.header("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  if (!code) return { ok: false, why: `the provider did not sign in (${page.status})` };
  try {
    await broker.exchangeCode(connection, { code, verifier, redirectUri });
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
};
