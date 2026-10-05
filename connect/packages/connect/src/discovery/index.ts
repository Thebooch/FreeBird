import type { HttpFetch } from "../adapters/index.js";
import type { LlmAdapter } from "../agent/index.js";
import type { CatalogEntry } from "@freebirdai/connect-spec";
import type { z } from "zod";
import type { CatalogStore } from "../catalog.js";
import { analysePage, endpointsNamed, rankContext } from "./docs.js";
import { refreshOutdatedConnectDetails } from "./connect-details.js";
import { resolveExternalRefs } from "./external-refs.js";
import { extractInlineSpec } from "./inline-spec.js";
import { withGraphqlReads } from "./graphql.js";
import { withOidc } from "./oidc.js";
import { discoverMcp, looksLikeMcpAddress } from "../mcp/discover.js";
import { looksLikeWsdl, parseWsdl } from "./wsdl.js";
import {
  WELL_KNOWN_SPEC_PATHS,
  indexLinksIn,
  looksLikeOpenApi,
  parseOpenApi,
  parseSpecDocument,
  specLinksIn,
} from "./openapi.js";
import { paceGapMs } from "../capabilities.js";
import { type SpecFragment, mergeSpecDocuments } from "./merge-specs.js";
import { proposeDialect } from "./propose-dialect.js";
import { type SearchProvider, buildSearchQueries, rankSearchResults } from "./search.js";
import { RENDERER_DOWNLOAD_MB } from "./render/tooling.js";

export type DiscoverySource = "catalog" | "openapi" | "wsdl" | "docs" | "mcp" | "none";

export interface DiscoveryResult {
  readonly source: DiscoverySource;
  readonly entry: CatalogEntry | null;
  /** How the answer was reached, in one line, for the user to see. */
  readonly note: string;
  readonly warnings: readonly string[];
  /** Every URL that was fetched, so the path taken is auditable. */
  readonly tried: readonly string[];
  /** True when a web search was used to find the candidate. */
  readonly viaSearch?: boolean;
  /**
   * A machine-readable page index this site publishes, when one was found.
   *
   * Costs nothing to report — the ladder already fetched it looking for spec
   * links. Its value is for the sites that list no spec at all: their API is
   * still fully documented, one fragment per page, and this is what makes
   * reading the lot an offer we can price before spending anything.
   */
  readonly index?: DocsIndex;
  /**
   * The documentation is drawn by its own scripts, and the browser that reads
   * it is not here yet: the person is asked once whether to fetch it, and
   * discovery runs again once it is here.
   */
  readonly needsRenderer?: boolean;
}

export interface DocsIndex {
  readonly url: string;
  /** The path prefix the pages were scoped to — the submitted URL's section. */
  readonly section: string;
  readonly pages: number;
  readonly estimatedMs: number;
}

export interface DiscoveryDeps {
  /** SSRF-guarded, no host allowlist — there is no connection yet. */
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly catalog?: CatalogStore | undefined;
  readonly llm?: LlmAdapter | null | undefined;
  readonly search?: SearchProvider | null | undefined;
  /**
   * When nothing else answered, read a documentation section page by page by
   * itself, if it has no more pages than this. Absent, the read is offered
   * and a person decides. The product sets it: somebody who gives a docs link
   * expects the API found, not a count of pages to approve.
   */
  readonly readIndexUpTo?: number | undefined;
  /**
   * Draws a documentation page that is rendered in the browser, so its text
   * can be read. A plug-in point: absent locally, where such a page is said
   * to be unreadable; a hosted build supplies a rendering service. It must
   * reach public addresses only, as every other reader here does.
   */
  readonly renderDocs?: DocsRenderer | undefined;
  /**
   * For asking an address whether it is an MCP server: that is a POST, which
   * a documentation reader never sends. Absent, the question is not asked.
   */
  readonly http?: HttpFetch | undefined;
}

/** See `DiscoveryDeps.renderDocs`. */
export interface DocsRenderer {
  /**
   * Whether a page can be drawn now: `needs-install` while the browser is not
   * here yet and the person has not agreed to fetch it. Absent: always ready.
   */
  ready?(): Promise<"ready" | "needs-install" | "unavailable">;
  /**
   * The page as a browser draws it, or null when it could not be drawn — with
   * any specification the page fetched to draw itself.
   */
  render(url: string): Promise<{ readonly html: string; readonly url: string; readonly specs?: readonly string[] } | null>;
}

/** A documentation section small enough to read by itself when nothing else answered. */
export const AUTO_INDEX_PAGES = 60;

/**
 * One key, not two. Rung 3 already needs an AI key, and search rides on the
 * same one — so there is never a second vendor to go sign up with.
 */
const SEARCH_KEY_HINT = "Set an AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY)";

