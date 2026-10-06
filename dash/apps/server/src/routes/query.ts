import { AdapterError } from "@freebirdai/connect/adapters";
import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import { getOp, isSingletonOp } from "@freebirdai/dash-spec";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildQueryRequest,
  clampMaxAge,
  EACH_MAX,
  eachKey,
  resolveRequestedRange,
} from "@freebirdai/connect/host";
import type { EachRequest } from "@freebirdai/connect/host";
import { SetupPreviews } from "../concierge/preview.js";
import { fingerprintConnection } from "@freebirdai/dash-spec";
import { ViewedRequests, paramShape } from "../keeper/viewed.js";
import { type SpecRepository } from "../store.js";
import type { BuildServerOptions } from "../server.js";
import type { Engine } from "@freebirdai/connect";

const rangeSchema = z.object({
  preset: z.enum(["1h", "24h", "7d", "30d", "90d", "12mo", "ytd", "custom"]).default("30d"),
  grain: z.enum(["1h", "1d", "1w", "1mo", "1y"]).optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  /** Every record, whatever its dates: the API is asked without date bounds. */
  all: z.boolean().optional(),
});

const querySchema = z.object({
  connection: z.string().min(1),
  op: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  range: rangeSchema.default({ preset: "30d" }),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * How old an answer this caller will accept, in milliseconds.
   *
   * Stated per request rather than configured server-side, because one
   * endpoint is read by several widgets that legitimately disagree about how
   * current they need to be. Zero means revalidate, which is what an explicit
   * Refresh sends. Clamped before use.
   */
  maxAgeMs: z.number().optional(),
  /**
   * Whether somebody is looking, or somebody asked.
   *
   * `view` is what a board sends while it is being read: serve what is held,
   * at any age, and never call the API. `refresh` is what the Refresh buttons
   * send. See `QueryCache.read`.
   *
   * Defaults to `refresh`, so an older browser, a script, or anything else
   * that does not know about this keeps exactly the behaviour it had.
   */
  mode: z.enum(["view", "refresh"]).default("refresh"),
});

