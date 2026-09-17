import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { entityRefSchema, idSchema, identityValueSchema } from "@freebirdai/dash-spec";
import { IntegrationConflict, type IntegrationRepository } from "./repository.js";
import { IntegrationReadError, type IntegrationReadSession } from "./read.js";
import type { IntegrationPreparation } from "./preparation.js";
import { IntegrationActivation } from "./activation.js";

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
  preparation?: IntegrationPreparation;
}

export const integrationRoutes = (app: FastifyInstance, options: IntegrationRoutesOptions) => {
  const activation = new IntegrationActivation(options.repository);
  app.get("/api/integrations/connections/:connection/preparations", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to view preparation." });
    const params = z.object({ connection: idSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid connection." });
    if (!scope.connections.includes(params.data.connection))
      return reply.code(404).send({ error: "Connection unavailable." });
    const [binding, jobs] = await Promise.all([
      options.repository.getBinding(scope.tenant, params.data.connection),
      options.repository.connectionJobs(scope.tenant, params.data.connection),
    ]);
    return { available: Boolean(binding && options.preparation), jobs };
  });
  app.get("/api/integrations/preparations/:id/activation", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to review this integration." });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid preparation." });
    try {
      return await activation.review(scope, params.data.id);
    } catch (error) {
      if (error instanceof IntegrationConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.post("/api/integrations/preparations/:id/activate", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to activate this integration." });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z
      .object({ revision: z.number().int().positive(), fingerprint: z.string().min(1) })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "Invalid activation request." });
    try {
      return await activation.activate(
        scope,
        params.data.id,
        body.data.revision,
        body.data.fingerprint,
      );
    } catch (error) {
      if (error instanceof IntegrationConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get("/api/integrations/connections/:connection/entities", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to browse records." });
    const params = z.object({ connection: idSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid connection." });
    if (!scope.connections.includes(params.data.connection))
      return reply.code(404).send({ error: "Connection unavailable." });
    try {
      return await options.session(scope).discover(params.data.connection);
    } catch (error) {
      return reply.code(422).send({
        error:
          error instanceof IntegrationReadError
            ? error.message
            : "Record types could not be loaded.",
      });
    }
  });
  app.post("/api/integrations/preparations", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to prepare this connection." });
    const body = z.object({ connection: idSchema }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid preparation request." });
    if (!scope.connections.includes(body.data.connection))
      return reply.code(404).send({ error: "Connection unavailable." });
    if (!options.preparation)
      return reply.code(503).send({ error: "Preparation is not configured." });
    try {
      return await options.preparation.estimate(scope, body.data.connection);
    } catch (error) {
      if (error instanceof IntegrationConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  const paramsSchema = z.object({ connection: idSchema, entity: idSchema });
  app.get("/api/integrations/connections/:connection/entities/:entity", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to use this connection." });
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid record type." });
    if (!scope.connections.includes(parsed.data.connection))
      return reply.code(404).send({ error: "Connection unavailable." });
    try {
      return await options.session(scope).describe(parsed.data.connection, parsed.data.entity);
    } catch (error) {
      return reply
        .code(error instanceof IntegrationReadError && error.code === "denied" ? 403 : 422)
        .send({
          error:
            error instanceof IntegrationReadError
              ? error.message
              : "The record type could not be loaded.",
        });
    }
  });

  const readSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("browse"), connection: idSchema, entity: idSchema }).strict(),
    z.object({ action: z.literal("page"), ref: entityRefSchema }).strict(),
    z
      .object({
        action: z.literal("related"),
        ref: entityRefSchema,
        relationship: idSchema,
        direction: z.enum(["forward", "reverse"]),
      })
      .strict(),
    z
      .object({
        action: z.literal("list"),
        connection: idSchema,
        entity: idSchema,
        inputs: z.record(z.string(), identityValueSchema).default({}),
      })
      .strict(),
    z.object({ action: z.literal("read"), ref: entityRefSchema }).strict(),
    z
      .object({
        action: z.literal("follow"),
        ref: entityRefSchema,
        relationship: idSchema,
        direction: z.enum(["forward", "reverse"]),
      })
      .strict(),
  ]);
  app.post("/api/integrations/read", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to read records." });
    const parsed = readSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid record request.", issues: parsed.error.issues });
    const command = parsed.data;
    const connection =
      command.action === "list" || command.action === "browse"
        ? command.connection
        : command.ref.connection;
    if (!scope.connections.includes(connection))
      return reply.code(404).send({ error: "Connection unavailable." });
    try {
      const session = options.session(scope);
      if (command.action === "browse")
        return await session.browse(command.connection, command.entity);
      if (command.action === "page") return await session.page(command.ref);
      if (command.action === "related")
        return await session.related(command.ref, command.relationship, command.direction);
      if (command.action === "list")
        return await session.list(command.connection, command.entity, command.inputs);
      if (command.action === "read") return await session.read(command.ref);
      return await session.follow(command.ref, command.relationship, command.direction);
    } catch (error) {
      return reply
        .code(error instanceof IntegrationReadError && error.code === "denied" ? 403 : 422)
        .send({
          error:
            error instanceof IntegrationReadError
              ? error.message
              : "These records could not be loaded.",
        });
    }
  });

  app.get("/api/integrations/preparations/:id", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to view preparation." });
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid preparation." });
    const job = await options.repository.getJob(scope.tenant, parsed.data.id);
    if (job?.target && !scope.connections.includes(job.target.connection))
      return reply.code(404).send({ error: "Preparation unavailable." });
    return job ?? reply.code(404).send({ error: "Preparation unavailable." });
  });
  app.post("/api/integrations/preparations/:id/approve", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to approve preparation." });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z
      .object({ revision: z.number().int().positive(), contractFingerprint: z.string().min(1) })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "Invalid preparation approval." });
    const job = await options.repository.getJob(scope.tenant, params.data.id);
    if (!job || (job.target && !scope.connections.includes(job.target.connection)))
      return reply.code(404).send({ error: "Preparation unavailable." });
    try {
      return await options.repository.approveJob(
        scope.tenant,
        params.data.id,
        body.data.revision,
        body.data.contractFingerprint,
        Date.now(),
      );
    } catch (error) {
      if (error instanceof IntegrationConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.post("/api/integrations/preparations/:id/run", async (request, reply) => {
    const scope = await options.scope(request);
    if (!scope) return reply.code(401).send({ error: "Sign in to prepare this connection." });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z
      .object({ resumeRevision: z.number().int().positive().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "Invalid preparation request." });
    if (!options.preparation)
      return reply.code(503).send({ error: "Preparation is not configured." });
    const job = await options.repository.getJob(scope.tenant, params.data.id);
    if (!job?.target || !scope.connections.includes(job.target.connection))
      return reply.code(404).send({ error: "Preparation unavailable." });
    try {
      if (body.data.resumeRevision)
        await options.repository.resumeJob(scope.tenant, job.id, body.data.resumeRevision);
      return await options.preparation.run(scope, job.id);
    } catch (error) {
      if (error instanceof IntegrationConflict)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
};
