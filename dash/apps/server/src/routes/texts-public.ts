import { normalizePhone } from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ContactService } from "../contacts/service.js";
import { optInScript, textPages } from "../phone/pages.js";
import type { RateLimiter } from "../public/limits.js";

/**
 * The opt-in form, privacy section and messaging terms Dash hosts for a
 * workspace (Dash Phone, Phase 2), with no sign-in:
 *
 * - `GET /api/public/:workspace/texts`: the pages' words, for the public web
 *   pages at `/p/<workspace>/texts` (`/privacy`, `/terms`).
 * - `POST /api/public/:workspace/texts/opt-in`: someone ticked the box.
 *   Kept as consent with the exact words shown (`opt_in_form`), for the
 *   number they typed. Open to other origins, so the same form works on the
 *   business's own site.
 * - `GET /api/public/:workspace/texts/opt-in.js`: that form as a script for
 *   the business's own site (`<div data-dash-texts></div>`), which the
 *   WordPress plugin's `[dash_text_optin]` shortcode also places.
 *
 * Rate limited per address; a filled honeypot is refused.
 */

export interface TextsPublicDeps {
  readonly workspace: string;
  readonly limiter: RateLimiter;
  readonly contacts: Pick<ContactService, "findOrCreate" | "giveTextConsent">;
  readonly brand: () => Promise<{ readonly name: string; readonly accent: string }>;
  /** Where the web pages live (`/p/<workspace>/texts`) and the API answers. */
  readonly pagesOrigin: () => string;
  readonly apiOrigin: (request: FastifyRequest) => string;
}

const LIMITS = { read: 120, write: 10 } as const;

export const textsPublicRoutes = (deps: TextsPublicDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const open = { config: { public: true } } as const;
    const cors = (reply: FastifyReply) => reply.header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Methods", "POST, OPTIONS").header("Access-Control-Allow-Headers", "content-type").header("Vary", "Origin");

    app.addHook("onRequest", async (request, reply) => {
      const post = request.method === "POST";
      if (!deps.limiter.take(`texts:${post ? "write" : "read"}:${request.ip}`, post ? LIMITS.write : LIMITS.read)) {
        return cors(reply).status(429).header("Retry-After", "60").send({ error: "Too many requests. Wait a minute, then try again." });
      }
      if ((request.params as { workspace?: string } | undefined)?.workspace !== deps.workspace) return reply.status(404).send({ error: "Not found." });
      return undefined;
    });

    app.get("/api/public/:workspace/texts", open, async () => {
      const brand = await deps.brand();
      return { workspace: { name: brand.name, accent: brand.accent }, ...textPages(brand.name) };
    });

    app.options("/api/public/:workspace/texts/opt-in", open, async (_request, reply) => cors(reply).status(204).send());

    app.post("/api/public/:workspace/texts/opt-in", open, async (request, reply) => {
      cors(reply);
      const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
      if (typeof body["website"] === "string" && body["website"].trim()) return reply.status(400).send({ error: "That couldn't be sent. Reload the page and try again." });
      if (body["consent"] !== true) return reply.status(400).send({ error: "Tick the box to agree to texts." });
      const phone = normalizePhone(typeof body["phone"] === "string" ? body["phone"] : "");
      if (!phone) return reply.status(400).send({ error: "Give a mobile number with its area code." });
      const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, 120) : "";
      const business = (await deps.brand()).name;
      /* Found by the number they typed, or made; consent is for that number only. */
      const contact = await deps.contacts.findOrCreate({ phone, ...(name ? { name } : {}), origin: "public_link", unverified: true });
      if (!contact.phones.includes(phone)) return reply.status(409).send({ error: "That number couldn't be signed up here. Reply to a text from us instead." });
      await deps.contacts.giveTextConsent(contact.id, { source: "opt_in_form", wording: textPages(business).wording, phone });
      return { signedUp: true };
    });

    app.get("/api/public/:workspace/texts/opt-in.js", open, async (request, reply) => {
      const business = (await deps.brand()).name;
      const pages = `${deps.pagesOrigin()}/p/${encodeURIComponent(deps.workspace)}/texts`;
      const script = optInScript(`${deps.apiOrigin(request)}/api/public/${encodeURIComponent(deps.workspace)}/texts/opt-in`, textPages(business), { privacy: `${pages}/privacy`, terms: `${pages}/terms` });
      return reply.type("text/javascript; charset=utf-8").header("Cache-Control", "public, max-age=300").send(script);
    });
  };
