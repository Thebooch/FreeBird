import { webcrypto } from "node:crypto";
import { roleSchema, type Principal, type Role } from "@freebirdai/dash-spec";
import type { MembershipStore } from "./membership.js";
import type { IdentityResolver } from "./resolver.js";

/**
 * Who a request is, from a token an identity provider signed (plan, track G).
 *
 * The identity plug-in point a hosted build uses: a bearer JWT, verified
 * against the issuer's published keys (OpenID Connect discovery, then its
 * JWKS), its issuer, audience and lifetime checked. The workspace and role
 * come from the membership store when there is one — the provider says who
 * somebody is, the workspace says what they may do — or else from claims the
 * provider is configured to issue. Anything that does not check out is
 * nobody, which the server answers with a 401. No password is ever handled.
 */

export interface OidcOptions {
  /** `https://login.example.com/` — its `/.well-known/openid-configuration` names the keys. */
  readonly issuer: string;
  /** The audience a token must be for: this service's client id. */
  readonly audience: string;
  /** The claim naming the workspace; `dash_workspace` unless said. */
  readonly workspaceClaim?: string;
  /** The claim naming the role, used only where there is no membership store. */
  readonly roleClaim?: string;
  readonly memberships?: MembershipStore;
  /** Reads the discovery document and the keys: public addresses only. */
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly now?: () => number;
  /** Seconds a clock may differ by. */
  readonly leewaySeconds?: number;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

const fromBase64Url = (text: string): Uint8Array => {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64"));
};

type KeyAlgorithm = { readonly name: string; readonly hash?: string; readonly namedCurve?: string };

const ALGORITHMS: Readonly<Record<string, { import: KeyAlgorithm; verify: KeyAlgorithm }>> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
};

/** How long the provider's keys are kept before they are read again; a token signed by a key not held reads them at once. */
const KEYS_KEPT_MS = 60 * 60 * 1000;

export const oidcJwtResolver = (options: OidcOptions): IdentityResolver & { verify(token: string): Promise<Json | null> } => {
  const now = options.now ?? Date.now;
  const leeway = (options.leewaySeconds ?? 60) * 1000;
  const issuer = options.issuer.replace(/\/+$/, "");
  let keys: { at: number; byId: Map<string, Json>; all: Json[] } | null = null;

  const readJson = async (url: string): Promise<unknown> => {
    const answer = await options.fetchDocument(url);
    if (answer.status < 200 || answer.status >= 300) throw new Error(`${url} answered ${answer.status}`);
    return JSON.parse(answer.text) as unknown;
  };

  const loadKeys = async (): Promise<NonNullable<typeof keys>> => {
    const discovery = await readJson(`${issuer}/.well-known/openid-configuration`);
    const jwksUri = isRecord(discovery) && typeof discovery.jwks_uri === "string" ? discovery.jwks_uri : null;
    /* The keys must be the issuer's own: a discovery document pointing elsewhere is not trusted. */
    if (!jwksUri || new URL(jwksUri).hostname !== new URL(issuer).hostname) throw new Error("the issuer's keys are not on its own host");
    const set = await readJson(jwksUri);
    const all = isRecord(set) && Array.isArray(set.keys) ? set.keys.filter(isRecord) : [];
    keys = { at: now(), byId: new Map(all.filter((key) => typeof key.kid === "string").map((key) => [key.kid as string, key])), all };
    return keys;
  };

  const keyFor = async (kid: string | undefined): Promise<Json | null> => {
    let held = keys && now() - keys.at < KEYS_KEPT_MS ? keys : await loadKeys();
    if (kid && !held.byId.has(kid) && now() - held.at > 60_000) held = await loadKeys();
    return kid ? (held.byId.get(kid) ?? null) : held.all.length === 1 ? held.all[0]! : null;
  };

  const verify = async (token: string): Promise<Json | null> => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: Json;
    let claims: Json;
    try {
      header = JSON.parse(Buffer.from(fromBase64Url(parts[0]!)).toString("utf8")) as Json;
      claims = JSON.parse(Buffer.from(fromBase64Url(parts[1]!)).toString("utf8")) as Json;
    } catch {
      return null;
    }
    /* Only signatures made with a key: never `none`, never a shared secret the server would have to hold. */
    const algorithm = typeof header.alg === "string" ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm) return null;
    const jwk = await keyFor(typeof header.kid === "string" ? header.kid : undefined);
    if (!jwk || (typeof jwk.alg === "string" && jwk.alg !== header.alg)) return null;
    try {
      const key = await webcrypto.subtle.importKey("jwk", jwk as webcrypto.JsonWebKey, algorithm.import as webcrypto.EcKeyImportParams, false, ["verify"]);
      const ok = await webcrypto.subtle.verify(
        algorithm.verify as webcrypto.EcdsaParams,
        key,
        fromBase64Url(parts[2]!),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
      if (!ok) return null;
    } catch {
      return null;
    }
    const at = now();
    const seconds = (value: unknown) => (typeof value === "number" ? value * 1000 : undefined);
    if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== issuer) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(options.audience)) return null;
    const expires = seconds(claims.exp);
    if (expires === undefined || expires + leeway < at) return null;
    const notBefore = seconds(claims.nbf);
    if (notBefore !== undefined && notBefore - leeway > at) return null;
    return claims;
  };

  return {
    verify,
    async resolve(request) {
      const header = request.headers.authorization;
      const value = Array.isArray(header) ? header[0] : header;
      const token = value && /^bearer\s+/i.test(value) ? value.replace(/^bearer\s+/i, "").trim() : null;
      if (!token) return null;
      const claims = await verify(token).catch(() => null);
      if (!claims || typeof claims.sub !== "string" || claims.sub === "") return null;
      const workspaceId = claims[options.workspaceClaim ?? "dash_workspace"];
      if (typeof workspaceId !== "string" || workspaceId === "") return null;
      let role: Role | null = null;
      if (options.memberships) {
        const member = await options.memberships.member(workspaceId, claims.sub);
        role = member?.role ?? null;
      } else {
        const claimed = roleSchema.safeParse(claims[options.roleClaim ?? "dash_role"]);
        role = claimed.success ? claimed.data : null;
      }
      if (!role) return null;
      const principal: Principal = { userId: claims.sub, workspaceId, role, kind: "member" };
      return principal;
    },
  };
};
