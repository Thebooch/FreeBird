import type { CatalogEntry } from "@freebirdai/dash-spec";
import { IMPORT_VERSION } from "@freebirdai/dash-spec";
import { extractInlineSpec } from "./inline-spec.js";
import { looksLikeOpenApi, parseOpenApi, parseSpecDocument, type OpenApiResult } from "./openapi.js";

/**
 * Keeping what an import says about *getting in* current, without touching
 * what was learned about the API since.
 *
 * An API's catalog entry holds two kinds of thing. What the importer read from
 * the specification — where the API lives, how it authenticates, what the
 * docs say about keys — and what was paid for afterwards: record types
 * described, relations mapped, dashboards composed. When the importer learns
 * to read the first kind better, every entry imported before is frozen at
 * the old reading; replacing the entry wholesale would fix that and throw the
 * second kind away.
 *
 * So the first kind is refreshed on its own. It is what was wrong about
 * Rentvine: an address pointing at the documentation site and a login with a
 * placeholder username, both straight from the old importer, beside nothing
 * anybody had paid for yet — but on another API the same fix would land
 * beside a hundred described record types.
 */

type FetchDocument = (url: string) => Promise<{ status: number; text: string; url: string }>;

/** Written by an importer older than the one reading it now. */
export const importIsOutdated = (entry: CatalogEntry): boolean =>
  (entry.origin === "openapi" || entry.origin === "docs") &&
  (entry.importVersion ?? 1) < IMPORT_VERSION;

/**
 * Read a specification again from where it came from — a document, or one
 * embedded in a docs page.
 *
 * Throws with a sentence worth showing when it cannot.
 */
export const rereadSpec = async (url: string, fetchDocument: FetchDocument): Promise<OpenApiResult> => {
  const fetched = await fetchDocument(url);
  if (fetched.status >= 400) throw new Error(`${url} answered ${fetched.status}`);
  const direct = parseSpecDocument(fetched.text);
  const inline = looksLikeOpenApi(direct) ? null : extractInlineSpec(fetched.text, looksLikeOpenApi);
  const doc = inline ? inline.spec : direct;
  if (!looksLikeOpenApi(doc)) {
    throw new Error(`${url} is not an OpenAPI document, and none was found embedded in it`);
  }
  const parsed = parseOpenApi(doc, fetched.url);
  if (!parsed) throw new Error("no readable specification could be imported from that address");
  return parsed;
};

/**
 * The entry, with how to reach and get into the API taken from a fresh read.
 *
 * Only those parts: the address and its template, whether it was a guess, the
 * auth the API declares — connection-wide and per endpoint — and what the
 * docs say about keys. Everything else is the entry's own.
 */
export const withConnectDetails = (entry: CatalogEntry, fresh: CatalogEntry): CatalogEntry => {
  const {
    server: _server,
    baseUrlGuessed: _guessed,
    ...kept
  } = entry;
  const freshOps = new Map(fresh.ops.map((op) => [op.id, op]));
  return {
    ...kept,
    baseUrl: fresh.baseUrl,
    ...(fresh.server ? { server: fresh.server } : {}),
    ...(fresh.baseUrlGuessed ? { baseUrlGuessed: true } : {}),
    ...(fresh.keyHelp ? { keyHelp: fresh.keyHelp } : {}),
    authRequired: fresh.authRequired,
    dialect: { ...entry.dialect, ...(fresh.dialect.auth ? { auth: fresh.dialect.auth } : {}) },
    ops: entry.ops.map((op) => {
      const now = freshOps.get(op.id);
      if (!now) return op;
      const { auth: _auth, authRequired: _required, ...rest } = op;
      return {
        ...rest,
        ...(now.auth ? { auth: now.auth } : {}),
        ...(now.authRequired !== undefined ? { authRequired: now.authRequired } : {}),
      };
    }),
    importVersion: IMPORT_VERSION,
  };
};

/**
 * An entry brought up to the current importer's reading of how to connect,
 * when it was written by an older one and says where its spec lives.
 *
 * Returns the entry unchanged when there is nothing to do or the spec cannot
 * be read — a stale reading is still a reading, and failing a lookup over it
 * would be worse.
 */
export const refreshOutdatedConnectDetails = async (
  entry: CatalogEntry,
  fetchDocument: FetchDocument | undefined,
): Promise<{ entry: CatalogEntry; refreshed: boolean }> => {
  if (!importIsOutdated(entry) || !entry.specUrl || !fetchDocument || entry.origin !== "openapi") {
    return { entry, refreshed: false };
  }
  try {
    const parsed = await rereadSpec(entry.specUrl, fetchDocument);
    return { entry: withConnectDetails(entry, parsed.entry), refreshed: true };
  } catch {
    return { entry, refreshed: false };
  }
};
