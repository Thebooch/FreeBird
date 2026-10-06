import { AdapterError } from "@freebirdai/connect/adapters";
import {
  analyseStructure,
  catalogEntryToVerify,
  catalogForBrowser,
  connectionFromCatalog,
  decideAll,
  estimateEnumeration,
  fromReport,
  mergeDescribedEntities,
  opsOfResource,
  preservedWrites,
  refreshOutdatedConnectDetails,
  validationCandidates,
  verifyRecords,
  withVerifiedParams,
} from "@freebirdai/connect/host";
import type { AnalyseOptions } from "@freebirdai/connect/host";
import {
  VERIFY_BUDGET_DEFAULT,
  VERIFY_BUDGET_MAX,
  authTokenRefs,
  catalogEntrySchema,
  connectionKeyRefs,
  connectionNeedsAddress,
  connectionNeedsAuthSetup,
  connectionSchema,
  entityById,
  entityGraph,
  fieldPathSchema,
  getOp,
  isStale,
  opDefSchema,
  recipeFor,
  resolveRange,
  resolveServerUrl,
  resourceSchema,
} from "@freebirdai/connect-spec";
import type { ConnectionSpec, ResolvedParams } from "@freebirdai/connect-spec";
import type { Engine } from "@freebirdai/connect";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { inferShape } from "@freebirdai/connect/agent";
import { z } from "zod";
/**
 * A connection's routes: listing and saving connections, adding one from the
 * catalog, its address, endpoints, record types and references, checking and
 * enumerating what it can read, its rhythm, and the catalog itself.
 *
 * Fastify, over an engine from `createEngine`. A host says what is its own
 * through `ConnectionRouteHooks`: Dash makes a board for each connection,
 * removes it again, and marks a connection that is about to be onboarded.
 */
export interface ConnectionRouteHooks {
  /** Whether this request may see this connection. Absent means yes. */
  readonly mayRead?: (request: FastifyRequest, connection: string) => boolean | Promise<boolean>;
  /** A connection was saved: the host makes whatever it keeps beside one. */
  readonly onSaved?: (connection: ConnectionSpec) => void;
  /** A connection was removed: the host removes what it kept beside it. */
  readonly onDeleted?: (connection: string) => void | Promise<void>;
  /** A connection is being made from the catalog: the host adds its own setup, from the request. */
  readonly fromCatalog?: (
    connection: ConnectionSpec,
    body: Record<string, unknown>,
  ) => ConnectionSpec;
  /** Which of a connection's endpoints the host keeps warm. */
  readonly warmOps?: (connection: string) => Iterable<string>;
  /** Where accepted shapes are kept, so a removed connection's go too. */
  readonly shapes?: { forget(connection: string): Promise<void> };
}