/**
 * Hosts that describe how to write an API, and are therefore never one.
 *
 * These rank superbly for any spec-shaped search — the OpenAPI specification
 * page is wall-to-wall `openapi:`, `paths:` and `servers:` — and what a model
 * dutifully extracts from them is the Petstore example. Searching for a small
 * API once returned `api.gigantic-server.com`, the spec's own illustration.
 */
const META_SPEC_HOSTS = [
  "spec.openapis.org",
  "swagger.io",
  "json-schema.org",
  "openapis.org",
  "opensource.org",
  "rfc-editor.org",
  "ietf.org",
  "w3.org",
];

export const isMetaSpecHost = (url: string): boolean => {
  const host = hostOf(url);
  if (!host) return false;
  return META_SPEC_HOSTS.some((meta) => host === meta || host.endsWith(`.${meta}`));
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** `docs.dog.ceo` and `dog.ceo` are the same organisation; apify.com is not. */
// Only strip well-known service prefixes. A public suffix such as co.uk
// must never make two unrelated vendors appear to be the same organisation.
const rootDomainOf = (host: string): string =>
  host.replace(/^(?:(?:www|api|docs|developer|developers)\.)+/, "");

const sameOrganisation = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && rootDomainOf(a) === rootDomainOf(b);

/** Is this input a URL, or the name of a product to go looking for? */
const asUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare domain is still a URL; anything with a space is a search term.
  if (!/\s/.test(trimmed) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
};

/** A catalog hit is only a hit if it is for the *same* API. */
const catalogMatch = (catalog: CatalogStore | undefined, input: string): CatalogEntry | null => {
  if (!catalog) return null;
  const entries = catalog.list();

  const host = hostOf(asUrl(input) ?? "");
  if (host) {
    const byHost = entries.find((entry) => {
      const entryHost = hostOf(entry.baseUrl);
      if (!entryHost) return false;
      return sameOrganisation(entryHost, host);
    });
    if (byHost) return byHost;
  }

  // Typing "Stripe" should find Stripe.
  const term = input.trim().toLowerCase();
  if (term.length >= 3) {
    return entries.find((entry) => entry.title.toLowerCase() === term || entry.id === term) ?? null;
  }
  return null;
};

/**
 * How long a page fetch waits behind the one before it.
 *
 * `paceGapMs` targets a fixed five-second *total*, which is right for the two
 * dozen requests an enumeration makes and badly wrong here: 434 pages would
 * go out at a 12ms gap, which is the burst that pacing exists to prevent.
 * Passing `pages * INDEX_READ_GAP_MS` as the target turns the same helper
 * into a steady floor — one implementation, two policies.
 */
export const INDEX_READ_GAP_MS = 120;

export const indexReadGap = (pages: number): number => paceGapMs(pages, pages * INDEX_READ_GAP_MS);

/**
 * How long reading a section will really take.
 *
 * The gap alone is not the answer, and saying so was actively misleading:
 * twelve HubSpot pages were predicted at 1.4s and took 21s, because each page
 * is tens of kilobytes of Markdown that takes well over a second to arrive.
 * An estimate a person consents to has to include the requests themselves,
 * so the caller measures one real fetch and passes it in.
 */
export const DEFAULT_PAGE_FETCH_MS = 800;

/**
 * Bounds on a per-page timing sample.
 *
 * The measurement is one or two real fetches, and one of them catching a slow
 * moment is enough to treble the figure — an early build told the user 41
 * seconds for a read that took 14. Clamping keeps a noisy sample from turning
 * a reasonable offer into a frightening one, in either direction.
 */
const MIN_PAGE_FETCH_MS = 250;
const MAX_PAGE_FETCH_MS = 2_500;

export const estimateIndexRead = (pages: number, msPerPage = DEFAULT_PAGE_FETCH_MS): number => {
  const perPage = Math.min(MAX_PAGE_FETCH_MS, Math.max(MIN_PAGE_FETCH_MS, msPerPage));
  return pages * perPage + Math.max(0, pages - 1) * indexReadGap(pages);
};

/**
 * The section of the index the submitted URL points at.
 *
 * Scope falls out of the link with no extra UI: point at one product's
 * endpoints and you read those, point at the whole reference and you read
 * everything. The user controls the cost by choosing what to paste.
 */
export const sectionOf = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    // A page is a leaf; its siblings are the section. A trailing slash is
    // already a section and keeps all of itself.
    return path.endsWith("/") ? path : `${path.split("/").slice(0, -1).join("/")}/`;
  } catch {
    return "/";
  }
};

/**
 * Every place this site might keep its index, nearest first.
 *
 * The advertised link is best, but it is only available when the submitted
 * page could be read — and a mistyped or moved URL is exactly when the
 * fallback matters. Walking the path upwards costs a handful of cheap
 * requests and finds the index on any site whose docs live under a prefix,
 * which the origin-root guess alone never will.
 */
