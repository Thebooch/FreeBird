import type { AuthContext } from "@freebirdai/core";
import { ROUTES, type FreeBirdRequest } from "./handlers.js";
import {
  createDepsResolver,
  type CreateFreeBirdRouterOptions,
  type DepsResolver,
} from "./index.js";
import { SSE_HEADERS, serializeSseEvent } from "./sse.js";

/**
 * Next.js App Router integration. Place the factory output inside
 * `app/freebird/[...route]/route.ts`:
 *
 *   import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
 *   const handlers = createFreeBirdRouteHandlers({ db, llm, email, registry });
 *   export const GET = handlers.GET;
 *   export const POST = handlers.POST;
 *   export const PATCH = handlers.PATCH;
 *   export const DELETE = handlers.DELETE;
 */
export const createFreeBirdRouteHandlers = (opts: CreateFreeBirdRouterOptions) => {
  const deps = createDepsResolver(opts);

  const match = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: URL,
  ): { spec: (typeof ROUTES)[number]; params: Record<string, string> } | null => {
    const rawPath = url.pathname;
    // Strip everything up to `/freebird` (inclusive) if present so we match on the subpath.
    const atFreebird = rawPath.lastIndexOf("/freebird");
    const path = atFreebird >= 0 ? rawPath.slice(atFreebird + "/freebird".length) || "/" : rawPath;
    for (const spec of ROUTES) {
      if (spec.method !== method) continue;
      const params = matchPath(spec.path, path);
      if (params) return { spec, params };
    }
    return null;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase() as "GET" | "POST" | "PATCH" | "DELETE";
    const matched = match(method, url);
    if (!matched) return new Response("Not Found", { status: 404 });

    const auth: AuthContext | null = opts.getAuthContext
      ? await opts.getAuthContext(request)
      : {};
    if (auth === null) return new Response("Unauthorized", { status: 401 });

    const body =
      method === "GET" || method === "DELETE"
        ? undefined
        : await request
            .json()
            .catch(() => undefined);

    const fbReq: FreeBirdRequest<any> = {
      body,
      params: matched.params,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(request.headers.entries()),
      auth,
      signal: request.signal,
    };

    try {
      const handlerDeps = await deps.resolve(auth);
      const result = matched.spec.handler(handlerDeps, fbReq);
      if (matched.spec.kind === "sse") {
        const stream = toReadableSseStream((result as any).events as AsyncIterable<unknown>);
        return new Response(stream, { status: 200, headers: SSE_HEADERS });
      }
      const awaited = await result;
      const status = (awaited as any).status;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify((awaited as any).body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  };

  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    DELETE: handle,
    /** Resolver handle for invalidating tenant registries. */
    freebird: deps as DepsResolver,
  };
};

const matchPath = (pattern: string, path: string): Record<string, string> | null => {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const v = pathParts[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(v);
    else if (p !== v) return null;
  }
  return params;
};

const toReadableSseStream = (events: AsyncIterable<unknown>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for await (const ev of events) {
          controller.enqueue(encoder.encode(serializeSseEvent(ev)));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
};
