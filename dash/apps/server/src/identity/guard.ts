import type { Permission } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import type { Policy } from "./policy.js";

/**
 * Every route that changes stored state, and the permission it needs (the
 * list in `identity/README.md`).
 *
 * One table rather than a check inside each handler, so what is guarded can be
 * read in one place and a new route that changes something is one line here.
 * Reads are not in it: what a principal may read is a matter of which
 * workspace they are in, not of a permission. In the open-source build the
 * one principal owns everything, so nothing here ever refuses.
 */
export interface GuardRule {
  readonly methods: readonly string[];
  readonly path: RegExp;
  readonly permission: Permission;
}

const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

export const GUARDED_ROUTES: readonly GuardRule[] = [
  /* The first rule that matches decides, so the narrow ones come first. */
  /* Building a widget from a connection's records is board work, not connection work. */
  { methods: ["POST"], path: /^\/api\/connections\/[^/]+\/(compile|brief)$/, permission: "boards.edit" },
  /* Reading a sample, what may be changed, or the form for a change: reads. */
  { methods: ["POST"], path: /^\/api\/connections\/[^/]+\/(sample|capabilities)$/, permission: "records.read" },
  { methods: ["POST"], path: /^\/api\/connections\/[^/]+\/entities\/[^/]+\/writes\/form$/, permission: "records.read" },
  { methods: WRITE, path: /^\/api\/concierge(\/|$)/, permission: "boards.edit" },
  /* Boards: saving, removing, approving a widget, writing one from a brief. */
  { methods: WRITE, path: /^\/api\/dashboards(\/|$)/, permission: "boards.edit" },
  { methods: WRITE, path: /^\/api\/briefs?(\/|$)/, permission: "boards.edit" },
  /* Connections and what they are made from. The query routes read, and are not here. */
  { methods: WRITE, path: /^\/api\/connections(\/|$)/, permission: "connections.manage" },
  { methods: WRITE, path: /^\/api\/catalog(\/|$)/, permission: "connections.manage" },
  { methods: WRITE, path: /^\/api\/discover(\/|$)/, permission: "connections.manage" },
  { methods: WRITE, path: /^\/api\/onboarding(\/|$)/, permission: "connections.manage" },
  { methods: WRITE, path: /^\/api\/oauth(\/|$)/, permission: "connections.manage" },
  /* The parts a board is built from, and which models do what. */
  { methods: ["PUT", "DELETE"], path: /^\/api\/parts(\/|$)/, permission: "boards.edit" },
  { methods: ["PUT"], path: /^\/api\/models(\/|$)/, permission: "connections.manage" },
  { methods: ["PUT"], path: /^\/api\/settings(\/|$)/, permission: "connections.manage" },
];

/**
 * Routes that change things but carry their own, finer check: a change to a
 * connected account asks the policy for the record type it touches, on
 * prepare and again on commit (`WriteService`). Guarding them here as well
 * would refuse a member granted one record type on one connection.
 */
const OWN_CHECK = [/^\/api\/writes(\/|$)/, /^\/api\/connections\/[^/]+\/writes\/prepare$/];

export const permissionFor = (method: string, url: string): Permission | null => {
  const path = url.split("?")[0] ?? url;
  if (OWN_CHECK.some((pattern) => pattern.test(path))) return null;
  return GUARDED_ROUTES.find((rule) => rule.methods.includes(method.toUpperCase()) && rule.path.test(path))?.permission ?? null;
};

/** Ask the policy before any guarded route runs. After `installIdentity`, which gives every request its principal. */
export const installRouteGuard = (app: FastifyInstance, policy: Policy): void => {
  app.addHook("preHandler", async (request, reply) => {
    const permission = permissionFor(request.method, request.url);
    if (!permission) return undefined;
    const principal = request.principal;
    if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
    const decision = await policy.can(principal, permission, {});
    if (!decision.ok) return reply.status(403).send({ error: decision.reason, permission });
    return undefined;
  });
};

/**
 * Whether an address may be listened on. The open-source build has no sign-in:
 * whoever reaches it owns it, which is safe only while nobody else can reach
 * it. So it listens on this machine alone unless something checks who is
 * asking; `DASH_HOST=0.0.0.0` with no identity provider is refused, not warned about.
 */
export const bindAllowed = (host: string, signsIn: boolean): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host);
  if (loopback || signsIn) return { ok: true };
  return {
    ok: false,
    reason: `Refusing to listen on ${host}: this server has no sign-in, so anybody who could reach it would own everything on it. Listen on 127.0.0.1, or set DASH_OIDC_ISSUER and DASH_OIDC_AUDIENCE so every request is signed in.`,
  };
};