export const indexCandidatesFor = (url: string, advertised: readonly string[] = []): string[] => {
  const found = [...advertised];
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // Drop a trailing page name before walking: its siblings are the section.
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      const prefix = segments.slice(0, depth).join("/");
      found.push(`${parsed.origin}/${prefix ? `${prefix}/` : ""}llms.txt`);
    }
  } catch {
    /* not a usable URL */
  }
  return [...new Set(found)];
};

/** Index entries under the submitted URL's section, in listed order. */
export const pagesUnder = (indexText: string, indexUrl: string, section: string): string[] => {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of indexText.matchAll(/\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g)) {
    let resolved: string;
    try {
      resolved = new URL(match[1]!, indexUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (new URL(resolved).pathname.startsWith(section)) found.push(resolved);
    } catch {
      /* not a usable URL */
    }
  }
  return found;
};

interface AttemptContext {
  readonly tried: string[];
  readonly warnings: string[];
  /** A page index found along the way, carried onto whatever result wins. */
  index?: DocsIndex;
  /** Measured cost of one page fetch from this site, for an honest estimate. */
  msPerPage?: number;
  /**
   * The most actionable reason a rung declined — a client-rendered docs site,
   * or a missing AI key. Kept separately from warnings so it can become the
   * headline rather than being buried in a list.
   */
  blocked: string | null;
  /** A page drawn by scripts waits on a browser the person has not agreed to fetch yet. */
  needsRenderer?: boolean;
}

/**
 * Rungs 2 and 3 for one URL: find a spec, else read the page.
 *
 * Factored out so that search results re-enter exactly the same logic — a
 * spec found by searching is parsed just as exactly as one typed in.
 */
/**
 * A specification a drawn page holds or links to, imported exactly: what only
 * the page as drawn shows. Null when it shows none that parses.
 */
const specificationIn = async (
  html: string,
  url: string,
  deps: DiscoveryDeps,
  ctx: AttemptContext,
  fetched: readonly string[] = [],
): Promise<DiscoveryResult | null> => {
  const inline = extractInlineSpec(html, looksLikeOpenApi);
  const held = inline ? parseOpenApi(inline.spec, url) : null;
  if (held)
    return {
      source: "openapi",
      entry: held.entry,
      note: `Found a complete OpenAPI spec in the documentation as drawn at ${url} and imported ${held.entry.ops.length} endpoint(s).`,
      warnings: [...ctx.warnings, ...held.warnings],
      tried: ctx.tried,
    };
  /* What the page fetched to draw itself is its own description: tried before anything it merely links to. */
  for (const candidate of [...new Set([...fetched, ...specLinksIn(html, url)])]) {
    if (ctx.tried.includes(candidate)) continue;
    ctx.tried.push(candidate);
    try {
      const response = await deps.fetchDocument(candidate);
      if (response.status >= 400) continue;
      const doc = parseSpecDocument(response.text);
      if (!looksLikeOpenApi(doc)) continue;
      const parsed = parseOpenApi(await wholeSpec(doc, response.url, deps, ctx.warnings), response.url);
      if (!parsed) continue;
      return {
        source: "openapi",
        entry: parsed.entry,
        note: `Imported ${parsed.entry.ops.length} endpoint(s) from the OpenAPI spec at ${response.url}, ${fetched.includes(candidate) ? "which the documentation fetched to draw itself" : "linked from the documentation as drawn"}.`,
        warnings: [...ctx.warnings, ...parsed.warnings],
        tried: ctx.tried,
      };
    } catch {
      /* A link that does not answer is one fewer candidate. */
    }
  }
  return null;
};

