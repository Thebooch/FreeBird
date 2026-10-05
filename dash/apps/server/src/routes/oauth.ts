import { randomBytes } from "node:crypto";
import type { ConnectionSpec } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type CredentialBroker, pkcePair, signInAddressAllowed } from "@freebirdai/connect/auth/broker";

/**
 * Signing in with a provider, for the APIs that need a person to say yes.
 *
 * - `POST /api/connections/:id/oauth/start` — where to send the person, and
 *   the address the provider sends them back to (which an app registered by
 *   hand must list as allowed).
 * - `GET  /api/oauth/callback` — where the provider sends them back. The code
 *   is exchanged for tokens with the PKCE verifier kept here, the connection
 *   moves to its new credentials, and its check starts by itself.
 *
 * The one click in connecting an API that nothing can take the place of:
 * the provider asking the account's owner whether to let this in.
 */

export interface OAuthRouteDeps {
  readonly getConnection: (id: string) => ConnectionSpec | null | undefined;
  readonly broker: CredentialBroker;
  /** The connection has new credentials: bump its revision, drop what it read, and check it. */
  readonly signedIn: (connection: ConnectionSpec) => void;
  readonly now?: () => number;
}

/** How long a sign-in may take before its state is forgotten. */
const PENDING_MS = 10 * 60_000;

interface Pending {
  readonly connection: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly at: number;
}

/** Where the provider sends the person back: this server, as the browser reaches it. */
const callbackFor = (request: FastifyRequest): string => {
  const origin = request.headers.origin;
  if (typeof origin === "string" && /^https?:\/\//.test(origin)) return `${origin}/api/oauth/callback`;
  return `${request.protocol}://${request.headers.host ?? "127.0.0.1"}/api/oauth/callback`;
};

const page = (title: string, detail: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.25rem">${title}</h1>` +
  `<p>${detail}</p><script>try{window.opener&&window.opener.postMessage({dashOAuth:true},"*")}catch(e){}</script></body></html>`;

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export const oauthRoutes =
  (deps: OAuthRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const pending = new Map<string, Pending>();
    const now = deps.now ?? Date.now;
    const sweep = () => {
      for (const [state, one] of pending) if (now() - one.at > PENDING_MS) pending.delete(state);
    };

    app.post<{ Params: { id: string } }>("/api/connections/:id/oauth/start", async (request, reply) => {
      const connection = deps.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      const auth = connection.auth;
      if (auth.type !== "oauth2" || auth.flow !== "authorization_code" || !auth.authorizeUrl)
        return reply.status(409).send({ error: `${connection.title} does not sign in through its provider's page.` });
      if (!signInAddressAllowed(connection, auth.authorizeUrl))
        return reply.status(409).send({
          error: `The sign-in address ${auth.authorizeUrl} is not on ${connection.title}'s own domain, so it is not used.`,
        });
      const clientId = (await deps.broker.resolve(auth.clientIdRef)) ?? null;
      if (!clientId) return reply.status(409).send({ error: `${connection.title} needs its app's client ID first.` });

      sweep();
      const state = randomBytes(18).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const redirectUri = callbackFor(request);
      pending.set(state, { connection: connection.id, verifier, redirectUri, at: now() });

      const url = new URL(auth.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (auth.scopes.length > 0) url.searchParams.set("scope", auth.scopes.join(" "));
      return { authorizeUrl: url.toString(), redirectUri };
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
      "/api/oauth/callback",
      async (request, reply) => {
        sweep();
        const { code, state, error } = request.query;
        const one = state ? pending.get(state) : undefined;
        if (state) pending.delete(state);
        reply.type("text/html");
        if (error)
          return page("Sign-in was not completed", escape(request.query.error_description ?? error));
        if (!one || !code) return page("This sign-in has expired", "Start signing in again from Dash.");
        const connection = deps.getConnection(one.connection);
        if (!connection) return page("That connection no longer exists", "Nothing was changed.");
        try {
          await deps.broker.exchangeCode(connection, { code, verifier: one.verifier, redirectUri: one.redirectUri });
        } catch (failure) {
          return page(
            "Sign-in did not finish",
            escape(failure instanceof Error ? failure.message : "The provider did not give a token."),
          );
        }
        deps.signedIn(connection);
        return page(
          `Signed in to ${escape(connection.title)}`,
          "You can close this tab. Dash is checking the connection now.",
        );
      },
    );
  };
