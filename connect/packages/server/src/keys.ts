import { connectionKeyRefs } from "@freebirdai/connect-spec";
import { type FastifyInstance } from "fastify";
import type { ConnectionRepository, SecretRepository } from "@freebirdai/connect/host";
import type { Engine } from "@freebirdai/connect";

/** A connection's key: saved (and the connection checked next, by itself), or forgotten. */
export interface KeyRouteDeps {
  readonly store: ConnectionRepository;
  readonly keys: SecretRepository;
  readonly broker: Engine["broker"];
  readonly queries: Engine["queries"];
  readonly integration: Engine["integration"];
}

export const keyRoutes =
  (deps: KeyRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const { store, keys, broker, queries, integration } = deps;

    app.put<{ Params: { id: string }; Body: { key?: string; keys?: Record<string, unknown> } }>(
      "/api/connections/:id/key",
      async (request, reply) => {
        const connection = store.getConnection(request.params.id);
        if (!connection) return reply.status(404).send({ error: "no such connection" });
        if (connectionKeyRefs(connection).length === 0) {
          return reply.status(400).send({ error: "this connection does not use a key" });
        }
        const refs = connectionKeyRefs(connection);

        // Multi-part auth sends { keys: { <keyRef>: value } }; the single-secret
        // styles keep the original { key } shape so nothing existing breaks.
        const supplied: Record<string, string> = {};
        if (request.body?.keys && typeof request.body.keys === "object") {
          for (const [ref, value] of Object.entries(request.body.keys)) {
            if (typeof value === "string" && value.trim()) supplied[ref] = value.trim();
          }
        } else if (typeof request.body?.key === "string" && request.body.key.trim()) {
          // Only unambiguous when there is exactly one secret to set.
          if (refs.length > 1) {
            return reply.status(400).send({
              error: `${connection.title} needs ${refs.length} separate values — send { keys: { … } }, not a single key.`,
            });
          }
          supplied[refs[0]!] = request.body.key.trim();
        }

        const missing = refs.filter((ref) => !supplied[ref] && !keys.has(ref));
        if (Object.keys(supplied).length === 0 || missing.length > 0) {
          return reply.status(400).send({
            error:
              missing.length > 0
                ? `still missing a value for: ${missing.join(", ")}`
                : "a key is required",
          });
        }

        for (const [ref, value] of Object.entries(supplied)) {
          if (refs.includes(ref)) keys.set(ref, value);
        }
        const keyed = {
          ...connection,
          credentialsRevision: (connection.credentialsRevision ?? 0) + 1,
        };
        /* A new app's values: tokens obtained with the old ones are not theirs. */
        await broker.forget(connection);
        store.putConnection(keyed);
        queries.invalidate(connection.id);
        // The key is all a person should have to give: the rest is checked by itself.
        integration.whenReady(keyed);
        // Echo only the fact that it worked. Never the key, not even truncated.
        return { ok: true, hasKey: true };
      },
    );

    app.delete<{ Params: { id: string } }>("/api/connections/:id/key", async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      for (const ref of connectionKeyRefs(connection)) keys.delete(ref);
      store.putConnection({
        ...connection,
        credentialsRevision: (connection.credentialsRevision ?? 0) + 1,
      });
      queries.invalidate(connection.id);
      return { ok: true, hasKey: false };
    });
  };