/** Every record's related records, past the ones a tile reads itself. See `EachReads`. */
const eachSchema = z.object({
  connection: z.string().min(1),
  op: z.string().min(1),
  /** What every read sends, whatever the record. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** The input each record's value goes into. */
  input: z.string().min(1).max(120),
  /** Each record's value, once each. */
  values: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .min(1)
    .max(EACH_MAX),
  range: rangeSchema.default({ preset: "30d" }),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/** Reading: the query a tile sends, the rest of its per-record reads, what has changed on an endpoint, and what each connection has cost. */
export interface QueryRouteDeps {
  /** Where connections live. */
  readonly store: SpecRepository;
  /** Whether the keeper runs, which decides what reads as stale. */
  readonly options: Pick<BuildServerOptions, "keeper">;
  readonly registry: Engine["registry"];
  /** The engine's read: the one every reader of an endpoint goes through. */
  readonly read: Engine["read"];
  readonly queries: Engine["queries"];
  readonly eachReads: Engine["eachReads"];
  readonly eachPlan: Engine["eachPlan"];
  readonly everyMsForOp: Engine["everyMsForOp"];
  readonly refreshQueryIdentity: Engine["refreshQueryIdentity"];
  readonly seen: Engine["seen"];
  /** What changed on an endpoint since it was accepted. */
  readonly drift: Engine["drift"];
  /** What boards asked for, so the keeper refreshes exactly that. */
  readonly viewed: ViewedRequests;
  /** Receipts for what a tile was shown. */
  readonly previews: SetupPreviews;
}

export const queryRoutes =
  (deps: QueryRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const {
      store,
      options,
      registry,
      read,
      queries,
      eachReads,
      eachPlan,
      everyMsForOp,
      refreshQueryIdentity,
      seen,
      drift,
      viewed,
      previews,
    } = deps;

    /** What has changed on a connection's endpoints since they were checked, in words. */
    app.get<{ Params: { id: string } }>("/api/connections/:id/drift", async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      try {
        return { changes: await drift.open(connection) };
      } catch (error) {
        return reply
          .status(503)
          .send({
            error: `What has changed could not be read: ${error instanceof Error ? error.message : String(error)}`,
          });
      }
    });

    app.post<{ Body: unknown }>("/api/query", async (request, reply) => {
      const parsed = querySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid query", detail: parsed.error.issues });
      }
      const { connection, op, params, range, filters, mode } = parsed.data;
      /* Somebody is there. Recorded before anything can fail, because a refused
       * read is still evidence that a board is open. */
      seen.touch(connection, Date.now());

      const spec = store.getConnection(connection);
      if (!spec) return reply.status(404).send({ error: `no connection "${connection}"` });
      const resolvedOp = getOp(spec, op);
      if (!resolvedOp) return reply.status(404).send({ error: `no operation "${op}"` });
      registry.addConnection(spec);

      try {
        /*
         * The engine's read: one spelling of the request, a background read's
         * own refresh, the cache, carrying a capped read on, and the shape
         * watch. What is Dash's is said around it: what was viewed, so the
         * keeper refreshes exactly this, and the tile's receipt.
         */
        const answer = await read({
          connection: spec,
          op: resolvedOp,
          params,
          resolved: { range: resolveRequestedRange(range, Date.now()), filters },
          mode,
          maxAgeMs: clampMaxAge(parsed.data.maxAgeMs),
          /*
           * Old is measured against how often this endpoint is refreshed, not
           * only against what the widget asked for — and only while the keeper
           * is running, since without it nothing refreshes on that cadence.
           */
          ...(options.keeper === true ? { freshForMs: Math.round(1.5 * everyMsForOp(connection, op)) } : {}),
          onRequest: ({ key, overrides, resolved }) =>
            viewed.record({ key, connection, op, overrides, resolved, shape: paramShape(params) }, Date.now()),
        });
        const { outcome, meta, changed } = answer;
        return {
          body: outcome.body,
          meta: {
            ...meta,
            /* A change open on this endpoint is said on every tile that reads it, however old the copy. */
            ...(changed ? { warnings: [...meta.warnings, changed] } : {}),
            receipt: previews.record(answer.key, spec, op, answer.resolved, answer.overrides),
            cache: outcome.outcome,
            ageMs: Number.isFinite(outcome.ageMs) ? outcome.ageMs : 0,
            ...(outcome.staleReason ? { staleReason: outcome.staleReason } : {}),
          },
        };
      } catch (error) {
        // The cache re-throws the adapter's own error, which is already phrased
        // for a person; the generic handler below would flatten it to a 500.
        if (error instanceof AdapterError) {
          /*
           * `retryAfter` both ways: as the standard header, and in the body
           * because the browser reads this through `fetch` and the tile needs
           * the number to count down with. Sending only the header would leave
           * the retry button enabled during a wait it cannot win.
           */
          /*
           * Nothing there yet, which for a record that exists at most once
           * under its parent is a normal state rather than a failure: a unit
           * with no listing answers 404. Said as an empty answer so the tile
           * reads "none" instead of an error, and the page offers to add one.
           */
          if (error.upstreamStatus === 404 && isSingletonOp(spec.resources, op)) {
            return {
              // No rows, rather than one empty one: a count of these is zero.
              body: [],
              meta: {
                url: "",
                status: 404,
                fetchedAt: Date.now(),
                durationMs: 0,
                pages: 0,
                truncated: false,
                warnings: [],
                absent: true,
                cache: "miss",
                ageMs: 0,
              },
            };
          }
          if (error.retryAfter) reply.header("retry-after", error.retryAfter);
          return reply.status(error.status === 429 ? 429 : 502).send({
            error: error.message,
            userMessage: error.userMessage,
            ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}),
            /*
             * The upstream's status, separately from ours.
             *
             * The HTTP status above is about *this* request: everything but a
             * rate limit becomes 502, because a 401 from the browser to its own
             * origin would mean something else entirely. But that flattening
             * also lost the distinction the tile needs — a 401, a 403 and a
             * generic failure are three different sentences and only one of them
             * is worth a Retry button. `describeFailure` has always had that copy
             * and could never reach it, so a permission error offered a retry
             * that could not possibly succeed.
             */
            status: error.status,
            ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
          });
        }
        throw error;
      }
    });

    /*
     * The rest of a tile's per-record reads, read here in the background.
     *
     * A tile reads the first twenty-five records' related records itself and
     * says the rest are missing; this reads every one it names, behind every
     * board's own reads, and answers "reading" until it has them all. Each read
     * is the request the tile would have sent — the same spelling, so one
     * already held is not asked again — and one not held is read without being
     * stored, so two hundred of them cannot push a board's reads out of the
     * cache. See `EachReads`.
     */
    app.post<{ Body: unknown }>("/api/query/each", async (request, reply) => {
      const parsed = eachSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid query", detail: parsed.error.issues });
      }
      const { connection, op, params, input, values, range, filters } = parsed.data;
      seen.touch(connection, Date.now());
      const spec = store.getConnection(connection);
      if (!spec) return reply.status(404).send({ error: `no connection "${connection}"` });
      const resolvedOp = getOp(spec, op);
      if (!resolvedOp) return reply.status(404).send({ error: `no operation "${op}"` });
      registry.addConnection(spec);
      refreshQueryIdentity(spec);

      const asked: EachRequest = {
        connection,
        op,
        params,
        input,
        values,
        window: { range: resolveRequestedRange(range, Date.now()), filters },
        configVersion: fingerprintConnection(spec),
      };
      const plan = eachPlan(asked);
      if (!plan) return reply.status(404).send({ error: `no operation "${op}"` });
      return eachReads.ask({
        key: eachKey(connection, plan.keys),
        connection,
        count: plan.keys.length,
        read: plan.read,
        request: asked,
      });
    });

    /**
     * What each connection has cost, and what the cache saved.
     *
     * Counts only — never what was read — so it carries none of the customer's
     * data and none of the retention questions that come with it.
     */
    app.get("/api/cost", async () => ({
      connections: queries.accounting.all(),
      cache: queries.store.stats(),
    }));
  };