const attemptUrl = async (
  url: string,
  deps: DiscoveryDeps,
  ctx: AttemptContext,
  options: { allowDocs: boolean; primary?: boolean },
): Promise<DiscoveryResult | null> => {
  const specCandidates: string[] = [];
  let pageHtml: string | null = null;
  let pageUrl = url;
  /** A spec found in a code fence — a floor, beaten by any standalone document. */
  let embedded: DiscoveryResult | null = null;

  if (!ctx.tried.includes(url)) {
    ctx.tried.push(url);
    try {
      const startedAt = Date.now();
      const response = await deps.fetchDocument(url);
      // One real sample of what a page from this site costs. Far better than
      // a constant: docs hosts differ by an order of magnitude.
      // The faster of the samples, because a single slow fetch is noise
      // rather than the site's real cost.
      ctx.msPerPage = Math.min(ctx.msPerPage ?? Infinity, Date.now() - startedAt);
      const asJson = parseSpecDocument(response.text);

      /* A SOAP service describes itself in a WSDL: each operation named for reading is an endpoint. */
      if (response.status < 400 && looksLikeWsdl(response.text)) {
        const described = parseWsdl(response.text, response.url);
        if (described)
          return {
            source: "wsdl",
            entry: described.entry,
            note: `Set up ${described.entry.ops.length} operation(s) from the WSDL at ${response.url}.`,
            warnings: [...ctx.warnings, ...described.warnings],
            tried: ctx.tried,
          };
      }

      if (looksLikeOpenApi(asJson)) {
        const parsed = parseOpenApi(await wholeSpec(asJson, response.url, deps, ctx.warnings), response.url);
        if (parsed) {
          return {
            source: "openapi",
            entry: parsed.entry,
            note: `Imported ${parsed.entry.ops.length} endpoint(s) from the OpenAPI spec at ${response.url}.`,
            warnings: [...ctx.warnings, ...parsed.warnings],
            tried: ctx.tried,
          };
        }
        ctx.warnings.push(
          "That looks like an OpenAPI spec but no readable GET endpoints could be imported from it.",
        );
      } else if (response.status < 400 && response.text.trim() !== "") {
        /*
         * Any successful text document, not just one starting with `<`.
         *
         * The HTML-only gate silently skipped the whole branch — inline spec
         * *and* link harvesting — for Markdown, and docs platforms now
         * content-negotiate Markdown to non-browser clients as a matter of
         * course. We were being handed the friendlier format and discarding it
         * for not looking like the hostile one.
         *
         * The status check is load-bearing now that the shape check is gone:
         * a 500 body reading "boom" is not documentation, and without this it
         * would be handed to the model as though it were.
         */
        pageHtml = response.text;
        pageUrl = response.url;

        // A page that embeds its own spec is still the deterministic rung —
        // check before collecting links, because an exact document beats
        // anything a linked page or a model could tell us.
        const inline = extractInlineSpec(response.text, looksLikeOpenApi);
        if (inline) {
          const parsed = parseOpenApi(inline.spec, response.url);
          if (parsed) {
            const found = {
              source: "openapi" as const,
              entry: parsed.entry,
              note: `Found a complete OpenAPI spec embedded in the ${inline.label} documentation at ${response.url} and imported ${parsed.entry.ops.length} endpoint(s).`,
              warnings: [...ctx.warnings, ...parsed.warnings],
              tried: ctx.tried,
            };
            /*
             * A rendered page's own state object is the whole document, so it
             * wins outright. A code fence is not: on a per-endpoint docs page
             * it holds that one endpoint, and returning it immediately beat
             * the site's real 52-endpoint spec sitting at /openapi.yaml. So a
             * fence is held as a floor and only used if nothing better turns up.
             */
            if (inline.label !== "fenced") return found;
            embedded = found;
          }
        }

        specCandidates.push(...specLinksIn(response.text, response.url));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.warnings.push(message);
      // Failing to read the URL the user actually typed is the headline. The
      // same failure on a guessed path is routine and stays a warning.
      if (options.primary) ctx.blocked = `Could not read that page: ${message}.`;
    }
  }

  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
    for (const path of WELL_KNOWN_SPEC_PATHS) specCandidates.push(`${origin}${path}`);
  } catch {
    /* not a usable origin */
  }

  /*
   * `llms.txt`: a machine-readable index of the whole documentation site.
   *
   * A convention docs platforms have adopted specifically so automated readers
   * stop guessing — it lists every page, and usually the spec, in a few KB of
   * plain text. Cheap to try, and it answers the exact question this rung is
   * asking. Aptly's own page says so in its body: "Fetch the complete
   * documentation index at /llms.txt".
   */
  // What the page says first, then each ancestor path, then the origin root.
  const indexUrls = indexCandidatesFor(url, pageHtml ? indexLinksIn(pageHtml, pageUrl) : []);

  for (const indexUrl of indexUrls) {
    if (ctx.tried.includes(indexUrl)) continue;
    ctx.tried.push(indexUrl);
    try {
      const startedAt = Date.now();
      const index = await deps.fetchDocument(indexUrl);
      if (index.status >= 400) continue;
      ctx.msPerPage = Math.min(ctx.msPerPage ?? Infinity, Date.now() - startedAt);
      specCandidates.push(...specLinksIn(index.text, index.url));
      /*
       * Remember what the index says even when it lists no spec — that is the
       * case worth remembering. A site documenting every endpoint on its own
       * page has no spec to link, and this count is what lets the caller
       * price reading them before a single extra request is made.
       */
      const section = sectionOf(pageUrl);
      const pages = pagesUnder(index.text, index.url, section).length;
      if (pages > 0) {
        ctx.index = {
          url: index.url,
          section,
          pages,
          estimatedMs: estimateIndexRead(pages, ctx.msPerPage),
        };
      }
      // One index is enough; a second is the same site saying it twice.
      break;
    } catch {
      // Most sites do not publish one. Absence is not a failure.
    }
  }

  for (const candidate of specCandidates) {
    if (ctx.tried.includes(candidate)) continue;
    ctx.tried.push(candidate);
    try {
      const response = await deps.fetchDocument(candidate);
      if (response.status >= 400) continue;
      const doc = parseSpecDocument(response.text);
      if (!looksLikeOpenApi(doc)) continue;
      const parsed = parseOpenApi(await wholeSpec(doc, response.url, deps, ctx.warnings), response.url);
      if (!parsed) continue;
      return {
        source: "openapi",
        entry: parsed.entry,
        note: `Found an OpenAPI spec at ${response.url} and imported ${parsed.entry.ops.length} endpoint(s).`,
        warnings: [...ctx.warnings, ...parsed.warnings],
        tried: ctx.tried,
      };
    } catch {
      // A 404 on a guessed path is expected, not an error worth reporting.
    }
  }

  // Nothing standalone turned up, so the fragment is the best answer there is.
  if (embedded) return embedded;

  if (!pageHtml || !options.allowDocs) return null;

  let analysis = analysePage(pageHtml);
  /*
   * A page drawn in the browser is drawn, where something can: the
   * `DocsRenderer` plug-in point. Without one, it is said plainly — a page
   * with nothing in it is never handed to a model to invent an API from.
   */
  if (analysis.isClientRendered && deps.renderDocs) {
    const readiness = deps.renderDocs.ready ? await deps.renderDocs.ready().catch(() => "unavailable" as const) : "ready";
    if (readiness === "needs-install") ctx.needsRenderer = true;
    const rendered = readiness === "ready" ? await deps.renderDocs.render(pageUrl).catch(() => null) : null;
    if (rendered) {
      /* What only the drawn page shows: a specification it holds or links to, read exactly, before its prose. */
      const specified = await specificationIn(rendered.html, rendered.url, deps, ctx, rendered.specs ?? []);
      if (specified) return specified;
      const drawn = analysePage(rendered.html);
      if (!drawn.isClientRendered) {
        analysis = drawn;
        pageHtml = rendered.html;
        pageUrl = rendered.url;
        ctx.warnings.push(`The documentation is drawn in the browser, so it was read as drawn (${rendered.url}).`);
      }
    }
  }
  if (analysis.isClientRendered) {
    ctx.blocked = ctx.needsRenderer
      ? `This documentation is drawn in the browser. Reading it needs a one-time download of about ${RENDERER_DOWNLOAD_MB} MB.`
      : `${analysis.reason} Try linking directly to an OpenAPI spec instead, or describe the API by hand.`;
    return null;
  }
  if (!deps.llm) {
    ctx.blocked =
      "No OpenAPI spec was found. Reading the documentation needs an AI key — set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.";
    return null;
  }

  const context = rankContext(analysis);
  if (context.content.trim().length < 200) {
    ctx.blocked = "That page did not contain enough about the API to work from.";
    return null;
  }

  const proposed = await proposeDialect({ llm: deps.llm, url: pageUrl, context, named: endpointsNamed(analysis) });
  if (!proposed.entry) {
    ctx.warnings.push(...proposed.warnings);
    return null;
  }

  /*
   * A GraphQL API whose documentation publishes its schema: the reads are
   * written from the schema, not guessed from prose.
   */
  const graphql = await withGraphqlReads(proposed.entry, { html: pageHtml, url: pageUrl }, deps.fetchDocument);

  return {
    source: "docs",
    entry: graphql?.entry ?? proposed.entry,
    note: `Read ${context.chunksKept} of ${context.chunksTotal} sections of the documentation at ${pageUrl}.${graphql ? ` ${graphql.note}` : ""} Everything here is a guess until you test it.`,
    warnings: [...ctx.warnings, ...proposed.warnings, ...(graphql?.warnings ?? [])],
    tried: ctx.tried,
  };
};

