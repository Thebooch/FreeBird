import type { FastifyInstance } from "fastify";

/**
 * Paths anyone may reach without signing in: the booking and approval
 * pages' APIs, and workflow webhooks. Each names its workspace in the path,
 * so a host serving many workspaces routes it without a principal:
 *
 * - `/api/public/<workspace>/…`
 * - `/p/<workspace>/…` (the pages themselves, where the server serves them)
 * - `/api/workflow-hooks/<workspace>/<token>` (and, on the open-source
 *   build's one workspace, the older `/api/workflow-hooks/<token>`)
 *
 * Nothing else is reachable this way: identity is skipped only for routes
 * under these prefixes registered with `config: { public: true }`, and a
 * test pins that set (`PUBLIC_ROUTES` in `routes/public.ts`).
 */
const PUBLIC_PREFIXES = ["/api/public/", "/p/", "/api/workflow-hooks/"] as const;

const pathOf = (url: string): string => url.split("?")[0] ?? url;

export const isPublicUrl = (url: string): boolean => {
  const path = pathOf(url);
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
};

/** The workspace a public path names, or null when it names none. */
export const publicWorkspaceOf = (url: string): string | null => {
  const path = pathOf(url);
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("/api/public/") || path.startsWith("/p/")) return (path.startsWith("/p/") ? parts[1] : parts[2]) ?? null;
  if (path.startsWith("/api/workflow-hooks/")) return parts.length >= 4 ? (parts[2] ?? null) : null;
  return null;
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
