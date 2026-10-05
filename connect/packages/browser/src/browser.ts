import { looksLikeOpenApi, parseSpecDocument, sameSite } from "@freebirdai/connect/host";
import type { DocsRenderer } from "@freebirdai/connect/host";
import type { RendererReadiness, RendererTooling } from "./tooling.js";

/**
 * A documentation page drawn by its own scripts, drawn here so it can be
 * read.
 *
 * Playwright's own Chromium, headless, a fresh context each time with nothing
 * kept. Every request the page makes is answered through the server's own
 * document reader — public addresses only, the SSRF guard, its size and time
 * limits — never by the browser's network: the browser asks, this decides.
 * Only reads (GET) go; downloads, pop-ups, WebSockets, images, fonts and media
 * never do. The page may move only within its own site, a few times, and the
 * whole of it is bounded in requests, bytes and seconds.
 *
 * What comes back is the page as drawn, its address, and any specification
 * the page fetched to draw itself — what Redoc, Swagger UI and their kind
 * do, and never link to. Discovery reads those first, then the page as it
 * reads any: a specification it links to, one it holds, or its prose.
 */

/** One answer to a request the page made: what the server's own reader got. */
export interface RenderedFetch {
  readonly status: number;
  readonly text: string;
  readonly url: string;
  readonly contentType: string | null;
}

export interface BrowserRendererOptions {
  readonly tooling: RendererTooling;
  /** Every request the page makes, through the guarded document reader. */
  readonly fetch: (url: string) => Promise<RenderedFetch>;
  /** The whole of one render, in milliseconds. */
  readonly timeoutMs?: number;
  readonly maxRequests?: number;
  readonly maxBytes?: number;
  /** How many times the page may move to another address on its own site. */
  readonly maxNavigations?: number;
  readonly log?: (line: string) => void;
}

const TIMEOUT_MS = 15_000;
const MAX_REQUESTS = 80;
const MAX_BYTES = 20_000_000;
const MAX_NAVIGATIONS = 3;
/** What a documentation page needs to draw itself; nothing else is fetched. */
const FETCHED = new Set(["document", "script", "stylesheet", "xhr", "fetch"]);

const TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.m?js(\?|$)/i, "text/javascript"],
  [/\.css(\?|$)/i, "text/css"],
  [/\.json(\?|$)/i, "application/json"],
  [/\.ya?ml(\?|$)/i, "text/yaml"],
];

const typeOf = (answer: RenderedFetch, resourceType: string): string =>
  answer.contentType ??
  TYPES.find(([pattern]) => pattern.test(answer.url))?.[1] ??
  (resourceType === "script" ? "text/javascript" : resourceType === "stylesheet" ? "text/css" : "text/html");

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

export class BrowserDocsRenderer implements DocsRenderer {
  constructor(private readonly options: BrowserRendererOptions) {}

  ready(): Promise<RendererReadiness> {
    return this.options.tooling.readiness();
  }

  async render(url: string): Promise<{ readonly html: string; readonly url: string; readonly specs: readonly string[] } | null> {
    const home = hostOf(url);
    if (!home) return null;
    const browser = await this.options.tooling.launch();
    if (!browser) return null;
    const started = Date.now();
    const timeout = this.options.timeoutMs ?? TIMEOUT_MS;
    let requests = 0;
    let bytes = 0;
    let navigations = 0;
    /* Specifications the page fetched for itself, in the order it asked. */
    const specs: string[] = [];
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          const target = request.url();
          const host = hostOf(target);
          const refuse = () => route.abort("blockedbyclient").catch(() => undefined);
          if (!host || !/^https?:$/i.test(new URL(target).protocol) || request.method() !== "GET") return refuse();
          if (!FETCHED.has(request.resourceType())) return refuse();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            if (!sameSite(host, home) || ++navigations > (this.options.maxNavigations ?? MAX_NAVIGATIONS) + 1) return refuse();
          }
          if (++requests > (this.options.maxRequests ?? MAX_REQUESTS)) return refuse();
          let answer: RenderedFetch;
          try {
            answer = await this.options.fetch(target);
          } catch {
            return refuse();
          }
          bytes += answer.text.length;
          if (bytes > (this.options.maxBytes ?? MAX_BYTES)) return refuse();
          if (
            answer.status < 400 &&
            (request.resourceType() === "fetch" || request.resourceType() === "xhr") &&
            /openapi|swagger/i.test(answer.text.slice(0, 2_000)) &&
            looksLikeOpenApi(parseSpecDocument(answer.text)) &&
            !specs.includes(answer.url)
          )
            specs.push(answer.url);
          await route
            .fulfill({ status: answer.status, body: answer.text, headers: { "content-type": typeOf(answer, request.resourceType()) } })
            .catch(() => undefined);
        });
        /* A WebSocket is not a read: closed as it opens. */
        await context.routeWebSocket(/.*/, (socket) => socket.close()).catch(() => undefined);
        const page = await context.newPage();
        /* Anything the page opens besides itself is closed; anything it offers to save is refused. */
        context.on("page", (other) => {
          if (other !== page) void other.close().catch(() => undefined);
        });
        page.on("download", (download) => void download.cancel().catch(() => undefined));
        await page.goto(url, { waitUntil: "load", timeout });
        /* Drawn once its own requests settle, or when the time is up — whichever is first. */
        await page.waitForLoadState("networkidle", { timeout: Math.max(1_000, timeout - (Date.now() - started)) }).catch(() => undefined);
        const html = await page.content();
        this.options.log?.(`drew ${url} in ${Date.now() - started} ms: ${requests} request(s)${specs.length > 0 ? `, ${specs.length} specification(s) fetched` : ""}`);
        return { html, url: page.url(), specs };
      } finally {
        await context.close().catch(() => undefined);
      }
    } catch (error) {
      this.options.log?.(`could not draw ${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