/**
 * Walk the discovery ladder for a URL or a product name.
 *
 * Ordered by determinism, not by cleverness: a catalog entry someone already
 * proved beats a spec, a spec beats reading prose, and reading prose beats
 * guessing from search results. Whatever rung answers, the result is a
 * *proposal* — the oracle is the validate-and-sample step that follows,
 * because documentation lies and a live 200 does not.
 */
/** A specification with its references into other files followed, and what that took, said. */
const wholeSpec = async (doc: unknown, url: string, deps: DiscoveryDeps, warnings: string[]): Promise<unknown> => {
  const { doc: whole, read, unresolved } = await resolveExternalRefs(doc, url, deps.fetchDocument);
  if (read > 0) warnings.push(`The specification is split across files; ${read} more were read to put it together.`);
  if (unresolved.length > 0)
    warnings.push(`Some of its references could not be followed: ${unresolved.slice(0, 3).join(", ")}.`);
  return whole;
};

export const discover = async (input: string, deps: DiscoveryDeps): Promise<DiscoveryResult> => {
  /* An address that says it is an MCP server is asked as one before it is read as documentation. */
  const first = looksLikeMcpAddress(input) ? await asMcp(input, deps) : null;
  if (first) return first;
  const found = await withOidcSignIn(await discoverIndexed(input, deps), deps);
  if (found.entry || looksLikeMcpAddress(input)) return found;
  /* Nothing here read as documentation: it may be a server to talk to rather than a page to read. */
  return (await asMcp(input, deps)) ?? found;
};

