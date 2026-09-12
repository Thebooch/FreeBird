import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { entityRefSchema, idSchema, identityValueSchema } from "@freebirdai/dash-spec";
import { IntegrationConflict, type IntegrationRepository } from "./repository.js";
import { IntegrationReadError, type IntegrationReadSession } from "./read.js";

export interface IntegrationScope {
  tenant: string;
  authorizationRevision: string;
  connections: readonly string[];
}
export interface IntegrationRoutesOptions {
  repository: IntegrationRepository;
  /** Supplied by the host's auth layer, never from request body or query parameters. */
  scope(request: FastifyRequest): Promise<IntegrationScope | null>;
  session(scope: IntegrationScope): IntegrationReadSession;
}

export const integrationRoutes = (app: FastifyInstance, options: IntegrationRoutesOptions) => {
  const paramsSchema = z.object({ connection: idSchema, entity: idSchema });
  app.get("/api/integrations/connections/:connection/entities/:entity", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to use this connection." });
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid record type." });
    if (!scope.connections.includes(parsed.data.connection)) return reply.code(404).send({ error: "Connection unavailable." });
    try { return await options.session(scope).describe(parsed.data.connection, parsed.data.entity); }
    catch (error) { return reply.code(error instanceof IntegrationReadError && error.code === "denied" ? 403 : 422).send({ error: error instanceof IntegrationReadError ? error.message : "The record type could not be loaded." }); }
  });

  const readSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list"), connection: idSchema, entity: idSchema, inputs: z.record(z.string(), identityValueSchema).default({}) }).strict(),
    z.object({ action: z.literal("read"), ref: entityRefSchema }).strict(),
    z.object({ action: z.literal("follow"), ref: entityRefSchema, relationship: idSchema, direction: z.enum(["forward", "reverse"]) }).strict(),
  ]);
  app.post("/api/integrations/read", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to read records." });
    const parsed = readSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid record request.", issues: parsed.error.issues });
    const command = parsed.data;
    const connection = command.action === "list" ? command.connection : command.ref.connection;
    if (!scope.connections.includes(connection)) return reply.code(404).send({ error: "Connection unavailable." });
    try {
      const session = options.session(scope);
      if (command.action === "list") return await session.list(command.connection, command.entity, command.inputs);
      if (command.action === "read") return await session.read(command.ref);
      return await session.follow(command.ref, command.relationship, command.direction);
    } catch (error) {
      return reply.code(error instanceof IntegrationReadError && error.code === "denied" ? 403 : 422).send({ error: error instanceof IntegrationReadError ? error.message : "These records could not be loaded." });
    }
  });

  app.get("/api/integrations/preparations/:id", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to view preparation." });
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid preparation." });
    const job = await options.repository.getJob(scope.tenant, parsed.data.id);
    return job ?? reply.code(404).send({ error: "Preparation unavailable." });
  });
  app.post("/api/integrations/preparations/:id/approve", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to approve preparation." });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ revision: z.number().int().positive(), contractFingerprint: z.string().min(1) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid preparation approval." });
    try { return await options.repository.approveJob(scope.tenant, params.data.id, body.data.revision, body.data.contractFingerprint, Date.now()); }
    catch (error) { if (error instanceof IntegrationConflict) return reply.code(409).send({ error: error.message }); throw error; }
  });
};
