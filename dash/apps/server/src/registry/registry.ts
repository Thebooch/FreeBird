import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogEntrySchema, type CatalogEntry } from "@freebirdai/dash-spec";
import { writeJsonAtomic } from "../json-file.js";

/**
 * Catalog entries somebody else already worked out, pulled from a read-only
 * registry.
 *
 * Everything in a catalog entry is a fact about an API, not about an account,
 * which is what makes it shareable: one person sets an API up, and the next
 * starts where they finished. A registry is a place that serves such entries:
 * an index, and one file per entry. The open-source build can read one; a
 * hosted build serves its own.
 *
 * What is pulled is data, and treated as untrusted:
 * - each entry is validated by the same schema as a local one, or skipped;
 * - **connector code is never taken from a registry.** Code that runs, even in
 *   the sandbox, is written and proven here or not run at all; an entry that
 *   needs code gets its own from this instance's check;
 * - nothing pulled is marked verified by this instance: `verified` means a
 *   request *here* returned rows. What the registry says it checked is kept
 *   as what it is — the registry's word (`evidence`, `verifiedAt`);
 * - a local entry always wins over a pulled one of the same id.
 */

export interface RegistryListing {
  readonly id: string;
  readonly title?: string;
  readonly version?: number;
  readonly verifiedAt?: string;
  /** Where the entry is, relative to the index. `<id>.json` when absent. */
  readonly file?: string;
}

/** A plug-in point: where shared entries come from. */
export interface CatalogRegistry {
  index(): Promise<readonly RegistryListing[]>;
  entry(listing: RegistryListing): Promise<unknown>;
}

const MAX_ENTRIES = 2000;
const ID = /^[a-z0-9-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A registry served over HTTPS: `<base>/index.json`, and each entry beside it. */
export const httpRegistry = (
  base: string,
  fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>,
): CatalogRegistry => {
  const root = base.endsWith("/") ? base : `${base}/`;
  const read = async (url: string): Promise<unknown> => {
    const response = await fetchDocument(url);
    if (response.status < 200 || response.status >= 300) throw new Error(`${url} answered ${response.status}`);
    return JSON.parse(response.text) as unknown;
  };
  return {
    async index() {
      const body = await read(new URL("index.json", root).toString());
      const listed = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];
      return listed
        .filter(isRecord)
        .filter((one) => typeof one.id === "string" && ID.test(one.id))
        .slice(0, MAX_ENTRIES)
        .map((one) => ({
          id: one.id as string,
          ...(typeof one.title === "string" ? { title: one.title } : {}),
          ...(typeof one.version === "number" && Number.isInteger(one.version) ? { version: one.version } : {}),
          ...(typeof one.verifiedAt === "string" ? { verifiedAt: one.verifiedAt } : {}),
          ...(typeof one.file === "string" ? { file: one.file } : {}),
        }));
    },
    async entry(listing) {
      const target = new URL(listing.file ?? `${listing.id}.json`, root);
      /* An entry lives beside its index: never a link out to somewhere else. */
      if (!target.toString().startsWith(root)) throw new Error(`${listing.id} is not under the registry's address`);
      return read(target.toString());
    },
  };
};

/** A pulled entry as it is kept: validated, without code, and saying where it came from. */
export const fromRegistry = (raw: unknown, id: string): CatalogEntry | null => {
  if (!isRecord(raw) || raw.id !== id) return null;
  const { connector: _code, ...rest } = raw;
  const ops = Array.isArray(rest.ops)
    ? rest.ops.map((op) => {
        if (!isRecord(op) || op.servedBy !== "connector") return op;
        /* Served by code that was not taken: the endpoint is kept as documented, for this instance's check to settle. */
        const { servedBy: _served, ...plain } = op;
        return plain;
      })
    : rest.ops;
  const parsed = catalogEntrySchema.safeParse({ ...rest, ops, origin: "registry", verified: false });
  if (!parsed.success) return null;
  /* A sign-in that was a connector's has nothing to run it: asked for again by this instance's check. */
  const auth = parsed.data.dialect.auth;
  return auth?.type === "connector" ? { ...parsed.data, dialect: { ...parsed.data.dialect, auth: { type: "none" } }, authRequired: true } : parsed.data;
};

export interface RegistrySync {
  readonly listed: number;
  readonly pulled: readonly string[];
  readonly unchanged: number;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly why: string }>;
}

const heldVersion = (dir: string, id: string): number | null => {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { version?: unknown };
    return typeof raw.version === "number" ? raw.version : 0;
  } catch {
    return null;
  }
};

/**
 * Bring the registry's entries into a directory the catalog reads as its
 * middle tier: above what ships with the code, below what this instance has
 * worked out itself. An entry already held at the listed version is not
 * fetched again. One that fails is skipped and said; nothing is removed.
 */
export const syncRegistry = async (registry: CatalogRegistry, dir: string): Promise<RegistrySync> => {
  mkdirSync(dir, { recursive: true });
  const listings = await registry.index();
  const pulled: string[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  let unchanged = 0;
  for (const listing of listings) {
    const held = heldVersion(dir, listing.id);
    if (held !== null && listing.version !== undefined && held >= listing.version) {
      unchanged++;
      continue;
    }
    try {
      const entry = fromRegistry(await registry.entry(listing), listing.id);
      if (!entry) {
        skipped.push({ id: listing.id, why: "it is not a catalog entry this version reads" });
        continue;
      }
      writeJsonAtomic(join(dir, `${listing.id}.json`), entry);
      pulled.push(listing.id);
    } catch (error) {
      skipped.push({ id: listing.id, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { listed: listings.length, pulled, unchanged, skipped };
};

/** What this instance's entries look like to somebody pulling them: the index a registry serves. */
export const registryIndex = (entries: readonly CatalogEntry[]): { entries: RegistryListing[] } => ({
  entries: entries
    .filter((entry) => entry.verified)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.verifiedAt ? { verifiedAt: entry.verifiedAt } : {}),
    })),
});