/** The address as an MCP server, or null when it does not answer as one. */
const asMcp = async (input: string, deps: DiscoveryDeps): Promise<DiscoveryResult | null> => {
  if (!deps.http) return null;
  const url = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  const found = await discoverMcp(url, { http: deps.http }).catch(() => null);
  return found ? { source: "mcp", entry: found.entry, note: found.note, warnings: found.warnings, tried: [url] } : null;
};

/**
 * A specification that signs in with OpenID Connect names a discovery
 * document; read, it is the OAuth sign-in the broker runs.
 * Only where the import said it could not sign in that way.
 */
const withOidcSignIn = async (found: DiscoveryResult, deps: DiscoveryDeps): Promise<DiscoveryResult> => {
  const entry = found.entry;
  if (!entry?.specUrl || !found.warnings.some((warning) => /OpenID Connect/i.test(warning))) return found;
  const spec = await deps.fetchDocument(entry.specUrl).catch(() => null);
  if (!spec || spec.status < 200 || spec.status >= 300) return found;
  const signed = await withOidc(entry, parseSpecDocument(spec.text), spec.url || entry.specUrl, deps.fetchDocument);
  if (!signed) return found;
  return {
    ...found,
    entry: signed.entry,
    note: `${found.note} ${signed.note}`,
    warnings: found.warnings.filter((warning) => !/OpenID Connect/i.test(warning)),
  };
};

const discoverIndexed = async (input: string, deps: DiscoveryDeps): Promise<DiscoveryResult> => {
  const found = await discoverOnce(input, deps);
  const index = found.index;
  if (found.entry || !index || !deps.readIndexUpTo || index.pages > deps.readIndexUpTo) return found;
  /* Nothing answered, and the section is small: read it, as a person offered the count would have. */
  const deep = await readIndex(new URL(index.section, index.url).toString(), deps);
  if (!deep.entry) return found;
  return { ...deep, warnings: [...found.warnings, ...deep.warnings], tried: [...found.tried, ...deep.tried] };
};

