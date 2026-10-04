import type { AuthSpec, CatalogEntry } from "@freebirdai/dash-spec";

/**
 * OpenID Connect, as the OAuth sign-in it is.
 *
 * A specification that declares `openIdConnect` names a discovery document
 * rather than the addresses themselves: the provider's
 * `.well-known/openid-configuration`, which says where a person signs in and
 * where the code is exchanged. Read, it is an authorization-code sign-in with
 * PKCE — the one the credential broker already runs — or, for a provider that
 * offers only an app's own sign-in, client credentials.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const httpsOnly = (value: unknown): string | undefined =>
  typeof value === "string" && /^https:\/\//i.test(value) ? value : undefined;

/** The first `openIdConnect` scheme the specification declares, with the scopes its requirement asks for. */
export const oidcSchemeOf = (
  spec: unknown,
  specUrl: string,
): { readonly name: string; readonly url: string; readonly scopes: readonly string[] } | null => {
  if (!isObject(spec)) return null;
  const components = isObject(spec.components) ? spec.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!isObject(scheme) || String(scheme.type).toLowerCase() !== "openidconnect") continue;
    const raw = typeof scheme.openIdConnectUrl === "string" ? scheme.openIdConnectUrl : null;
    if (!raw) continue;
    let url: string;
    try {
      url = new URL(raw, specUrl).toString();
    } catch {
      continue;
    }
    const requirements = Array.isArray(spec.security) ? spec.security : [];
    const asked = requirements
      .filter(isObject)
      .flatMap((entry) => (Array.isArray(entry[name]) ? (entry[name] as unknown[]) : []))
      .filter((scope): scope is string => typeof scope === "string");
    return { name, url, scopes: asked.length > 0 ? [...new Set(asked)] : ["openid"] };
  }
  return null;
};

/** The sign-in a discovery document describes, or null when it describes none Dash can run. */
export const oidcAuth = (discovery: unknown, scopes: readonly string[], keyRef: string): AuthSpec | null => {
  if (!isObject(discovery)) return null;
  const token = httpsOnly(discovery.token_endpoint);
  if (!token) return null;
  const refs = { clientIdRef: `${keyRef}-client`, clientSecretRef: `${keyRef}-secret`, keyRef: `${keyRef}-token` };
  const authorize = httpsOnly(discovery.authorization_endpoint);
  const grants = Array.isArray(discovery.grant_types_supported) ? discovery.grant_types_supported : ["authorization_code"];
  const offered = Array.isArray(discovery.scopes_supported) ? discovery.scopes_supported : null;
  /* Only scopes the provider offers, where it says which. */
  const wanted = offered ? scopes.filter((scope) => offered.includes(scope)) : [...scopes];
  if (authorize && grants.includes("authorization_code"))
    return {
      type: "oauth2",
      flow: "authorization_code",
      authorizeUrl: authorize,
      tokenUrl: token,
      scopes: wanted.length > 0 ? wanted : ["openid"],
      pkce: true,
      clientAuth: "body",
      ...refs,
      refreshRef: `${keyRef}-refresh`,
    } as AuthSpec;
  if (grants.includes("client_credentials"))
    return {
      type: "oauth2",
      flow: "client_credentials",
      tokenUrl: token,
      scopes: wanted.filter((scope) => scope !== "openid"),
      pkce: true,
      clientAuth: "body",
      ...refs,
    } as AuthSpec;
  return null;
};

/**
 * An entry whose specification signs in with OpenID Connect, signing in that
 * way: its discovery document read, and the entry's sign-in set from it. Null
 * when there is no such scheme, or its document could not be read or names no
 * sign-in Dash can run — the entry then says so, as it did.
 */
export const withOidc = async (
  entry: CatalogEntry,
  spec: unknown,
  specUrl: string,
  fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>,
): Promise<{ readonly entry: CatalogEntry; readonly note: string } | null> => {
  const scheme = oidcSchemeOf(spec, specUrl);
  if (!scheme) return null;
  /* A key somebody can paste still wins: OpenID Connect also needs an app registered with the provider. */
  const current = entry.dialect.auth;
  if (current && current.type !== "none" && current.type !== "bearer") return null;
  const answer = await fetchDocument(scheme.url).catch(() => null);
  if (!answer || answer.status < 200 || answer.status >= 300) return null;
  let discovery: unknown;
  try {
    discovery = JSON.parse(answer.text);
  } catch {
    return null;
  }
  const auth = oidcAuth(discovery, scheme.scopes, `${entry.id}-oidc`);
  if (!auth) return null;
  return {
    entry: { ...entry, dialect: { ...entry.dialect, auth }, authRequired: true },
    note: `It signs in with OpenID Connect; the provider's sign-in was read from ${scheme.url}.`,
  };
};
