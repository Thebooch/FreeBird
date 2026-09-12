import { AdapterError, RestAdapter, GraphqlAdapter, type HttpFetch, type GraphqlHttpFetch } from "@freebirdai/dash-adapters";
import { extractRows, parsePath } from "@freebirdai/dash-expr";
import { resolveOp, resolveRange, fingerprintConnection, queryKey } from "@freebirdai/dash-spec";
import type { SpecStore } from "../store.js";
import type { KeyStore } from "../vault.js";
import { splitOpInputs } from "../query.js";
import { QueryCache } from "../cache/queryCache.js";
import type { IntegrationRepository } from "./repository.js";
import { IntegrationReadError, IntegrationReadSession } from "./read.js";
import type { IntegrationScope } from "./routes.js";

/** Temporary bridge to existing connections. Requests execute the pinned operation contract. */
export const integrationSessions = (options: {
  repository: IntegrationRepository; store: SpecStore; keys: KeyStore; http: HttpFetch; graphqlHttp: GraphqlHttpFetch;
}) => {
  const cache = new QueryCache();
  const adapter = new RestAdapter(options.http);
  const graphql = new GraphqlAdapter(options.graphqlHttp);
  const load = async (tenant: string, connection: string) => {
    const saved = await options.repository.getBinding(tenant, connection);
    if (!saved) return null;
    const definition = await options.repository.getVersion(saved.owner, saved.binding.integration, saved.binding.version);
    return definition ? { definition, binding: saved.binding } : null;
  };
  return (scope: IntegrationScope) => new IntegrationReadSession({
    load,
    authorize: async (_context, connection, _entity, op) => scope.connections.includes(connection)
      && Boolean(options.store.getConnection(connection)?.ops.some(item => item.id === op)),
    fetch: async (context, connectionId, opId, supplied, maxRows) => {
      const connection = options.store.getConnection(connectionId);
      const loaded = await load(context.tenant, connectionId);
      const declared = loaded?.definition.operations.find(item => item.id === opId);
      const local = connection?.ops.find(item => item.id === opId);
      if (!connection || !loaded || !declared || !local) throw new IntegrationReadError("missing", "This operation is not available on this connection.");
      if (connection.kind !== loaded.definition.protocol || (connection.kind !== "rest" && connection.kind !== "graphql")) throw new IntegrationReadError("unsupported", "This integration protocol is not connected to the read service yet.");
      // Never inherit a date range merely because this is a collection. Entity reads
      // use explicit declared inputs. One page makes the interaction's call bound exact.
      const op = resolveOp({ ...connection, dialect: undefined }, { ...declared, auth: local.auth, authRequired: local.authRequired, maxPages: 1, timeFiltered: false });
      if (Object.values(op.query).some(value => typeof value === "string" && value.includes("{{range."))) throw new IntegrationReadError("unsupported", "This operation requires an explicit date range.");
      const { overrides, inputs } = splitOpInputs(op, { ...loaded.binding.context, ...supplied });
      const now = Date.now();
      const params = { range: resolveRange({ preset: "30d", now: 0 }), filters: inputs };
      const key = `integration:${context.tenant}:${context.authorizationRevision}:${loaded.definition.version}:${fingerprintConnection(connection)}:${maxRows}:${queryKey(connectionId, opId, overrides, params)}`;
      try {
        const result = await cache.read({ key, connection: connectionId, maxAgeMs: 30000, fetcher: () => (connection.kind === "graphql" ? graphql : adapter).fetch({ ...connection, graphqlSchema: loaded.definition.graphqlSchema ?? connection.graphqlSchema }, op, overrides, { params, now, signal: context.signal, resolveSecret: async ref => options.keys.get(ref) }) });
        const rows = extractRows(parsePath(op.rowsPath ?? "$"), result.body).filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row));
        return {
          rows: rows.slice(0, maxRows),
          completeness: rows.length <= maxRows && result.meta.completeness ? result.meta.completeness : {
            status: result.meta.truncated || rows.length > maxRows ? "partial" as const : "unknown" as const,
            scope: "loaded-records" as const,
            reason: result.meta.truncated || rows.length > maxRows ? "The bounded read may not include every related record." : "The response was read; completeness has not been independently verified.",
          },
        };
      } catch (error) {
        if (error instanceof AdapterError && (error.status === 401 || error.status === 403)) throw new IntegrationReadError("denied", error.userMessage);
        throw error;
      }
    },
  }, { tenant: scope.tenant, authorizationRevision: scope.authorizationRevision, maxRequests: 20, maxRows: 100 });
};
