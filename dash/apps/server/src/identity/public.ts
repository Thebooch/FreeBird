import type { FastifyInstance } from "fastify";

/**
 * Paths anyone may reach without signing in: the booking and approval
 * pages' APIs, and a workflow webhook's call. Each names its workspace in the
 * path, so a host serving many workspaces routes it without a principal:
 *
 * - `/api/public/<workspace>/…`
 * - `/p/<workspace>/…` (the pages themselves, where the server serves them)
 * - `POST /api/workflow-hooks/<workspace>/<token>`, exactly that shape. The
 *   older `/api/workflow-hooks/<token>` names no workspace and is not public:
 *   it still wakes a case on a one-workspace server, where everyone is the
 *   owner, and through a host it needs sign-in like everything else.
 *
 * Nothing else is reachable this way: identity is skipped only for routes at
 * these addresses registered with `config: { public: true }`, and a test pins
 * that set (`PUBLIC_ROUTES` in `routes/public.ts`).
 */
const PUBLIC_PAGES = /^\/(?:api\/public|p)\/([^/]+)\//;
const HOOK_CALL = /^\/api\/workflow-hooks\/([^/]+)\/[^/]+$/;

const pathOf = (url: string): string => url.split(/[?#]/)[0] ?? url;

export const isPublicUrl = (url: string): boolean => {
  const path = pathOf(url);
  return PUBLIC_PAGES.test(path) || HOOK_CALL.test(path);
};

/** The workspace a public request names, or null when it is not one: a hook is a POST, or it is nothing. */
export const publicWorkspaceOf = (method: string, url: string): string | null => {
  const path = pathOf(url);
  const page = PUBLIC_PAGES.exec(path);
  if (page) return page[1] ?? null;
  if (method.toUpperCase() !== "POST") return null;
  return HOOK_CALL.exec(path)?.[1] ?? null;
};

declare module "fastify" {
  interface FastifyContextConfig {
    /** Reachable with nobody signed in: what it may do comes from a token in the path. */
    public?: boolean;
  }
}

const registered = new WeakMap<FastifyInstance, string[]>();

/** "GET /api/public/:workspace/book/:token", for every route marked public. */
export const publicRoutesOf = (app: FastifyInstance): readonly string[] => [...(registered.get(app) ?? [])].sort();

/**
 * What every public answer carries: no referrer leaves the page, nothing is
 * indexed or cached, and nothing may frame or sniff it. Registered on the
 * root, before any route, so every public route is seen and recorded.
 */
export const installPublicRoutes = (app: FastifyInstance): void => {
  const routes: string[] = [];
  registered.set(app, routes);
  app.addHook("onRoute", (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((method) => method !== "HEAD");
    const marked = (route.config as { public?: boolean } | undefined)?.public === true;
    for (const method of methods) {
      if (marked) routes.push(`${method} ${route.url}`);
      /* Under a public prefix without the mark: recorded as such, so the test sees it and the request is refused. */
      else if (isPublicUrl(route.url)) routes.push(`UNMARKED ${method} ${route.url}`);
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!isPublicUrl(request.url)) return payload;
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    return payload;
  });
};
