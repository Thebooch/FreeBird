import type { LlmAdapter } from "@freebirdai/dash-agent";
import { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AUTO_INDEX_PAGES,
  catalogForBrowser,
  discover,
  Discovered,
  fetchPublicDocument,
  nodeHttp,
  readIndex,
} from "@freebirdai/connect/host";
import type { SearchProvider } from "@freebirdai/connect/host";
import { RENDERER_DOWNLOAD_MB, type RendererStatus } from "@freebirdai/connect-browser";
import type { BuildServerOptions } from "../server.js";

/** Finding an API from what somebody typed: the discovery ladder, a documentation section read page by page, and the browser that reads documentation drawn by scripts. */
export interface DiscoverRouteDeps {
  readonly options: Pick<BuildServerOptions, "catalog" | "renderDocs" | "http" | "rendererSetup">;
  /** Write endpoints discovery read, held until their entry is adopted. */
  readonly discovered: Discovered;
  readonly resolveLlm: (label?: string) => LlmAdapter | null;
  readonly resolveSearch: () => SearchProvider | null;
}

export const discoverRoutes =
  (deps: DiscoverRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const { options, discovered, resolveLlm, resolveSearch } = deps;

    /**
     * Walk the discovery ladder for a URL the user typed.
     *
     * Returns a *proposal* whatever rung answers. Nothing here is saved and
     * nothing is marked verified — the oracle is the validate-and-sample step,
     * because documentation lies and a live 200 does not.
     */
    app.post<{ Body: unknown }>("/api/discover", async (request, reply) => {
      const parsed = z.object({ url: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "a url is required" });

      const result = await discover(parsed.data.url, {
        fetchDocument: async (url) => {
          const response = await fetchPublicDocument(url);
          return { status: response.status, text: response.text, url: response.url };
        },
        catalog: options.catalog,
        llm: resolveLlm("discover"),
        search: resolveSearch(),
        /* A small section is read by itself when nothing else answered; a large one is still offered. */
        readIndexUpTo: AUTO_INDEX_PAGES,
        ...(options.renderDocs ? { renderDocs: options.renderDocs } : {}),
        http: options.http ?? nodeHttp,
      });

      if (result.entry) discovered.hold(result.entry);
      return result.entry ? { ...result, entry: catalogForBrowser(result.entry) } : result;
    });

    /*
     * The browser that reads documentation drawn by scripts: whether it is
     * here, and the one-time download, started only when the person agrees.
     * Under `/api/discover`, so only somebody who may add connections starts it.
     */
    app.get(
      "/api/discover/renderer",
      async (): Promise<RendererStatus> =>
        options.rendererSetup?.status() ?? {
          state: options.renderDocs ? "ready" : "off",
          consented: true,
          downloadMb: RENDERER_DOWNLOAD_MB,
        },
    );
    app.post("/api/discover/renderer", async (_request, reply) => {
      if (!options.rendererSetup)
        return reply.status(404).send({ error: "Nothing here downloads a browser." });
      return options.rendererSetup.install();
    });

    /**
     * Read every documented page in a section and merge what they declare.
     *
     * Separate from `/api/discover` on purpose: one request per page against
     * somebody else's documentation site is not something to do speculatively.
     * The discovery result reports the page count and the time it would take,
     * and this runs only once a person has seen those numbers and asked.
     */
    app.post<{ Body: unknown }>("/api/discover/read-index", async (request, reply) => {
      const parsed = z.object({ url: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "a url is required" });

      const result = await readIndex(parsed.data.url, {
        fetchDocument: async (url) => {
          const response = await fetchPublicDocument(url);
          return { status: response.status, text: response.text, url: response.url };
        },
        catalog: options.catalog,
      });
      if (result.entry) discovered.hold(result.entry);
      return result.entry ? { ...result, entry: catalogForBrowser(result.entry) } : result;
    });

    /*
     * There is no `/api/agent/propose`.
     *
     * It backed a drawer that took an endpoint and had a model propose a binding
     * from a live sample. The concierge does the same job from the capability
     * report — no extra request, and a conversation instead of a one-shot — so
     * the drawer and this route went together. `proposeWidget` stays exported
     * from `@freebirdai/dash-agent` for anyone building on the package.
     */
  };
