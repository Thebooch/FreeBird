import type { FastifyInstance } from "fastify";
import type { RawRequest } from "@freebirdai/phone";
import type { RateLimiter } from "../public/limits.js";
import { receivePhoneWebhook, type PhoneWebhookDeps } from "../phone/webhook.js";

/**
 * `POST /api/public/:workspace/phone/:line/:event`: a phone provider's
 * webhooks for one line (`event` is `text` or `status`). Public, like the
 * booking pages' API: the provider's signature is the authority, checked by
 * the line's adapter (`phone/webhook.ts`).
 *
 * The body is never parsed here. This plugin has its own scope with one
 * content-type parser that keeps the body as the exact string received, so
 * the adapter's `verify` sees the bytes the provider signed before anything
 * reads them.
 */

export interface PhoneHookDeps {
  readonly workspace: string;
  readonly limiter: RateLimiter;
  /** The address providers call, as they sign it. Absent: the request's own. */
  readonly publicOrigin?: string;
  readonly webhook: PhoneWebhookDeps;
}

/** Carriers send in bursts: generous per address, but bounded. */
const PER_MINUTE = 600;
const BODY_LIMIT = 256 * 1024;

export const phoneHookRoutes = (deps: PhoneHookDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string", bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

    app.addHook("onRequest", async (request, reply) => {
      if (!deps.limiter.take(`phone:${request.ip}`, PER_MINUTE)) return reply.status(429).header("Retry-After", "60").send({ error: "Too many requests. Wait a minute, then try again." });
      if ((request.params as { workspace?: string } | undefined)?.workspace !== deps.workspace) return reply.status(404).send({ error: "Not found." });
      return undefined;
    });

    app.post<{ Params: { workspace: string; line: string; event: string } }>("/api/public/:workspace/phone/:line/:event", { config: { public: true } }, async (request, reply) => {
      const origin = (deps.publicOrigin ?? `${request.protocol}://${request.host}`).replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
      const raw: RawRequest = { method: request.method, url: `${origin}${request.url}`, headers, body: typeof request.body === "string" ? request.body : "" };
      const answer = await receivePhoneWebhook(deps.webhook, request.params.line, request.params.event, raw);
      if (answer.status !== 200) return reply.status(answer.status).send({ error: answer.error });
      return reply.status(200).type("text/plain").send("");
    });
  };
