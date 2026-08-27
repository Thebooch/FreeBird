import { isDataPart, type PartKind, type PartRegistry } from "@freebirdai/dash-parts";
import { PRESENTATION_MANIFESTS, presentationSchema } from "@freebirdai/dash-spec";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const KINDS = [
  "component",
  "presentation",
  "theme",
  "formatter",
  "resource",
  "catalog",
  "dialect",
] as const;

const kindSchema = z.enum(KINDS);

const partSchema = z.object({
  kind: kindSchema,
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "part ids must be [a-zA-Z0-9_-]"),
  title: z.string().max(120).optional(),
  description: z.string().max(400).optional(),
  /**
   * Only data parts can be written through the API.
   *
   * A code part names a module to import, and accepting one over HTTP would
   * turn this endpoint into a way to make the server load arbitrary code.
   * Code arrives on disk, put there by whoever runs the machine.
   */
  form: z.literal("data"),
  data: z.unknown(),
});

/**
 * Read and override the swappable units of the product.
 *
 * This is the seam a chat-driven editor and a hosted database plug into later:
 * both become another `PartLayer`, and nothing here changes. An override is a
 * **whole part**, so storage holds only what someone actually customised and
 * reverting is a delete rather than unwinding a patch.
 */
export const partsRoutes = (registry: PartRegistry | undefined) =>
  async (app: FastifyInstance): Promise<void> => {
    const guard = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
      if (registry) return null;
      return reply.status(400).send({ error: "this server has no part registry" });
    };

    app.get<{ Querystring: { kind?: string } }>("/api/parts", async (request, reply) => {
      const blocked = guard(reply);
      if (blocked) return blocked;

      const requested = request.query.kind;
      const kinds: readonly PartKind[] = requested
        ? kindSchema.safeParse(requested).success
          ? [requested as PartKind]
          : []
        : KINDS;

      if (requested && kinds.length === 0) {
        return reply.status(400).send({ error: `"${requested}" is not a kind of part` });
      }

      return kinds.flatMap((kind) =>
        registry!.list(kind).map((entry) => ({
          kind: entry.ref.kind,
          id: entry.ref.id,
          layer: entry.layer,
          // Drives the "customised · revert" affordance.
          customised: entry.customised,
        })),
      );
    });

    app.get<{ Params: { kind: string; id: string } }>(
      "/api/parts/:kind/:id",
      async (request, reply) => {
        const blocked = guard(reply);
        if (blocked) return blocked;

        const kind = kindSchema.safeParse(request.params.kind);
        if (!kind.success) {
          return reply.status(400).send({ error: `"${request.params.kind}" is not a kind of part` });
        }

        const resolved = registry!.resolve({ kind: kind.data, id: request.params.id });
        if (!resolved.part) {
          return reply.status(404).send({
            error: "no such part",
            // A part that exists but was refused is a different situation
            // from one that does not exist, and the caller can act on it.
            skipped: resolved.skipped,
          });
        }
        return { part: resolved.part, layer: resolved.layer, skipped: resolved.skipped };
      },
    );

    app.put<{ Params: { kind: string; id: string }; Body: unknown }>(
      "/api/parts/:kind/:id",
      async (request, reply) => {
        const blocked = guard(reply);
        if (blocked) return blocked;

        const parsed = partSchema.safeParse({
          ...(request.body as Record<string, unknown>),
          kind: request.params.kind,
          id: request.params.id,
        });
        if (!parsed.success) {
          return reply.status(400).send({ error: "invalid part", detail: parsed.error.issues });
        }

        // Built explicitly: `z.unknown()` leaves `data` optional in the
        // inferred type, and a data part without data is not one.
        const part = {
          kind: parsed.data.kind,
          id: parsed.data.id,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          form: "data" as const,
          data: parsed.data.data ?? null,
          updatedAt: new Date().toISOString(),
        };

        registry!.put(part);
        return { ok: true, layer: registry!.layerOf(part) };
      },
    );

    /**
     * Every component's look, in one call.
     *
     * The browser could read these one part at a time, but that is a request
     * per component to answer a question the registry answers in memory — and
     * it would put a copy of the layer-precedence rule in the client, where it
     * could drift. An override is a **whole part rather than a diff**, so the
     * highest layer holding one simply is the answer; there is nothing to
     * merge here, only to validate.
     */
    app.get("/api/presentation", async (_request, reply) => {
      const blocked = guard(reply);
      if (blocked) return blocked;

      const presentation: Record<string, unknown> = {};
      const invalid: Array<{ id: string; detail: string }> = [];

      for (const entry of registry!.list("presentation")) {
        const resolved = registry!.resolve(entry.ref);
        if (!resolved.part || !isDataPart(resolved.part)) continue;

        const parsed = presentationSchema.safeParse(resolved.part.data);
        if (parsed.success) {
          presentation[entry.ref.id] = parsed.data;
          continue;
        }
        /*
         * A stored override that no longer parses is reported rather than
         * dropped in silence. The component still renders — it falls back to
         * the shipped look — but someone edited this and it is not taking
         * effect, which is exactly the thing worth saying out loud.
         */
        invalid.push({
          id: entry.ref.id,
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }

      /*
       * The board-wide theme rides along on the same call.
       *
       * It is a different part kind, but the client needs both before it can
       * paint anything, and two round trips to decide what colour to be is one
       * more than the page can afford.
       */
      const themePart = registry!.resolve({ kind: "theme", id: "default" });
      const theme =
        themePart.part && isDataPart(themePart.part)
          ? (presentationSchema.safeParse(themePart.part.data).data?.tokens ?? {})
          : {};

      return { presentation, invalid, theme, manifests: PRESENTATION_MANIFESTS };
    });

    app.delete<{ Params: { kind: string; id: string } }>(
      "/api/parts/:kind/:id",
      async (request, reply) => {
        const blocked = guard(reply);
        if (blocked) return blocked;

        const kind = kindSchema.safeParse(request.params.kind);
        if (!kind.success) {
          return reply.status(400).send({ error: `"${request.params.kind}" is not a kind of part` });
        }

        const ref = { kind: kind.data, id: request.params.id };
        registry!.revert(ref);
        // Whatever is underneath now answers — usually the shipped default.
        return { ok: true, layer: registry!.layerOf(ref) };
      },
    );
  };
