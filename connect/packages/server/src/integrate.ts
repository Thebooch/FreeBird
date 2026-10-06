import type { FastifyInstance } from "fastify";
import { fingerprintConnection, getOp, strongestEvidence } from "@freebirdai/connect-spec";
import type { EvidenceStore, IntegrateRouteDeps, IntegrationRunner } from "@freebirdai/connect/host";

/**
 * The integration loop's routes. The loop itself is the engine's: see
 * `@freebirdai/connect/integrate/runner`.
 *
 * - `POST /api/connections/:id/integrate` — check now, or wait for the check
 *   already running.
 * - `GET  /api/connections/:id/evidence` — what has been observed about each
 *   endpoint under the connection's current configuration, and which
 *   endpoints wait for a check (and why one is blocked).
 */
export const integrateRoutes =
  (deps: IntegrateRouteDeps, runner: IntegrationRunner) =>
  async (app: FastifyInstance): Promise<void> => {
    app.post<{ Params: { id: string } }>("/api/connections/:id/integrate", async (request, reply) => {
      const result = await runner.run(request.params.id);
      if ("error" in result) return reply.status(result.status).send({ error: result.error });
      return result;
    });

    app.get<{ Params: { id: string } }>("/api/connections/:id/evidence", async (request, reply) => {
      const connection = deps.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      let records: Awaited<ReturnType<EvidenceStore["forConnection"]>>;
      try {
        records = await deps.evidence.forConnection(connection.id);
      } catch (error) {
        return reply.status(503).send({
          error: `What was observed could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const current = fingerprintConnection(connection);
      const byOp = new Map<string, typeof records>();
      for (const record of records) byOp.set(record.op, [...(byOp.get(record.op) ?? []), record]);
      /* Which endpoints wait for a check, and why one that failed is waiting: said, not hidden. */
      const waiting = (await runner.queued(connection.id).catch(() => [])).filter((one) => one.state !== "done");
      return {
        checking: runner.running(connection.id),
        waiting,
        ops: [...byOp].map(([op, list]) => ({
          op,
          title: getOp(connection, op)?.title ?? op,
          strongest: strongestEvidence(list, current),
          /** Records from an earlier configuration: history, not a claim about now. */
          earlier: list.filter((one) => one.configVersion !== current).length,
        })),
      };
    });
  };
