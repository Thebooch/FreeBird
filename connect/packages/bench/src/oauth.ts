import type { ConnectionSpec } from "@freebirdai/connect-spec";
import { CredentialBroker, MemoryCredentialMetaStore, pkcePair, vaultApps } from "@freebirdai/connect/host";
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
  let location = page.header("location");
  /*
   * A consent page rather than a redirect: the person reads it and presses
   * Allow, which submits its form — here, the form is submitted as their
   * browser would. Never a login form: a password is theirs to type, and
   * nothing here types it.
   */
  if (!location && page.status === 200) {
    const form = consentForm(page.text, url.toString());
    if (form) {
      const answer = await env.http(
        form.action,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form.fields).toString(),
        },
        new URL(form.action).hostname,
      );
      location = answer.header("location");
    }
  }
  const code = location ? new URL(location, url).searchParams.get("code") : null;
  if (!code) return { ok: false, why: `the provider did not sign in (${page.status})` };
  try {
    await broker.exchangeCode(connection, { code, verifier, redirectUri });
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * A consent page's form: where it posts, its hidden fields, and the button
 * that allows. Null for a page with a password to type, or no allowing button.
 */
export const consentForm = (
  html: string,
  pageUrl: string,
): { readonly action: string; readonly fields: Record<string, string> } | null => {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attributes = match[1]!;
    const inner = match[2]!;
    if (!/method\s*=\s*["']?post/i.test(attributes)) continue;
    if (/type\s*=\s*["']?password/i.test(inner)) return null;
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? pageUrl;
    const fields: Record<string, string> = {};
    for (const input of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const name = /name\s*=\s*["']([^"']+)["']/i.exec(input[1]!)?.[1];
      const type = /type\s*=\s*["']([^"']+)["']/i.exec(input[1]!)?.[1]?.toLowerCase() ?? "text";
      const value = /value\s*=\s*["']([^"']*)["']/i.exec(input[1]!)?.[1] ?? "";
      if (name && (type === "hidden" || type === "text")) fields[name] = value;
    }
    /* The button that allows, and its value: not the one that denies. */
    const allow = [...inner.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*type\s*=\s*["']?submit[^>]*)>/gi)].find((button) =>
      /allow|approve|authori[sz]e|accept|grant|continue/i.test(`${button[1] ?? button[3] ?? ""} ${button[2] ?? ""}`),
    );
    if (!allow) continue;
    const attrs = allow[1] ?? allow[3] ?? "";
    const name = /name\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (name) fields[name] = /value\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    return { action: new URL(action, pageUrl).toString(), fields };
  }
  return null;
};
