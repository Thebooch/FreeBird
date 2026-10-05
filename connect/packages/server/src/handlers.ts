import type { Connect, ReadRequest } from "@freebirdai/connect";
import type { WriteActor } from "@freebirdai/connect/writes/policy";
import type { WriteIntent } from "@freebirdai/connect/writes/pending";

/**
 * The engine's HTTP surface, framework-free.
 *
 * Every route is a method, a path with `:params`, and a handler from a
 * request to a JSON answer. `fastify.ts`, `express.ts` and `next.ts` mount
 * the same list, so the three behave alike and a route added here appears
 * in all of them.
 */
export interface ConnectRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Who is asking, for a change. Absent means the owner, as in a script. */
  readonly actor?: WriteActor | undefined;
}

export interface ConnectResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ConnectRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly handler: (connect: Connect, request: ConnectRequest) => Promise<ConnectResponse>;
}

const ok = (body: unknown): ConnectResponse => ({ status: 200, body });
const bad = (status: number, error: string): ConnectResponse => ({ status, body: { error } });
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A connection as the outside sees it: never a key, never a secret. */
const publicConnection = (connect: Connect, id: string) => {
  const connection = connect.connections.get(id);
  if (!connection) return null;
  return {
    id: connection.id,
    title: connection.title,
    kind: connection.kind,
    baseUrl: connection.baseUrl,
    catalog: connection.catalog,
    ops: connection.ops.map((op) => ({ id: op.id, title: op.title, path: op.path })),
    ...connect.connections.status(id),
  };
};

/** An error the engine threw, said to the caller in its own words. */
const failure = (error: unknown): ConnectResponse => {
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
  const message =
    error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string"
      ? error.userMessage
      : error instanceof Error
        ? error.message
        : String(error);
  return bad(status >= 400 && status < 600 ? status : 502, message);
};

const guarded =
  (handler: ConnectRoute["handler"]): ConnectRoute["handler"] =>
  async (connect, request) => {
    try {
      return await handler(connect, request);
    } catch (error) {
      return failure(error);
    }
  };

export const CONNECT_ROUTES: readonly ConnectRoute[] = [
  {
    method: "GET",
    path: "/connections",
    handler: guarded(async (connect) =>
      ok(connect.connections.list().map((connection) => publicConnection(connect, connection.id))),
    ),
  },
  {
    method: "POST",
    path: "/connections",
    handler: guarded(async (connect, request) => {
      const body = record(request.body);
      if (typeof body.from !== "string" || !body.from.trim()) return bad(400, "Say where the API is: { from: <url or name> }.");
      const added = await connect.connections.add({
        from: body.from,
        ...(typeof body.id === "string" ? { id: body.id } : {}),
      });
      return { status: 201, body: { ...publicConnection(connect, added.id), note: added.discovery.note } };
    }),
  },
  {
    method: "GET",
    path: "/connections/:id",
    handler: guarded(async (connect, request) => {
      const found = publicConnection(connect, request.params.id!);
      return found ? ok(found) : bad(404, `There is no connection "${request.params.id}".`);
    }),
  },
  {
    method: "DELETE",
    path: "/connections/:id",
    handler: guarded(async (connect, request) => {
      connect.connections.remove(request.params.id!);
      return ok({ ok: true });
    }),
  },
  {
    method: "PUT",
    path: "/connections/:id/key",
    handler: guarded(async (connect, request) => {
      const body = record(request.body);
      const key =
        typeof body.key === "string"
          ? body.key
          : body.keys && typeof body.keys === "object"
            ? (Object.fromEntries(
                Object.entries(body.keys as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
              ) as Record<string, string>)
            : null;
      if (!key) return bad(400, "Send { key } or, for several values, { keys: { … } }.");
      await connect.connections.setKey(request.params.id!, key);
      /* Only the fact that it worked; never the key, not even truncated. */
      return ok({ ok: true });
    }),
  },
  {
    method: "POST",
    path: "/connections/:id/integrate",
    handler: guarded(async (connect, request) => {
      const run = await connect.integrate(request.params.id!);
      return "error" in run ? bad(run.status, run.error) : ok(run);
    }),
  },
  {
    method: "GET",
    path: "/connections/:id/records",
    handler: guarded(async (connect, request) =>
      ok(
        connect.records(request.params.id!).map((entity) => ({
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
          description: entity.description,
        })),
      ),
    ),
  },
  {
    method: "POST",
    path: "/connections/:id/read",
    handler: guarded(async (connect, request) => {
      const body = record(request.body);
      const result = await connect.read(request.params.id!, body as ReadRequest);
      return ok(result);
    }),
  },
  {
    method: "POST",
    path: "/connections/:id/changes",
    handler: guarded(async (connect, request) => {
      const body = record(request.body);
      const intent = { ...body, connection: request.params.id! } as WriteIntent;
      if (typeof intent.entity !== "string" || typeof intent.kind !== "string")
        return bad(400, "Say what to change: { entity, kind, id?, values? }.");
      return ok(await connect.writes.prepare(intent, request.actor));
    }),
  },
  {
    method: "POST",
    path: "/changes/:pendingId/commit",
    handler: guarded(async (connect, request) => {
      const body = record(request.body);
      if (typeof body.digest !== "string") return bad(400, "Send the digest of the review you approved: { digest }.");
      return ok(await connect.writes.commit({ pendingId: request.params.pendingId!, digest: body.digest }, request.actor));
    }),
  },
  {
    method: "DELETE",
    path: "/changes/:pendingId",
    handler: guarded(async (connect, request) => {
      connect.writes.discard({ pendingId: request.params.pendingId! }, request.actor);
      return ok({ ok: true });
    }),
  },
];

/** The route a method and path name, with its params, or null. */
export const matchRoute = (
  method: string,
  path: string,
): { readonly route: ConnectRoute; readonly params: Record<string, string> } | null => {
  const parts = path.split("/").filter(Boolean);
  for (const route of CONNECT_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split("/").filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, segment] of pattern.entries()) {
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(parts[index]!);
      else if (segment !== parts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
};