const discoverOnce = async (input: string, deps: DiscoveryDeps): Promise<DiscoveryResult> => {
  const ctx: AttemptContext = { tried: [], warnings: [], blocked: null };

  /*
   * Attached here rather than at each of the ladder's return points, so a new
   * rung cannot forget it. What the index says is independent of which rung
   * happened to answer — and it matters most when none of them did.
   */
  const withIndex = (result: DiscoveryResult): DiscoveryResult =>
    ctx.index ? { ...result, index: ctx.index } : result;

  // ── Rung 1: someone already worked this out ────────────────────────────
  const match = catalogMatch(deps.catalog, input);
  if (match) {
    /*
     * An entry written by an older importer has its address and auth read
     * again from its spec before it is offered — only those, so nothing
     * described or mapped since is lost. Offering it as it was would repeat
     * whatever the old importer got wrong about how to connect.
     */
    const { entry: known, refreshed } = await refreshOutdatedConnectDetails(
      match,
      deps.fetchDocument,
    );
    return withIndex({
      source: "catalog",
      entry: known,
      note: `${known.title} is already in the catalog${known.verified ? " and has been verified" : ""}.${
        refreshed ? " How to connect to it was read again from its documentation." : ""
      }`,
      warnings: known.verified
        ? []
        : ["This catalog entry has not been proven against a live key yet."],
      tried: [],
    });
  }

  // ── Rungs 2–3: the URL the user gave us ────────────────────────────────
  const url = asUrl(input);
  if (url) {
    const direct = await attemptUrl(url, deps, ctx, { allowDocs: true, primary: true });
    if (direct) return withIndex(direct);
    /* The page itself could be read, once the person agrees to the browser: asked, before anything is searched. */
    if (ctx.needsRenderer)
      return withIndex({
        source: "none",
        entry: null,
        note: ctx.blocked ?? "This documentation is drawn in the browser.",
        warnings: ctx.warnings,
        tried: ctx.tried,
        needsRenderer: true,
      });
  }

  // ── Rung 4: go looking ─────────────────────────────────────────────────
  if (!deps.search) {
    return withIndex({
      source: "none",
      entry: null,
      // A specific reason always beats the generic one.
      note:
        ctx.blocked ??
        (url
          ? `No OpenAPI spec was found there, and the page could not be read. ${SEARCH_KEY_HINT} to let us go looking, or describe the API by hand.`
          : `"${input}" is not a URL. ${SEARCH_KEY_HINT} to search by name, or paste a documentation link.`),
      warnings: ctx.warnings,
      tried: ctx.tried,
    });
  }

  const subjectHost = url ? hostOf(url) : null;
  const subject = subjectHost ?? input;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const query of buildSearchQueries(subject)) {
    try {
      const results = rankSearchResults(await deps.search.search(query, 10));
      for (const result of results) {
        if (seen.has(result.url) || ctx.tried.includes(result.url)) continue;
        seen.add(result.url);
        // A meta-spec is not an API, however well it scores.
        if (isMetaSpecHost(result.url)) continue;
        candidates.push(result.url);
      }
    } catch (error) {
      ctx.warnings.push(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (candidates.length >= 4) break;
  }

  /**
   * When the user named a host, results from that host come first.
   *
   * Ranking on URL shape alone is not enough: a search for a small API can
   * surface some *other* company's `openapi.json`, which scores highly for
   * looking exactly like a spec and is then imported with total confidence.
   * A wrong API that validates is worse than no answer, so anything
   * off-domain is a last resort rather than a peer.
   */
  const offDomain: string[] = [];
  if (subjectHost) {
    const own = candidates.filter((c) => sameOrganisation(hostOf(c), subjectHost));
    offDomain.push(...candidates.filter((c) => !own.includes(c)));
    candidates.length = 0;
    candidates.push(...own);
  }

  if (candidates.length === 0) {
    /*
     * A foreign host is refused, not ranked last.
     *
     * Demoting by sort order reads as caution and is not: when *every* result
     * is off-domain — which is exactly what happens for a small or new API —
     * last resort becomes first resort, and a different company's spec gets
     * read and offered. That failure is worse than no answer, because it
     * arrives looking like a complete, confident import.
     */
    return withIndex({
      source: "none",
      entry: null,
      note:
        offDomain.length > 0
          ? `Nothing on ${subjectHost} turned up. Searching found ${offDomain.length} result(s) belonging to other sites, which were not used — a different company's API is worse than no answer. Link the spec directly, or describe the API by hand.`
          : `Nothing that looked like API reference documentation turned up for "${subject}".`,
      warnings: ctx.warnings,
      tried: ctx.tried,
    });
  }

  for (const candidate of candidates.slice(0, 3)) {
    // `allowDocs` stays true, but these candidates never search again — the
    // recursion stops here by construction rather than by a depth counter.
    const found = await attemptUrl(candidate, deps, ctx, { allowDocs: true });
    if (found) {
      // A different organisation's API is the failure mode that matters here,
      // so it leads the note instead of sitting in a warnings list nobody
      // reads before clicking Use.
      const foundHost = found.entry ? hostOf(found.entry.baseUrl) : null;
      // Candidates are already host-filtered when the user named one, so this
      // only fires when the base URL inside a spec points somewhere else.
      const foreign = subjectHost !== null && !sameOrganisation(foundHost, subjectHost);

      return {
        ...found,
        viaSearch: true,
        note: foreign
          ? `⚠ This is ${foundHost}, not ${subjectHost} — searching for "${subject}" found a different company's API. ${found.note}`
          : `${found.note} Found by searching for "${subject}".`,
        warnings: [
          ...found.warnings,
          foreign
            ? `You asked about ${subjectHost} but this describes ${foundHost}. Only use it if that is genuinely the API you meant.`
            : "This was found by web search rather than from a link you gave us — check the base URL is the API you meant.",
        ],
      };
    }
  }

  return withIndex({
    source: "none",
    entry: null,
    // Search failing is the least informative thing we know. If a rung above
    // it declined for a specific, fixable reason — the page was too big, it
    // was a client-rendered shell, no AI key — that reason is what the user
    // can act on, so it leads and the search summary follows.
    note: ctx.blocked
      ? `${ctx.blocked} Searching for "${subject}" then checked ${candidates.length} other result(s) without finding a usable API description either.`
      : `Searched for "${subject}" and checked ${candidates.length} result(s), but none produced a usable API description.`,
    warnings: ctx.warnings,
    tried: ctx.tried,
  });
};

/** Consecutive failures after which a fan-out stops rather than grinding on. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ReadIndexOptions {
  /** Injected so tests never actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (progress: { spent: number; planned: number }) => void;
}

/**
 * Read every page in a section and merge what they declare.
 *
 * For a site that documents each endpoint on its own page and publishes no
 * whole-API spec, this is the only complete machine-readable source there is.
 * It is deliberately not part of `discover`: it costs one request per page,
 * against somebody else's documentation site, so it happens only when a
 * person has seen the count and asked for it.
 *
 * Fragments are merged into one document and parsed once — see
 * `merge-specs.ts` for why that ordering is load-bearing rather than tidy.
 */
export const readIndex = async (
  url: string,
  deps: DiscoveryDeps,
  options: ReadIndexOptions = {},
): Promise<DiscoveryResult> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const tried: string[] = [];
  const warnings: string[] = [];

  const section = sectionOf(url);

  // The page usually names its index outright; ask it first, then walk up.
  const advertised: string[] = [];
  try {
    tried.push(url);
    const page = await deps.fetchDocument(url);
    if (page.status < 400) advertised.push(...indexLinksIn(page.text, page.url));
  } catch {
    /* the ancestor walk below may still find it */
  }

  let pages: string[] = [];
  let indexUrl: string | null = null;
  for (const candidate of indexCandidatesFor(url, advertised)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    try {
      const index = await deps.fetchDocument(candidate);
      if (index.status >= 400) continue;
      pages = pagesUnder(index.text, index.url, section);
      indexUrl = index.url;
      break;
    } catch {
      /* try the next */
    }
  }

  if (!indexUrl || pages.length === 0) {
    return {
      source: "none",
      entry: null,
      note: `No page index was found for ${section}, so there is nothing to read through.`,
      warnings,
      tried,
    };
  }

  const gap = indexReadGap(pages.length);
  const fragments: SpecFragment[] = [];
  let read = 0;
  let consecutiveFailures = 0;

  for (const page of pages) {
    if (read > 0 && gap > 0) await sleep(gap);
    read += 1;
    options.onProgress?.({ spent: read, planned: pages.length });

    try {
      const response = await deps.fetchDocument(page);
      if (response.status >= 400) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
        const inline = extractInlineSpec(response.text, looksLikeOpenApi);
        if (inline) fragments.push({ spec: inline.spec, sourceUrl: response.url });
      }
    } catch {
      consecutiveFailures += 1;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      /*
       * The site has started refusing. Stopping and reporting what was
       * gathered beats spending another four hundred requests to collect
       * four hundred more failures.
       */
      warnings.push(
        `Stopped after ${MAX_CONSECUTIVE_FAILURES} pages in a row could not be read — ` +
          `${read} of ${pages.length} were checked.`,
      );
      break;
    }
  }

  tried.push(...pages.slice(0, read));

  const { merged, warnings: mergeWarnings, operations } = mergeSpecDocuments(fragments);
  warnings.push(...mergeWarnings);

  if (!merged) {
    return {
      source: "none",
      entry: null,
      note: `Read ${read} page(s) under ${section} but none of them carried an API description.`,
      warnings,
      tried,
    };
  }

  const issues: z.ZodIssue[] = [];
  const parsed = parseOpenApi(merged, indexUrl, { onReject: (found) => issues.push(...found) });

  if (!parsed) {
    /*
     * A minute of paced fetching must never end in silence. The caps that
     * bite here are `resources` (200) and `relations` (40 apiece), and the
     * fix is always the same: point at a narrower section.
     */
    const tooMany = issues.find((issue) => issue.path.includes("resources"));
    return {
      source: "none",
      entry: null,
      note: tooMany
        ? `Read ${read} page(s) and found ${operations} operation(s), but ${section} describes more record types than one connection can hold. Link a narrower section and read that instead.`
        : `Read ${read} page(s) and found ${operations} operation(s), but they did not combine into a usable API description.`,
      warnings: [...warnings, ...issues.slice(0, 3).map((issue) => issue.message)],
      tried,
    };
  }

  return {
    source: "openapi",
    entry: parsed.entry,
    note:
      `Read ${read} page(s) under ${section}, found API descriptions on ${fragments.length}, ` +
      `and imported ${parsed.entry.ops.length} endpoint(s).`,
    warnings: [...warnings, ...parsed.warnings],
    tried,
  };
};

export { analysePage, rankContext } from "./docs.js";
export { parseOpenApi, looksLikeOpenApi } from "./openapi.js";
export { mapDialectProposal, dialectProposalSchema } from "./propose-dialect.js";
export { rankSearchResults, searchFromEnv } from "./search.js";
export {
  anthropicWebSearch,
  anthropicSearchResults,
  openAiWebSearch,
  openAiSearchResults,
} from "./llm-search.js";
export type { SearchProvider, SearchResult } from "./search.js";