export const connectionRoutes =
  (engine: Engine, hooks: ConnectionRouteHooks = {}) =>
  async (app: FastifyInstance): Promise<void> => {
    const {
      store,
      registry,
      catalog,
      queries,
      publicConnection,
      rhythms,
      upstream,
      secretFor,
      withKeyFlag,
      keys,
      integration,
      seenValues,
      rhythmFor,
      relatedFor,
      readWritesFor,
      fetchDocument: readDocument,
      looksLikeAnId,
      jobs,
      forgetTiers,
      evidence,
      enumerated,
      enumerate,
      discovered,
      broker,
    } = engine;
    const mayRead = async (request: FastifyRequest, connection: string): Promise<boolean> =>
      hooks.mayRead ? hooks.mayRead(request, connection) : true;
    const shapes = hooks.shapes ?? { forget: async () => {} };

    app.get("/api/connections", async (request) => {
      const listed = store.listConnections();
      const readable = await Promise.all(
        listed.map((connection) => mayRead(request, connection.id)),
      );
      return listed
        .filter((_, index) => readable[index])
        .map((connection) => publicConnection(connection));
    });

    app.get<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      return publicConnection(connection);
    });

    /**
     * The record types this connection has, for choosing between.
     *
     * A hundred plain nouns with a sentence each, which is what the manual
     * builder offers instead of two hundred endpoints titled "Retrieve all X".
     * Deliberately light: what each record type *contains* is a second request,
     * made only for the one somebody picked.
     */
    app.get<{ Params: { id: string } }>("/api/connections/:id/entities", async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const entities = connection.catalog ? (catalog?.get(connection.catalog)?.entities ?? []) : [];

      /*
       * The endpoints *this connection* carries, which is not the same as the
       * ones the API has. A connection may hold a subset, and a resource keeps
       * declaring its list endpoint either way — so asking the resource alone
       * would advertise a record type nothing here could fetch.
       */
      const carried = new Set(connection.ops.map((op) => op.id));

      return entities.map((entity) => {
        const resource = connection.resources.find((one) => one.id === entity.resource);
        return {
          entity: entity.id,
          name: entity.name,
          kind: entity.kind,
          ...(entity.description ? { description: entity.description } : {}),
          /** Whether somebody would start a widget from these, or only reach them. */
          starting: recipeFor(entity.kind).starting,
          /**
           * Whether anything here lists them.
           *
           * A record type nothing lists cannot be a widget however well
           * described it is, and offering it would be offering a dead end.
           */
          listable: Boolean(resource?.listOp && carried.has(resource.listOp)),
        };
      });
    });

    /**
     * Every link between this API's record types, and what it would take to
     * correct one.
     *
     * Read from the record types themselves rather than from the endpoint-level
     * relations: those are two different models, and this is the one that
     * decides what a widget is built from. The reach travels with each link
     * because "points at Users" and "points at Users and can be opened" are
     * different facts, and only the second makes a name appear in a cell.
     */
    app.get<{ Params: { id: string } }>(
      "/api/connections/:id/references",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        const entities = connection.catalog
          ? (catalog?.get(connection.catalog)?.entities ?? [])
          : [];
        if (entities.length === 0) return { described: false, entities: [], links: [] };

        const graph = entityGraph(relatedFor(connection, entities));
        const nameOf = (id: string): string => entityById(entities, id)?.name.many ?? id;

        return {
          described: true,
          /** Every record type, so a correction can name a different one. */
          entities: entities.map((entity) => ({ id: entity.id, title: entity.name.many })),
          links: entities.flatMap((entity) =>
            graph.referencesOf(entity.id).map((reference) => ({
              entity: entity.id,
              from: entity.name.many,
              field: reference.field,
              label: reference.label ?? reference.field,
              target: reference.target,
              to: nameOf(reference.target),
              /*
               * `free` means the row already carries the name, so nothing is
               * fetched. A null reach is a link nothing can open — worth saying,
               * because it looks identical in a widget until it is clicked.
               */
              cost: reference.cost,
              openable: reference.reach !== null,
              verified: reference.verified,
            })),
          ),
          /**
           * Fields that look like a link and are not recorded as one.
           *
           * Listed for two reasons, and the second is the one that forced it:
           * the describe pass misses links, and — since saying "not a link" is
           * an answer here — a field corrected that way would otherwise vanish
           * from the only screen that could put it back. A name ending in `Id`
           * is the whole test, which is deliberately weak: this is a list of
           * things to look at, not a claim that any of them point anywhere.
           */
          candidates: entities.flatMap((entity) =>
            entity.fields
              .filter(
                (field) =>
                  !field.reference &&
                  field.path !== entity.identity?.field &&
                  looksLikeAnId(field.path),
              )
              .slice(0, 12)
              .map((field) => ({
                entity: entity.id,
                from: entity.name.many,
                field: field.path,
                label: field.label ?? field.path,
              })),
          ),
          /** Links the record types record and nothing here could execute. */
          unreachable: graph.unreachable,
        };
      },
    );

    /**
     * Correct where one of a record's fields points.
     *
     * The links that decide widgets are the ones on the record types, and until
     * now they were the only ones nobody could correct: the editor in
     * Connections → Manage edits `resource.relations`, an endpoint-level model
     * that a described API no longer consults. A link you can see being wrong
     * and cannot fix is worse than one that is merely missing.
     *
     * One field at a time, `PUT` because the reference is replaced whole, and
     * `null` removes it — which is the honest answer for a field that resembles
     * a link and is not one. What is written here is what the describing pass
     * wrote, in the same place, so everything downstream — the brief compiler,
     * record pages, the reference cells — reads the correction with no second
     * path to keep in step.
     */
    app.put<{ Params: { id: string; entity: string }; Body: unknown }>(
      "/api/connections/:id/entities/:entity/reference",
      async (request, reply) => {
        const parsed = z
          .object({
            field: fieldPathSchema,
            /** The record type it points at, or null to say it points at none. */
            target: z.string().min(1).max(64).nullable(),
          })
          .safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid reference", detail: parsed.error.issues });
        }

        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        const entry = connection.catalog ? catalog?.get(connection.catalog) : undefined;
        const entity = entry?.entities?.find((one) => one.id === request.params.entity);
        if (!entry || !entity) return reply.status(404).send({ error: "no such record type" });

        const field = entity.fields.find((one) => one.path === parsed.data.field);
        if (!field) {
          return reply.status(400).send({
            error: `${entity.name.many} have no field called ${parsed.data.field}.`,
          });
        }
        /*
         * A target off the roster is refused rather than stored. A reference
         * naming a record type nothing describes resolves to nothing, and every
         * reader of it would report a link that simply never opens.
         */
        const target = parsed.data.target
          ? entityById(entry.entities ?? [], parsed.data.target)
          : null;
        if (parsed.data.target && !target) {
          return reply.status(400).send({
            error: `There is no record type here called "${parsed.data.target}".`,
          });
        }

        const saved = catalog!.put({
          ...entry,
          entities: (entry.entities ?? []).map((one) =>
            one.id === entity.id
              ? {
                  ...one,
                  fields: one.fields.map((each) =>
                    each.path !== field.path
                      ? each
                      : target
                        ? {
                            ...each,
                            reference: {
                              ...(each.reference ?? { holds: "scalar" as const, embedded: [] }),
                              entity: target.id,
                              /*
                               * A correction is somebody saying so, which is not
                               * the same as a request having resolved there.
                               * Clearing this puts the link back in the queue the
                               * check pass works through, rather than letting a
                               * new target inherit the old one's proof.
                               */
                              verified: false,
                            },
                          }
                        : { ...each, reference: undefined },
                  ),
                }
              : one,
          ),
        });

        const after = saved.entities?.find((one) => one.id === entity.id);
        return {
          field: field.path,
          reference: after?.fields.find((one) => one.path === field.path)?.reference ?? null,
        };
      },
    );

    /**
     * Check what has been described against the real account.
     *
     * The one thing in this whole layer that spends somebody's API quota, which
     * is why it is a request somebody makes rather than something that happens
     * on its own. Two claims cannot be settled by re-reading a specification:
     * that a field identifies a record, and that a field pointing at another
     * record type really resolves there. Both are settled by asking.
     *
     * Budgeted, and the budget is the point: a real API has a hundred record
     * types and as many links again, so an unbounded check is hundreds of
     * requests against an account that rate-limits.
     */
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/verify",
      async (request, reply) => {
        const parsed = z
          .object({ budget: z.number().int().min(1).max(VERIFY_BUDGET_MAX).optional() })
          .safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({ error: "invalid budget", detail: parsed.error.issues });
        }

        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const entry = connection.catalog ? catalog?.get(connection.catalog) : undefined;
        const entities = entry?.entities ?? [];
        if (entities.length === 0) {
          return reply.status(409).send({
            error: "This API's records have not been described yet, so there is nothing to check.",
          });
        }
        registry.addConnection(connection);

        const carried = new Set(connection.ops.map((op) => op.id));
        const result = await verifyRecords({
          entities,
          resources: connection.resources,
          carried,
          rowsPathOf: (op) => getOp(connection, op)?.rowsPath,
          budget: parsed.data.budget ?? VERIFY_BUDGET_DEFAULT,
          ops: connection.ops,
          now: new Date().toISOString(),
          read: async (op, params) => {
            try {
              /*
               * The id goes in as a filter rather than as an override: a by-id
               * endpoint carries it in its *path*, and a path token reads the
               * filters, while an override would only ever become a query
               * parameter the endpoint never asked for.
               */
              const fetched = await upstream(connection.id, () =>
                registry.fetch(
                  connection.id,
                  op,
                  {},
                  {
                    params: {
                      range: resolveRange({ preset: "30d", now: Date.now() }),
                      filters: params,
                    },
                    now: Date.now(),
                    resolveSecret: secretFor,
                  },
                ),
              );
              return { ok: true, body: fetched.body };
            } catch (error) {
              /*
               * A refusal is an outcome here, not a failure: the run records how
               * far it got and stops. Only the status matters — what is being
               * decided is whether to keep asking.
               */
              return {
                ok: false,
                body: null,
                ...(error instanceof AdapterError ? { status: error.status } : {}),
              };
            }
          },
        });

        /*
         * Merged rather than written over, and through the same rule a
         * re-description uses: evidence gathered here is carried onto whatever
         * the catalog holds *now*, so a describe run that finished while this
         * was in flight keeps its newer prose, and evidence about a claim that
         * has since changed lapses instead of vouching for something else.
         */
        if (entry && catalog) {
          const current = catalog.get(entry.id) ?? entry;
          catalog.put({
            ...current,
            entities: mergeDescribedEntities(result.entities, current.entities ?? []),
            entitiesVerifiedAt: new Date().toISOString(),
          });
        }

        return {
          checked: result.checked,
          identitiesConfirmed: result.identitiesConfirmed,
          referencesResolved: result.referencesResolved,
          requests: result.spent,
          stopped: result.stopped,
          notes: result.notes,
        };
      },
    );

    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id",
      async (request, reply) => {
        /*
         * Setup progress is the server's to keep. A client saving a connection
         * from its own form does not send it, and must not wipe it by omission.
         */
        const existing = store.getConnection(request.params.id);
        const body = request.body as Record<string, unknown>;
        const parsed = connectionSchema.safeParse({
          ...(existing?.onboarding && !("onboarding" in body)
            ? { onboarding: existing.onboarding }
            : {}),
          ...body,
          id: request.params.id,
        });
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid connection", detail: parsed.error.issues });
        }
        /* A kind nothing on this server reads is refused when saved, not when a board first asks. */
        if (!registry.adapterFor(parsed.data.kind)) {
          return reply
            .status(400)
            .send({ error: `Nothing on this server reads a "${parsed.data.kind}" connection.` });
        }
        store.putConnection(parsed.data);
        queries.invalidate(parsed.data.id);
        hooks.onSaved?.(parsed.data);
        registry.addConnection(parsed.data);
        return publicConnection(parsed.data);
      },
    );

    /**
     * Say where this connection's API lives.
     *
     * Two ways in, because there are two kinds of API. One whose address has a
     * per-account blank — `https://{account}.example.com/api/manager` — takes
     * `values` for the blanks and is filled in here, where the template and its
     * rules are. One whose documentation never said, or said wrongly, takes the
     * whole `baseUrl`, and the template, if any, no longer applies.
     *
     * A new address is a different account, so it is treated like a new key:
     * cached rows are dropped and the revision moves, so nothing fetched from
     * the old address is shown as if it came from this one.
     */
    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/address",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        const parsed = z
          .object({
            values: z.record(z.string(), z.string().max(200)).optional(),
            baseUrl: z.string().max(500).optional(),
            /* The API is on a private network this server's operator allows (`EgressPolicy`). */
            privateNetwork: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!parsed.success || (!parsed.data.values && !parsed.data.baseUrl)) {
          return reply
            .status(400)
            .send({ error: "Give the address, or the values for its blanks." });
        }

        let baseUrl: string;
        let server = connection.server;
        if (parsed.data.baseUrl !== undefined) {
          let url: URL;
          try {
            url = new URL(parsed.data.baseUrl.trim());
          } catch {
            return reply.status(400).send({ error: "That is not a web address." });
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return reply
              .status(400)
              .send({ error: "The address has to start with https:// or http://." });
          }
          if (url.username || url.password) {
            return reply
              .status(400)
              .send({ error: "Leave credentials out of the address; they go in the key step." });
          }
          baseUrl = url.toString().replace(/\/+$/, "");
          server = undefined;
        } else {
          if (!connection.server) {
            return reply
              .status(400)
              .send({ error: "This connection's address has no blanks to fill." });
          }
          const values = Object.fromEntries(
            Object.entries(parsed.data.values ?? {}).map(([name, value]) => [name, value.trim()]),
          );
          const resolved = resolveServerUrl(connection.server, values);
          if (!resolved.url) {
            const label = (name: string) =>
              connection.server?.variables.find((one) => one.name === name)?.label ?? name;
            return reply.status(400).send({
              error:
                resolved.missing.length > 0
                  ? `Fill in ${resolved.missing.map(label).join(", ")}.`
                  : `${resolved.invalid.map(label).join(", ")} can only contain letters, numbers, dots, dashes and underscores${
                      resolved.invalid.some(
                        (name) =>
                          connection.server?.variables.find((one) => one.name === name)?.options,
                      )
                        ? ", and must be one of the values offered"
                        : ""
                    }.`,
              missing: resolved.missing,
              invalid: resolved.invalid,
            });
          }
          baseUrl = resolved.url;
          server = { ...connection.server, values };
        }

        const {
          server: _previous,
          addressPending: _pending,
          privateNetwork: wasPrivate,
          ...rest
        } = connection;
        const privateNetwork = parsed.data.privateNetwork ?? wasPrivate ?? false;
        const next = connectionSchema.parse({
          ...rest,
          baseUrl,
          ...(server ? { server } : {}),
          ...(privateNetwork ? { privateNetwork: true } : {}),
          credentialsRevision:
            baseUrl === connection.baseUrl
              ? connection.credentialsRevision
              : (connection.credentialsRevision ?? 0) + 1,
        });
        store.putConnection(next);
        queries.invalidate(next.id);
        registry.addConnection(next);
        integration.whenReady(next);
        return publicConnection(next);
      },
    );

    /**
     * Fire the connection's declared validation op and report pass/fail fast.
     *
     * A non-technical user cannot tell "wrong key" from "wrong scope" from
     * "their service is down" without this, and a vague failure at this step is
     * where onboarding dies.
     */
    app.post<{ Params: { id: string } }>(
      "/api/connections/:id/validate",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        // Pick up connections written straight to disk, not just ones PUT through
        // the API — otherwise the very first thing a self-hoster does (drop a JSON
        // file in connections/, then validate it) fails until the server restarts.
        registry.addConnection(connection);

        const candidates = validationCandidates(connection);
        if (candidates.length === 0) {
          return reply.status(400).send({ error: "this connection has no operations to test" });
        }

        const params: ResolvedParams = {
          range: resolveRange({ preset: "24h", now: Date.now() }),
          filters: {},
        };

        /*
         * Try candidates until one answers, rather than concluding on the first
         * refusal.
         *
         * A 403 still means the key works — that reading has not changed — but it
         * says nothing about `rowsPath`, `pagination` or `timeFilter`, and those
         * are what `verified` claims. Stopping there left an entry whose importer
         * happened to pick an unlicensed module permanently unprovable. So a
         * refusal moves to the next endpoint and only the last one gets to decide.
         */
        const forbidden: string[] = [];
        /** Endpoint-specific failures that were not refusals. */
        const refused: string[] = [];
        let lastError: AdapterError | null = null;

        for (const opId of candidates) {
          try {
            const result = await upstream(connection.id, () =>
              registry.fetch(
                connection.id,
                opId,
                {},
                {
                  params,
                  now: Date.now(),
                  resolveSecret: secretFor,
                },
              ),
            );

            const summary = Array.isArray(result.body)
              ? `${result.body.length} item(s)`
              : typeof result.body === "object" && result.body !== null
                ? `${Object.keys(result.body).length} field(s)`
                : "a value";

            /*
             * This, and only this, is what verifies a catalog entry: a live
             * response with rows where the dialect said they would be.
             */
            let verified = false;
            if (catalog && connection.catalog) {
              const entryId = catalogEntryToVerify({
                connection,
                op: getOp(connection, opId),
                body: result.body,
                entry: catalog.get(connection.catalog),
              });
              if (entryId) {
                const entry = catalog.get(entryId);
                if (entry) catalog.put({ ...entry, verified: true });
                verified = true;
              }
            }

            /*
             * Adopt the endpoint that actually worked.
             *
             * Without this the connection keeps the choice that just failed, and
             * every future validate pays the same refusals again before arriving
             * back here. Recorded rather than silent — the response names it.
             */
            const adopted = verified && connection.validateOpId !== opId;
            if (adopted) store.putConnection({ ...connection, validateOpId: opId });

            return {
              ok: true,
              message: `${connection.title} responded with ${summary}.`,
              pages: result.meta.pages,
              truncated: result.meta.truncated,
              verified,
              validatedOpId: opId,
              ...(forbidden.length > 0 ? { forbidden } : {}),
              // Endpoints that broke on the way here are worth surfacing even on
              // success: nothing else in the product will mention them.
              ...(refused.length > 0 ? { failed: refused } : {}),
              ...(adopted ? { adoptedValidateOpId: opId } : {}),
            };
          } catch (error) {
            const adapterError = error instanceof AdapterError ? error : null;
            /*
             * A 401 is the only failure that is about the *connection* rather than
             * the endpoint: the credential is wrong, so every candidate would fail
             * identically and trying them proves nothing.
             *
             * Everything else — 403, 404, 422, even a 500 — is this endpoint's
             * problem. One real API demonstrated why that distinction matters: three
             * refusals and a 422 stood between the importer's choice and the
             * endpoint that actually works, and stopping at any of them left the
             * dialect unprovable. The candidate cap is what keeps trying safe.
             */
            if (adapterError?.status === 401) {
              lastError = adapterError;
              break;
            }
            if (adapterError?.status === 403) forbidden.push(opId);
            else refused.push(opId);
            lastError = adapterError;
            continue;
          }
        }

        /*
         * Nothing answered with data. When every failure was a refusal the key is
         * still proven, so this stays a pass — the same reading as before, now
         * reached only after the alternatives are exhausted.
         */
        if (lastError?.status === 401) {
          /*
           * The adapter's own wording, not a phrase invented here: a missing key
           * and a rejected key are different diagnoses, and only the layer that
           * tried to build the request knows which one happened.
           */
          return reply.status(401).send({
            ok: false,
            error:
              lastError.userMessage ??
              `${connection.title} rejected the key. It may be wrong, expired, or revoked.`,
          });
        }
        return reply.status(lastError?.status ?? 502).send({
          ok: false,
          ...(forbidden.length > 0 ? { forbidden } : {}),
          ...(refused.length > 0 ? { failed: refused } : {}),
          tried: candidates.length,
          error: lastError?.userMessage ?? "That connection could not be reached.",
        });
      },
    );

    // ── endpoints on an existing connection ─────────────────────────────────
    //
    // Connecting an API once and then wanting a second endpoint from it is the
    // normal case, not an edge case — without these a user is back to editing
    // JSON the moment the wizard finishes.
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/ops",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const parsed = opDefSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: "invalid endpoint",
            detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          });
        }

        // Upsert, so the same route both adds a new endpoint and edits one.
        const ops = connection.ops.filter((op) => op.id !== parsed.data.id);
        const next = connectionSchema.parse({
          ...connection,
          ops: [...ops, parsed.data],
          validateOpId: connection.validateOpId ?? parsed.data.id,
        });
        store.putConnection(next);
        queries.invalidate(next.id);
        hooks.onSaved?.(next);
        registry.addConnection(next);
        return withKeyFlag(next);
      },
    );

    app.delete<{ Params: { id: string; opId: string } }>(
      "/api/connections/:id/ops/:opId",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const ops = connection.ops.filter((op) => op.id !== request.params.opId);
        if (ops.length === connection.ops.length) {
          return reply.status(404).send({ error: "no such endpoint" });
        }
        const next = connectionSchema.parse({
          ...connection,
          ops,
          validateOpId: ops.some((op) => op.id === connection.validateOpId)
            ? connection.validateOpId
            : ops[0]?.id,
        });
        store.putConnection(next);
        queries.invalidate(next.id);
        hooks.onSaved?.(next);
        registry.addConnection(next);
        return withKeyFlag(next);
      },
    );

    /** Endpoints this connection's catalog entry offers that it isn't using. */
    app.get<{ Params: { id: string } }>(
      "/api/connections/:id/available-ops",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        if (!connection.catalog || !catalog) return [];

        const entry = catalog.get(connection.catalog);
        if (!entry) return [];
        const taken = new Set(connection.ops.map((op) => op.id));
        return entry.ops.filter((op) => !taken.has(op.id));
      },
    );

    app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request) => {
      const connection = store.getConnection(request.params.id);
      // Take the secret with it — an orphaned credential in the vault is a
      // liability nobody remembers is there.
      if (connection) {
        for (const ref of [...connectionKeyRefs(connection), ...authTokenRefs(connection.auth)])
          keys.delete(ref);
        void broker.forget(connection).catch(() => undefined);
      }
      store.deleteConnection(request.params.id);
      // What was observed about it describes a connection that no longer exists.
      // Never left to reject unhandled: a damaged database must not take the process down.
      evidence
        .forget(request.params.id)
        .catch((error: unknown) =>
          app.log.warn(`evidence for ${request.params.id} could not be removed: ${String(error)}`),
        );
      // What its records held is that account's, and goes with it.
      seenValues
        .forget(request.params.id)
        .catch((error: unknown) =>
          app.log.warn(
            `the values ${request.params.id}'s records held could not be removed: ${String(error)}`,
          ),
        );
      shapes
        .forget(request.params.id)
        .catch((error: unknown) =>
          app.log.warn(
            `the shapes ${request.params.id}'s endpoints were accepted in could not be removed: ${String(error)}`,
          ),
        );
      // Its reads under way, the records they held, and its checks waiting their turn.
      jobs
        .forget(request.params.id)
        .catch((error: unknown) =>
          app.log.warn(
            `the work ${request.params.id} had under way could not be removed: ${String(error)}`,
          ),
        );
      // The report describes an API this instance can no longer reach, and
      // leaving it behind would let a same-named connection inherit a stale one.
      store.deleteReport(request.params.id);
      enumerated.delete(request.params.id);

      /* Whatever the host made for it, like an empty board, goes too. */
      await hooks.onDeleted?.(request.params.id);
      return { ok: true };
    });

    /**
     * Fetch one endpoint and describe what came back.
     *
     * This is what makes onboarding trustworthy: before anything is saved the
     * user sees real rows from their own account, not a green tick.
     */
    /*
     * What this connection can do, worked out from its own endpoints.
     *
     * Proposes and persists nothing: the report is offered, and a separate call
     * accepts it. Everything derivable is derived — the only thing a person is
     * ever asked for is a credential, because that is the one thing inspection
     * cannot produce.
     *
     * A POST because it samples: enumerating a connection makes real requests
     * against the upstream API, which a GET should not do.
     */
    /**
     * What reading this connection will cost, before a single request is made.
     *
     * A GET because it makes none: everything here is read off the endpoints. It
     * exists so the question "may we do this?" can be asked with a real number
     * attached rather than as a vague warning.
     */
    app.get<{ Params: { id: string }; Querystring: { deep?: string } }>(
      "/api/connections/:id/enumeration-plan",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const deep = request.query?.deep === "true";
        const budget: AnalyseOptions = deep ? { maxSamples: 60, maxChildSamples: 40 } : {};
        const stored = store.getReport(connection.id);

        return {
          ...estimateEnumeration(connection, budget),
          /** A matching report means this costs nothing at all right now. */
          alreadyRead: stored !== null && !isStale(stored, connection),
          stale: stored !== null && isStale(stored, connection),
          lastRead: stored?.generatedAt ?? null,
          previousOutcome: stored?.outcome ?? null,
        };
      },
    );

    app.post<{ Params: { id: string }; Body: { refresh?: boolean; deep?: boolean } }>(
      "/api/connections/:id/capabilities",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        registry.addConnection(connection);

        const budget: AnalyseOptions = request.body?.deep
          ? { maxSamples: 60, maxChildSamples: 40 }
          : {};
        const { value } = await enumerate(connection, request.body?.refresh === true, budget);
        return value;
      },
    );

    /**
     * What this connection believes about how its records relate — for free.
     *
     * Deliberately a GET that never enumerates: this is the screen someone opens
     * to check or correct a link, and opening it must not spend requests on
     * their API. It reads the stored report when there is a current one and
     * falls back to what the endpoints alone declare, so it is useful before
     * anything has been read as well as after.
     *
     * The whole resource array comes back, not just the relations, because
     * editing writes through `PUT /resources` which takes the graph entire.
     */
    app.get<{ Params: { id: string } }>(
      "/api/connections/:id/relations",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const report = store.getReport(connection.id);
        const current = report !== null && !isStale(report, connection);
        const resources = current
          ? withVerifiedParams(fromReport(report).value.resources, connection.ops)
          : analyseStructure(connection).resources;

        return {
          connection: connection.id,
          resources,
          /** Column names per resource, so a link field is picked rather than typed. */
          fieldsByResource: Object.fromEntries(
            Object.entries(report?.shapes ?? {}).map(([id, shape]) => [
              id,
              shape.fields.map((field) => field.name),
            ]),
          ),
          source: current ? "report" : report ? "stale" : "endpoints",
          lastRead: report?.generatedAt ?? null,
        };
      },
    );

    /** Accept a capabilities proposal. This is the approval step. */
    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/resources",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const parsed = z
          .object({ resources: z.array(resourceSchema).max(200) })
          .safeParse(request.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid resources", detail: parsed.error.issues });
        }

        const next = { ...connection, resources: parsed.data.resources };
        store.putConnection(next);
        queries.invalidate(next.id);
        hooks.onSaved?.(next);
        registry.addConnection(next);
        return publicConnection(next);
      },
    );

    app.post<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/sample",
      async (request, reply) => {
        const parsed = z.object({ op: z.string().min(1) }).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: "an op is required" });

        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        const op = getOp(connection, parsed.data.op);
        if (!op) return reply.status(404).send({ error: "no such operation" });
        registry.addConnection(connection);

        const result = await upstream(connection.id, () =>
          registry.fetch(
            connection.id,
            op.id,
            {},
            {
              params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters: {} },
              now: Date.now(),
              resolveSecret: secretFor,
            },
          ),
        );

        const shape = inferShape(result.body, op.rowsPath ? { rowsPath: op.rowsPath } : {});
        const rows = Array.isArray(result.body)
          ? result.body
          : shape.rowsPath === "$"
            ? [result.body]
            : [];

        return {
          rowsPath: shape.rowsPath,
          rowCount: shape.rowCount,
          schemaHash: shape.schemaHash,
          fields: shape.fields.map((field) => ({
            name: field.name,
            kinds: field.kinds,
            format: field.format ?? null,
            nullable: field.nullable,
            samples: field.samples,
          })),
          meta: result.meta,
          sample: rows.slice(0, 3),
        };
      },
    );

    /**
     * How often each of this connection's endpoints is asked again, and why.
     *
     * Free: the classification is on the catalog entry, the cadences are on
     * disk, and the whole answer is a projection of the two. Ordered so the
     * endpoints a board actually reads come first — those are the ones whose
     * freshness anybody notices, and a list of two hundred is unreadable
     * otherwise.
     */
    app.get<{ Params: { id: string } }>("/api/connections/:id/rhythm", async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const personal = rhythms.get(connection.id);
      /*
       * Read from the warm set as it stands now, not from what the keeper has
       * taken stock of: that only happens on a tick, and somebody arriving here
       * seconds after building their boards would be told nothing is kept warm.
       */
      const warmed = new Set(hooks.warmOps?.(connection.id) ?? []);

      const entities = connection.catalog ? (catalog?.get(connection.catalog)?.entities ?? []) : [];
      const nameOf = new Map<string, string>();
      for (const entity of entities) {
        for (const op of opsOfResource(connection, entity.resource)) {
          nameOf.set(op, entity.name.many);
        }
      }

      const decided = decideAll({
        ...rhythmFor(connection),
        ops: connection.ops.map((op) => op.id),
      });

      return {
        connection: connection.id,
        title: connection.title,
        tiers: personal.tiers,
        at: personal.at ?? null,
        /* Whether anybody has ever read this API for rhythm. Absent means every
         * endpoint is sitting on the default rather than on a judgement. */
        classified: Boolean(connection.catalog && catalog?.get(connection.catalog)?.rhythm),
        endpoints: decided
          .map((decision) => ({
            ...decision,
            title: connection.ops.find((op) => op.id === decision.op)?.title ?? decision.op,
            records: nameOf.get(decision.op) ?? null,
            /* On a board somebody opens, so its cadence is one they will feel. */
            warmed: warmed.has(decision.op),
          }))
          .sort((a, b) => Number(b.warmed) - Number(a.warmed) || a.op.localeCompare(b.op)),
      };
    });

    /**
     * Move one endpoint to another cadence, or put it back.
     *
     * Stored as an override on *this* connection and nowhere else: the reading
     * it disagrees with is shared with everybody who connects this API, and one
     * person's preference has no business travelling with it.
     */
    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/connections/:id/rhythm",
      async (request, reply) => {
        const parsed = z
          .object({
            /** Endpoint id → tier id, or null to go back to the classification. */
            overrides: z.record(z.string().min(1), z.string().min(1).nullable()),
          })
          .safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "an endpoint and a cadence are needed" });
        }

        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });

        const personal = rhythms.get(connection.id);
        const known = new Set(personal.tiers.map((tier) => tier.id));
        const refused: string[] = [];

        let current = personal;
        for (const [op, tier] of Object.entries(parsed.data.overrides)) {
          if (!connection.ops.some((one) => one.id === op)) {
            refused.push(`"${op}" is not an endpoint this connection carries.`);
            continue;
          }
          if (tier !== null && !known.has(tier)) {
            refused.push(`"${tier}" is not one of the cadences on offer.`);
            continue;
          }
          current = rhythms.override(connection.id, op, tier);
        }

        /* Written even when nothing moved, so "answered" is recorded and the
         * question is not asked again on the next visit. */
        if (current === personal) current = rhythms.put(connection.id, personal);
        /* A moved cadence applies at the keeper's next tick, not a few seconds on. */
        forgetTiers();

        return {
          tiers: current.tiers,
          overrides: current.overrides,
          at: current.at ?? null,
          notes: refused,
        };
      },
    );

    app.get("/api/catalog", async () => (catalog ? catalog.list().map(catalogForBrowser) : []));

    app.get<{ Params: { id: string } }>("/api/catalog/:id", async (request, reply) => {
      const entry = catalog?.get(request.params.id);
      if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
      return catalogForBrowser(entry);
    });

    /** Store a locally-derived dialect in the overlay, above the repo seed. */
    app.put<{ Params: { id: string }; Body: unknown }>(
      "/api/catalog/:id",
      async (request, reply) => {
        if (!catalog) return reply.status(501).send({ error: "no catalog configured" });
        const { writeOpCount: _count, ...body } = request.body as Record<string, unknown>;
        const parsed = catalogEntrySchema.safeParse({
          ...body,
          id: request.params.id,
        });
        if (!parsed.success) {
          return reply.status(400).send({
            error: "invalid catalog entry",
            detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          });
        }
        // The browser never holds a re-readable entry's writes, so a save from it keeps the server's.
        const kept = preservedWrites(
          catalog.get(request.params.id),
          discovered.take(request.params.id),
        );
        return catalogForBrowser(catalog.put({ ...parsed.data, ...kept }));
      },
    );

    /**
     * Create a connection from a catalog entry — the fast path that turns
     * "I want Stripe" into a working connection without anyone writing JSON.
     */
    app.post<{ Body: unknown }>("/api/connections/from-catalog", async (request, reply) => {
      if (!catalog) return reply.status(501).send({ error: "no catalog configured" });
      const parsed = z
        .object({
          catalogId: z.string().min(1),
          id: z.string().min(1).optional(),
          opIds: z.array(z.string()).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid request", detail: parsed.error.issues });
      }

      const stored = catalog.get(parsed.data.catalogId);
      if (!stored) return reply.status(404).send({ error: "no such catalog entry" });
      /*
       * An entry written by an older importer is brought up to date on how to
       * connect before a connection copies it — otherwise the connection would
       * inherit whatever the old importer got wrong about the address or the
       * login, and keep it. Only those parts; see `withConnectDetails`.
       */
      const { entry, refreshed } = await refreshOutdatedConnectDetails(stored, readDocument);
      if (refreshed) catalog.put(entry);

      /**
       * Connecting the same API twice is legitimate — two Stripe accounts, two
       * repos — so a repeat gets its own id rather than silently overwriting the
       * first connection and taking its key with it.
       */
      let id = parsed.data.id ?? entry.id;
      if (!parsed.data.id) {
        let suffix = 2;
        while (store.getConnection(id)) id = `${entry.id}-${suffix++}`;
      }

      const made = connectionFromCatalog(entry, {
        id,
        ...(parsed.data.opIds ? { opIds: parsed.data.opIds } : {}),
      });
      /* The host's own setup for a new connection, from what the request asked for. */
      const connection: ConnectionSpec = hooks.fromCatalog
        ? hooks.fromCatalog(made, request.body as Record<string, unknown>)
        : made;
      store.putConnection(connection);
      hooks.onSaved?.(connection);
      registry.addConnection(connection);
      readWritesFor(connection);
      // An API that needs no key can be checked straight away.
      integration.whenReady(connection);

      const refs = connectionKeyRefs(connection);
      const ready = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
      return {
        ...connection,
        hasKey: ready,
        needsKey: !ready,
        /* Where the API lives still has to be said — see `connectionNeedsAddress`. */
        needsAddress: connectionNeedsAddress(connection),
      };
    });
  };
