import type { Permission } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ContactError, type ContactService } from "../contacts/service.js";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";

/**
 * Contacts (`contacts/`): `/api/contacts/*`.
 *
 * Reading contacts needs `records.read`, like the records they are linked
 * to. Changing one, linking it, and setting up the fields contacts hold and
 * how they are matched need `contacts.manage` (owner, admin, editor),
 * guarded in `identity/guard.ts` and asked again here.
 */

/** A record type someone may read, and its fields, for choosing where a contact field comes from. */
export interface ContactSource {
  readonly connection: string;
  readonly title: string;
  readonly entities: ReadonlyArray<{
    readonly entity: string;
    readonly name: string;
    readonly fields: ReadonlyArray<{ readonly path: string; readonly label?: string; readonly samples: readonly string[] }>;
  }>;
}

export const contactRoutes = (deps: {
  readonly contacts: ContactService;
  readonly policy: Policy;
  readonly sources?: (principal: NonNullable<FastifyRequest["principal"]>) => Promise<readonly ContactSource[]>;
}) =>
  async (app: FastifyInstance): Promise<void> => {
    const { contacts, policy } = deps;
    const answer = (reply: FastifyReply, error: unknown) => {
      if (error instanceof ContactError) return reply.status(error.status).send({ error: error.message, ...(error.holder ? { detail: { holder: error.holder } } : {}) });
      throw error;
    };
    const as =
      (permission: Permission, run: (principal: NonNullable<FastifyRequest["principal"]>, params: Record<string, string>, body: unknown, query: Record<string, string>) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = await requirePermission(policy, request, reply, permission);
        if (!principal) return reply;
        try {
          return await run(principal, (request.params ?? {}) as Record<string, string>, request.body, (request.query ?? {}) as Record<string, string>);
        } catch (error) {
          return answer(reply, error);
        }
      };
    const read = (run: Parameters<typeof as>[1]) => as("records.read", run);
    const manage = (run: Parameters<typeof as>[1]) => as("contacts.manage", run);
    const target = (body: unknown) => {
      const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
      if (!text("connection") || !text("entity") || !text("recordId")) throw new ContactError("Say which record: its connection, record type and id.");
      return { connection: text("connection"), entity: text("entity"), recordId: text("recordId") };
    };

    app.get(
      "/api/contacts",
      read(async (_principal, _params, _body, query) => {
        const limit = Number(query["limit"]);
        return contacts.list({
          ...(query["search"] ? { search: query["search"] } : {}),
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          ...(query["after"] ? { after: query["after"] } : {}),
        });
      }),
    );
    app.get("/api/contacts/setup", read(async () => contacts.setup()));
    app.get("/api/contacts/sources", manage(async (principal) => (deps.sources ? deps.sources(principal) : [])));
    app.get("/api/contacts/:id", read(async (_principal, params) => contacts.require(params["id"]!)));

    app.post("/api/contacts", manage(async (principal, _params, body) => contacts.create(body, principal.userId)));
    app.put("/api/contacts/:id", manage(async (principal, params, body) => contacts.update(params["id"]!, body, principal.userId)));
    app.delete(
      "/api/contacts/:id",
      manage(async (_principal, params) => {
        await contacts.forget(params["id"]!);
        return { ok: true };
      }),
    );
    app.post("/api/contacts/:id/match", manage(async (_principal, params) => contacts.matchWithDetail(params["id"]!)));
    app.post("/api/contacts/:id/refresh", manage(async (principal, params) => contacts.refreshWithDetail(params["id"]!, principal)));
    app.post("/api/contacts/:id/link", manage(async (principal, params, body) => contacts.link(params["id"]!, target(body), principal)));
    app.post("/api/contacts/:id/unlink", manage(async (_principal, params, body) => contacts.unlink(params["id"]!, target(body))));

    app.put("/api/contacts/fields/:key", manage(async (_principal, params, body) => contacts.putField(params["key"]!, body)));
    app.delete(
      "/api/contacts/fields/:key",
      manage(async (_principal, params) => {
        await contacts.removeField(params["key"]!);
        return { ok: true };
      }),
    );
    app.post("/api/contacts/match-rules", manage(async (principal, _params, body) => contacts.putMatchRule(null, body, principal)));
    app.put("/api/contacts/match-rules/:id", manage(async (principal, params, body) => contacts.putMatchRule(params["id"]!, body, principal)));
    app.delete(
      "/api/contacts/match-rules/:id",
      manage(async (_principal, params) => {
        await contacts.removeMatchRule(params["id"]!);
        return { ok: true };
      }),
    );
  };
