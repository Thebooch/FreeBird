import type { LlmAdapter } from "@freebirdai/dash-agent";
import { matchWriteFields } from "@freebirdai/dash-agent";
import type { CatalogEntry, ConnectionSpec, EntityWritesView, Principal } from "@freebirdai/dash-spec";
import { entityById, mapWriteFields, unmappedFields, writesEmpty, writesView } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CatalogStore } from "../catalog.js";
import { requirePermission } from "../identity/context.js";
import type { Policy } from "../identity/policy.js";
import type { SpecRepository } from "../store.js";
import { readWriteEndpoints, type FetchDocument } from "../writes/read-writes.js";
import { WriteError, WriteService, describeFields } from "../writes/service.js";

/**
 * The routes a change travels through. The logic is in `WriteService`;
 * these translate, and ask the policy before anything that changes what may
 * be written.
 *
 * - `GET  /api/connections/:id/writes` — what each record type can have done to it.
 * - `POST /api/connections/:id/entities/:entity/writes/form` — a form, with current values.
 * - `POST /api/connections/:id/writes/prepare` — build a change; returns its review.
 * - `GET  /api/writes/:pendingId` — a review again.
 * - `POST /api/writes/:pendingId/commit` — `{ digest }`: send it.
 * - `DELETE /api/writes/:pendingId` — never mind.
 * - `PUT  /api/connections/:id/writes/:opId/fields` — a person's answer to "where is this shown?".
 * - `PUT  /api/connections/:id/writes/:opId/offered` — `{ offered }`: switch one endpoint off, or back on.
 * - `POST /api/connections/:id/writes/map` — `{ entity }`: settle the unmatched fields with a model.
 * - `POST /api/catalog/:id/writes/refresh` — read the write endpoints from the specification.
 *
 * There is nothing to turn on. Every connection can change what its API lets
 * it change, and every change is reviewed before it is sent; the policy is
 * the only thing that says no, and in the open-source build it never does.
 *
 * None of these drop cached data except a commit, and a commit only the
 * answers it made stale.
 */

export interface WriteRouteDeps {
  readonly service: WriteService;
  readonly store: SpecRepository;
  readonly catalog: CatalogStore | undefined;
  readonly policy: Policy;
  readonly llm: () => { adapter: LlmAdapter; model?: string } | null;
  readonly fetchDocument: FetchDocument;
  /** Whatever caches what a connection can change — the chat's action registry — must hear of a change. */
  readonly onWritesChanged: () => void;
}

const send = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof WriteError) {
    return reply.status(error.status).send({
      error: error.message,
      code: error.code,
      ...(error.extra.fields ? { fields: error.extra.fields } : {}),
      ...(error.extra.detail ? { detail: error.extra.detail } : {}),
      ...(error.extra.upstreamStatus !== undefined ? { upstreamStatus: error.extra.upstreamStatus } : {}),
      ...(error.extra.outcome ? { outcome: error.extra.outcome } : {}),
      ...(error.extra.review ? { review: error.extra.review } : {}),
    });
  }
  throw error;
};

const whoIs = (request: FastifyRequest, reply: FastifyReply): Principal | null => {
  if (request.principal) return request.principal;
  void reply.status(401).send({ error: "Sign in to continue." });
  return null;
};

