import { randomUUID } from "node:crypto";
import type { ComponentRegistry } from "@freebirdai/core";
import { createFreeBirdMcpServer } from "@freebirdai/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OutsideAuth } from "../outside/registry.js";
import type { RateLimiter } from "../public/limits.js";

/**
 * Outside agents over MCP (Dash Evals, phase 4): `/api/public/<workspace>/mcp`,
 * Streamable HTTP, with nobody signed in, like the booking pages. Off until
 * the team turns it on; each tool says so when it is off.
 *
 * Read-write over the small registry in `outside/registry.ts` only, never the
 * team's chat registry: an outside agent can do what a stranger on the
 * public booking page can, and write to the team. Each session keeps its own
 * server, so a prepared action's confirmation token stays with the session
 * that asked for it.
 */

export const OUTSIDE_MCP_ROUTES = ["POST /api/public/:workspace/mcp", "GET /api/public/:workspace/mcp", "DELETE /api/public/:workspace/mcp"] as const;

/** Sessions kept at once, and how long one may sit untouched. */
const MAX_SESSIONS = 200;
const IDLE_MS = 30 * 60_000;
/** Calls a minute from one address. */
const PER_MINUTE = 60;

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  touched: number;
}

export const outsideMcpRoutes =
  (deps: { readonly workspace: string; readonly registry: () => ComponentRegistry<unknown, OutsideAuth>; readonly limiter: RateLimiter; readonly now: () => number }) =>
  async (app: FastifyInstance): Promise<void> => {
    const sessions = new Map<string, Session>();
    const open = { config: { public: true } } as const;

    const sweep = () => {
      const now = deps.now();
      for (const [id, one] of sessions) {
        if (now - one.touched > IDLE_MS) {
          sessions.delete(id);
          void one.transport.close().catch(() => undefined);
        }
      }
    };

    const handle = async (request: FastifyRequest<{ Params: { workspace: string } }>, reply: FastifyReply) => {
      if (request.params.workspace !== deps.workspace) return reply.status(404).send({ error: "Not found." });
      if (!deps.limiter.take(`mcp:${request.ip}`, PER_MINUTE)) return reply.status(429).header("Retry-After", "60").send({ error: "Too many requests. Wait a minute, then try again." });
      const id = request.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (typeof id === "string" && !session) return reply.status(404).send({ jsonrpc: "2.0", error: { code: -32001, message: "That session has ended. Start a new one." }, id: null });
      if (!session) {
        if (request.method !== "POST") return reply.status(400).send({ jsonrpc: "2.0", error: { code: -32000, message: "Start a session with an initialize request." }, id: null });
        sweep();
        if (sessions.size >= MAX_SESSIONS) return reply.status(503).send({ jsonrpc: "2.0", error: { code: -32000, message: "Too many sessions are open. Try again later." }, id: null });
        const said = request.headers["user-agent"];
        const auth: OutsideAuth = { session: randomUUID(), ...(typeof said === "string" && said.trim() ? { agent: said.trim().slice(0, 120) } : {}) };
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => auth.session,
          /* Plain JSON answers: every tool here answers once, and nothing streams. */
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, touched: deps.now() });
          },
        });
        transport.onclose = () => {
          sessions.delete(auth.session);
        };
        const server = createFreeBirdMcpServer<OutsideAuth>({
          registry: deps.registry(),
          mode: "read-write",
          getAuthContext: () => auth,
          sessionId: auth.session,
          name: "Dash for outside agents",
        });
        await server.connect(transport);
        session = { transport, touched: deps.now() };
      }
      session.touched = deps.now();
      reply.hijack();
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
      return reply;
    };

    app.post<{ Params: { workspace: string } }>("/api/public/:workspace/mcp", open, handle);
    app.get<{ Params: { workspace: string } }>("/api/public/:workspace/mcp", open, handle);
    app.delete<{ Params: { workspace: string } }>("/api/public/:workspace/mcp", open, handle);
    app.addHook("onClose", async () => {
      for (const one of sessions.values()) await one.transport.close().catch(() => undefined);
      sessions.clear();
    });
  };
