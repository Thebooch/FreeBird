import {
  AdapterError,
  RestAdapter,
  GraphqlAdapter,
  type HttpFetch,
  type GraphqlHttpFetch,
} from "@freebirdai/dash-adapters";
import { evalPath, parsePath } from "@freebirdai/dash-expr";
import { resolveOp, resolveRange, fingerprintConnection, queryKey } from "@freebirdai/dash-spec";
import type { SpecStore } from "../store.js";
import type { KeyStore } from "../vault.js";
import { splitOpInputs } from "../query.js";
import { QueryCache } from "../cache/queryCache.js";
import { integrationFingerprint, type IntegrationRepository } from "./repository.js";
import { IntegrationReadError, IntegrationReadSession, type IntegrationReadDeps } from "./read.js";
import type { IntegrationScope } from "./routes.js";

/** Missing extraction paths and non-record results are contract failures, not
 * empty collections. Empty arrays remain valid at every declared wildcard.
 */
export const extractIntegrationRows = (body: unknown, path: string): Record<string, unknown>[] => {
  const ast = parsePath(path);
  let matches: unknown[] = [body];
  for (const segment of ast.segments) {
    matches = matches.flatMap((value) => {
      const next = evalPath({ source: path, segments: [segment] }, value);
      if (
        !next.length &&
        !(
          segment.kind === "wildcard" &&
          value !== null &&
          typeof value === "object" &&
          Object.keys(value).length === 0
        )
      )
        throw new IntegrationReadError(
          "invalid",
          "The response no longer matches this integration's record path.",
        );
      return next;
    });
  }
  const rows = matches.length === 1 && Array.isArray(matches[0]) ? matches[0] : matches;
  if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row)))
    throw new IntegrationReadError(
      "invalid",
      "The response contains values where this integration requires records.",
    );
  return rows as Record<string, unknown>[];
};

/** Temporary bridge to existing connections. Requests execute the pinned operation contract. */
export const integrationReadDependencies = (options: {
  repository: IntegrationRepository;
  store: SpecStore;
  keys: KeyStore;
  http: HttpFetch;
  graphqlHttp: GraphqlHttpFetch;
}) => {
  const cache = new QueryCache();
  const adapter = new RestAdapter(options.http);
  const graphql = new GraphqlAdapter(options.graphqlHttp);
  const load = async (tenant: string, connection: string) => {
    const saved = await options.repository.getBinding(tenant, connection);
    if (!saved) return null;
    const definition = await options.repository.getVersion(
      saved.owner,
      saved.binding.integration,
      saved.binding.version,
    );
    return definition ? { definition, binding: saved.binding } : null;
  };
  return (scope: IntegrationScope, fresh = false): IntegrationReadDeps => ({
    load,
    authorize: async (_context, connection, _entity, op) =>
      scope.connections.includes(connection) &&
      Boolean(options.store.getConnection(connection)?.ops.some((item) => item.id === op)),
    fetch: async (context, connectionId, opId, supplied, maxRows) => {
      const connection = options.store.getConnection(connectionId);
      const loaded = await load(context.tenant, connectionId);
      const declared = loaded?.definition.operations.find((item) => item.id === opId);
      const local = connection?.ops.find((item) => item.id === opId);
      if (!connection || !loaded || !declared || !local)
        throw new IntegrationReadError(
          "missing",
          "This operation is not available on this connection.",
        );
      if (
        !context.binding ||
        context.binding.integration !== loaded.binding.integration ||
        context.binding.version !== loaded.binding.version ||
        context.binding.revision !== loaded.binding.revision
      ) {
        throw new IntegrationReadError(
          "unsupported",
          "The connection changed during this read. Reload to use its current integration.",
        );
      }
      if (
        connection.kind !== loaded.definition.protocol ||
        (connection.kind !== "rest" && connection.kind !== "graphql")
      )
        throw new IntegrationReadError(
          "unsupported",
          "This integration protocol is not connected to the read service yet.",
        );
      // Never inherit a date range merely because this is a collection. Entity reads
      // use explicit declared inputs. One page makes the interaction's call bound exact.
      const op = resolveOp(
        { ...connection, dialect: undefined },
        {
          ...declared,
          auth: local.auth,
          authRequired: local.authRequired,
          maxPages: 1,
          timeFiltered: false,
        },
      );
      if (
        Object.values(op.query).some(
          (value) => typeof value === "string" && value.includes("{{range."),
        )
      )
        throw new IntegrationReadError(
          "unsupported",
          "This operation requires an explicit date range.",
        );
      const { overrides, inputs } = splitOpInputs(op, { ...loaded.binding.context, ...supplied });
      const now = Date.now();
      const params = { range: resolveRange({ preset: "30d", now: 0 }), filters: inputs };
      const key = `integration:${integrationFingerprint({ tenant: context.tenant, authorization: context.authorizationRevision, binding: loaded.binding, operation: op })}:${fingerprintConnection(connection)}:${maxRows}:${queryKey(connectionId, opId, overrides, params)}`;
      try {
        const fetcher = () =>
          (connection.kind === "graphql" ? graphql : adapter).fetch(
            {
              ...connection,
              graphqlSchema: loaded.definition.graphqlSchema ?? connection.graphqlSchema,
            },
            op,
            overrides,
            {
              params,
              now,
              signal: context.signal,
              resolveSecret: async (ref) => options.keys.get(ref),
            },
          );
        const result = fresh
          ? await fetcher()
          : await cache.read({ key, connection: connectionId, maxAgeMs: 30000, fetcher });
        const rows = extractIntegrationRows(result.body, op.rowsPath ?? "$");
        return {
          rows: rows.slice(0, maxRows),
          completeness:
            rows.length <= maxRows && result.meta.completeness
              ? result.meta.completeness
              : {
                  status:
                    result.meta.truncated || rows.length > maxRows
                      ? ("partial" as const)
                      : ("unknown" as const),
                  scope: "loaded-records" as const,
                  reason:
                    result.meta.truncated || rows.length > maxRows
                      ? "The bounded read may not include every related record."
                      : "The response was read; completeness has not been independently verified.",
                },
        };
      } catch (error) {
        if (error instanceof AdapterError && (error.status === 401 || error.status === 403))
          throw new IntegrationReadError("denied", error.userMessage);
        if (
          error instanceof AdapterError &&
          [404, 410].includes(error.upstreamStatus ?? error.status)
        )
          throw new IntegrationReadError(
            "missing",
            "The requested record or endpoint is no longer available.",
          );
        throw error;
      }
    },
  });
};

export const integrationSessions = (options: Parameters<typeof integrationReadDependencies>[0]) => {
  const dependencies = integrationReadDependencies(options);
  return (scope: IntegrationScope) =>
    new IntegrationReadSession(dependencies(scope), {
      tenant: scope.tenant,
      authorizationRevision: scope.authorizationRevision,
      maxRequests: 20,
      maxRows: 100,
    });
};