const prepareSchema = z.object({
  entity: z.string().min(1),
  kind: z.enum(["create", "update", "delete", "action"]),
  action: z.string().optional(),
  id: z.string().optional(),
  parents: z.record(z.string(), z.string()).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What a principal may do to one record type, as the controls a page draws —
 * trimmed to the kinds the policy allows. Empty when nothing is allowed.
 */
export const allowedWritesView = async (
  service: WriteService,
  principal: Principal,
  connection: ConnectionSpec,
  entityId: string,
  /** The connection's graph, when the caller already built it — several record types, one build. */
  built?: ReturnType<WriteService["graphFor"]>["graph"],
): Promise<EntityWritesView | undefined> => {
  const graph = built ?? service.graphFor(connection).graph;
  const view = writesView(graph.writesOf(entityId));
  if (writesEmpty(view)) return undefined;
  const [create, update, remove, act] = await Promise.all([
    view.create ? service.allowed(principal, connection, entityId, "create") : false,
    view.update ? service.allowed(principal, connection, entityId, "update") : false,
    view.remove ? service.allowed(principal, connection, entityId, "delete") : false,
    view.actions.length > 0 ? service.allowed(principal, connection, entityId, "action") : false,
  ]);
  // An endpoint somebody switched off is never drawn, whatever the policy says.
  const allowed: EntityWritesView = {
    ...(create && view.create?.confirmed ? { create: view.create } : {}),
    ...(update && view.update?.confirmed ? { update: view.update } : {}),
    ...(remove && view.remove?.confirmed ? { remove: view.remove } : {}),
    actions: act ? view.actions.filter((action) => action.confirmed) : [],
  };
  return writesEmpty(allowed) ? undefined : allowed;
};

export const writeRoutes =
  (deps: WriteRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const { service, store, catalog, policy } = deps;

    const connectionOr404 = (id: string, reply: FastifyReply): ConnectionSpec | null => {
      const connection = store.getConnection(id);
      if (!connection) {
        void reply.status(404).send({ error: "no such connection" });
        return null;
      }
      return connection;
    };

    /* ── what can be done ─────────────────────────────────────────── */

    app.get<{ Params: { id: string } }>("/api/connections/:id/writes", async (request, reply) => {
      const principal = whoIs(request, reply);
      if (!principal) return reply;
      const connection = connectionOr404(request.params.id, reply);
      if (!connection) return reply;
      const { entry, graph } = service.graphFor(connection);
      const manage = await policy.can(principal, "connections.manage", { connection: connection.id });
      const entities = [];
      for (const entity of entry?.entities ?? []) {
        const writes = graph.writesOf(entity.id);
        const view = writesView(writes);
        if (writesEmpty(view)) continue;
        const fields = [writes.update, writes.create].flatMap((target) => (target ? [target] : []));
        entities.push({
          id: entity.id,
          name: entity.name,
          writes: view,
          allowed: await allowedWritesView(service, principal, connection, entity.id, graph),
          /* Fields an update would send without knowing their value — what "Match fields" settles. */
          unmatched: writes.update && writes.update.mode === "replace"
            ? unmappedFields(writes.update.fields).map((field) => ({ op: writes.update!.op, field: field.path, label: field.label ?? field.path }))
            : [],
          inferred: fields.some((target) => target.confidence === "inferred"),
        });
      }
      return {
        canManage: manage.ok,
        writeOpCount: entry?.writes.length ?? 0,
        writesVersion: entry?.writesVersion ?? null,
        rereadable: Boolean(entry?.specUrl && entry.origin === "openapi"),
        entities,
      };
    });

    /*
     * A form: the values a change takes, and — for anything that already
     * exists — what each one is now. Reading the current values costs one
     * request, and only when somebody opens the form.
     */
    app.post<{ Params: { id: string; entity: string }; Body: unknown }>(
      "/api/connections/:id/entities/:entity/writes/form",
      async (request, reply) => {
        const principal = whoIs(request, reply);
        if (!principal) return reply;
        const parsed = prepareSchema.omit({ entity: true, values: true }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "a form needs a kind", detail: parsed.error.issues });
        try {
          const { values, exists, target } = await service.current(principal, {
            connection: request.params.id,
            entity: request.params.entity,
            ...parsed.data,
          });
          return {
            kind: parsed.data.kind,
            mode: target.mode,
            title: target.title,
            exists,
            confirmed: target.confirmed,
            verified: target.verified,
            confidence: target.confidence,
            ...(target.action ? { action: target.action } : {}),
            fields: describeFields(target),
            values,
          };
        } catch (error) {
          return send(reply, error);
        }
      },
    );

    /* ── a change ─────────────────────────────────────────────────── */

    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/writes/prepare",
      async (request, reply) => {
        const principal = whoIs(request, reply);
        if (!principal) return reply;
        const parsed = prepareSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "a change needs an entity and a kind", detail: parsed.error.issues });
        }
        try {
          return await service.prepare(principal, { connection: request.params.id, ...parsed.data }, { via: "form" });
        } catch (error) {
          return send(reply, error);
        }
      },
    );

    app.get<{ Params: { pendingId: string } }>("/api/writes/:pendingId", async (request, reply) => {
      const principal = whoIs(request, reply);
      if (!principal) return reply;
      try {
        return service.review(principal, request.params.pendingId);
      } catch (error) {
        return send(reply, error);
      }
    });

    app.post<{ Params: { pendingId: string }; Body: unknown }>(
      "/api/writes/:pendingId/commit",
      async (request, reply) => {
        const principal = whoIs(request, reply);
        if (!principal) return reply;
        const parsed = z.object({ digest: z.string().min(1) }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "the approved digest is required" });
        try {
          return await service.commit(principal, request.params.pendingId, parsed.data.digest);
        } catch (error) {
          return send(reply, error);
        }
      },
    );

    app.delete<{ Params: { pendingId: string } }>("/api/writes/:pendingId", async (request, reply) => {
      const principal = whoIs(request, reply);
      if (!principal) return reply;
      service.discard(principal, request.params.pendingId);
      return { discarded: true };
    });

    /* ── how its endpoints are read ───────────────────────────────── */

    const entryFor = (connection: ConnectionSpec, reply: FastifyReply): CatalogEntry | null => {
      const entry = connection.catalog ? catalog?.get(connection.catalog) : undefined;
      if (!entry || !catalog) {
        void reply.status(404).send({ error: `${connection.title} has no catalog entry to hold its write endpoints.` });
        return null;
      }
      return entry;
    };

    app.put<{ Params: { id: string; opId: string }; Body: unknown }>(
      "/api/connections/:id/writes/:opId/fields",
      async (request, reply) => {
        const connection = connectionOr404(request.params.id, reply);
        if (!connection) return reply;
        if (!(await requirePermission(policy, request, reply, "connections.manage", { connection: connection.id }))) {
          return reply;
        }
        const parsed = z
          .object({
            field: z.string().min(1),
            readFrom: z.string().max(200).nullable().optional(),
            label: z.string().max(120).optional(),
            hidden: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "a field is required", detail: parsed.error.issues });
        const entry = entryFor(connection, reply);
        if (!entry) return reply;
        const op = entry.writes.find((one) => one.id === request.params.opId);
        const field = op?.body?.fields.find((one) => one.path === parsed.data.field);
        if (!op || !field) return reply.status(404).send({ error: "no such write field" });
        if (parsed.data.readFrom) {
          const readable = entry.entities.some((entity) => entity.fields.some((one) => one.path === parsed.data.readFrom));
          if (!readable) return reply.status(400).send({ error: `"${parsed.data.readFrom}" is not a field any record shows.` });
        }
        const updated = {
          ...field,
          ...(parsed.data.readFrom !== undefined ? { readFrom: parsed.data.readFrom, mappedBy: "person" as const } : {}),
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
          ...(parsed.data.hidden !== undefined ? { hidden: parsed.data.hidden } : {}),
        };
        catalog!.put({
          ...entry,
          writes: entry.writes.map((one) =>
            one.id === op.id && one.body
              ? { ...one, body: { ...one.body, fields: one.body.fields.map((f) => (f.path === field.path ? updated : f)) } }
              : one,
          ),
        });
        return { field: updated };
      },
    );

    /*
     * Nothing has to be switched on, but an endpoint that turns out to be
     * wrong — one read from prose that the API does not really have — can be
     * switched off, so it stops being offered.
     */
    app.put<{ Params: { id: string; opId: string }; Body: unknown }>(
      "/api/connections/:id/writes/:opId/offered",
      async (request, reply) => {
        const connection = connectionOr404(request.params.id, reply);
        if (!connection) return reply;
        if (!(await requirePermission(policy, request, reply, "connections.manage", { connection: connection.id }))) {
          return reply;
        }
        const parsed = z.object({ offered: z.boolean() }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "offered must be true or false" });
        const entry = entryFor(connection, reply);
        if (!entry) return reply;
        if (!entry.writes.some((one) => one.id === request.params.opId)) return reply.status(404).send({ error: "no such write endpoint" });
        catalog!.put({
          ...entry,
          writes: entry.writes.map((one) => {
            if (one.id !== request.params.opId) return one;
            const { confirmed: _was, ...rest } = one;
            return parsed.data.offered ? rest : { ...rest, confirmed: false };
          }),
        });
        deps.onWritesChanged();
        return { offered: parsed.data.offered };
      },
    );

    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/writes/map",
      async (request, reply) => {
        const connection = connectionOr404(request.params.id, reply);
        if (!connection) return reply;
        if (!(await requirePermission(policy, request, reply, "connections.manage", { connection: connection.id }))) {
          return reply;
        }
        const parsed = z.object({ entity: z.string().min(1) }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "an entity is required" });
        const entry = entryFor(connection, reply);
        if (!entry) return reply;
        const entity = entityById(entry.entities, parsed.data.entity);
        if (!entity) return reply.status(404).send({ error: "no such record type" });
        const llm = deps.llm();
        if (!llm) return reply.status(503).send({ error: "No AI model is configured, so fields can only be matched by hand." });

        const { graph } = service.graphFor(connection);
        const writes = graph.writesOf(entity.id);
        const targets = [writes.update, writes.create].flatMap((target) => (target ? [target] : []));
        let matched = 0;
        const refused: string[] = [];
        let writesNow = entry.writes;
        for (const target of targets) {
          const op = writesNow.find((one) => one.id === target.op);
          if (!op?.body) continue;
          // What the name rules could not settle, and nobody has answered yet.
          const open = mapWriteFields(entity, op.body.fields).filter(
            (field) => field.readFrom === null && field.mappedBy === undefined && !field.path.includes("[]"),
          );
          if (open.length === 0) continue;
          const result = await matchWriteFields(llm.adapter, {
            apiTitle: connection.title,
            entity,
            fields: open,
            ...(llm.model ? { model: llm.model } : {}),
          });
          if ("error" in result) return reply.status(502).send({ error: `Matching failed: ${result.error}` });
          matched += result.matched;
          refused.push(...result.refused);
          const answered = new Map(result.fields.filter((field) => field.mappedBy === "model").map((field) => [field.path, field]));
          writesNow = writesNow.map((one) =>
            one.id === op.id && one.body
              ? { ...one, body: { ...one.body, fields: one.body.fields.map((field) => answered.get(field.path) ?? field) } }
              : one,
          );
        }
        catalog!.put({ ...entry, writes: writesNow });
        const after = service.graphFor(connection).graph.writesOf(entity.id);
        return {
          matched,
          refused,
          unmatched: after.update ? unmappedFields(after.update.fields).map((field) => field.label ?? field.path) : [],
        };
      },
    );

    /* ── reading the write endpoints ──────────────────────────────── */

    app.post<{ Params: { id: string } }>("/api/catalog/:id/writes/refresh", async (request, reply) => {
      if (!catalog) return reply.status(501).send({ error: "no catalog configured" });
      if (!(await requirePermission(policy, request, reply, "connections.manage"))) return reply;
      const entry = catalog.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
      if (entry.origin !== "openapi" || !entry.specUrl) {
        return reply.status(409).send({
          error: "This API was not read from a specification, so there is nothing to read its write endpoints from again.",
        });
      }
      try {
        const result = await readWriteEndpoints(catalog, entry, deps.fetchDocument);
        deps.onWritesChanged();
        return result;
      } catch (error) {
        return reply.status(502).send({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  };
