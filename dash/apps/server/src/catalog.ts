import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { catalogEntrySchema, connectionSchema } from "@freebirdai/dash-spec";

/**
 * Dialects, in two tiers.
 *
 * The repo directory is the seed: hand-written and community-contributable by
 * ordinary pull request, so a self-hoster gets known APIs for free. The
 * overlay is per-instance, holding dialects derived locally from an OpenAPI
 * spec or from docs — these win, so an instance can correct a stale seed
 * without waiting for an upstream release, and a good local dialect is exactly
 * what gets contributed back.
 */
export class CatalogStore {
  constructor(
    private readonly seedDir: string,
    private readonly overlayDir: string,
  ) {
    mkdirSync(overlayDir, { recursive: true });
  }

  private readDir(dir: string, origin: CatalogEntry["origin"]): CatalogEntry[] {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const entries: CatalogEntry[] = [];
    for (const name of names) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
        const parsed = catalogEntrySchema.safeParse({ origin, ...raw });
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // A malformed catalog file is skipped, never fatal — one bad
        // contribution must not stop the server from booting.
      }
    }
    return entries;
  }

  list(): CatalogEntry[] {
    const merged = new Map<string, CatalogEntry>();
    for (const entry of this.readDir(this.seedDir, "repo")) merged.set(entry.id, entry);
    // Overlay wins.
    for (const entry of this.readDir(this.overlayDir, "manual")) merged.set(entry.id, entry);
    return [...merged.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  get(id: string): CatalogEntry | null {
    return this.list().find((entry) => entry.id === id) ?? null;
  }

  /** Only ever writes to the overlay — the repo seed is read-only at runtime. */
  put(entry: CatalogEntry): CatalogEntry {
    const stored: CatalogEntry = { ...entry, updatedAt: new Date().toISOString() };
    writeFileSync(
      join(this.overlayDir, `${entry.id}.json`),
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8",
    );
    return stored;
  }

  /** Drops a local override, falling back to the repo seed if there is one. */
  deleteOverlay(id: string): void {
    try {
      unlinkSync(join(this.overlayDir, `${id}.json`));
    } catch {
      /* nothing local to remove */
    }
  }
}

/**
 * Turn a catalog entry into a connection ready to save.
 *
 * The connection stores only what is unique to this user: which catalog entry
 * it came from, where its key lives, and which endpoints they picked. The
 * dialect is copied in so the connection keeps working even if the catalog
 * entry later changes underneath it — provenance without a live dependency.
 */
export const connectionFromCatalog = (
  entry: CatalogEntry,
  options: { id?: string; keyRef?: string; opIds?: readonly string[] } = {},
): ConnectionSpec => {
  const id = options.id ?? entry.id;
  const keyRef = options.keyRef ?? `${id}-key`;

  const auth = entry.dialect.auth
    ? entry.dialect.auth.type === "none"
      ? entry.dialect.auth
      : { ...entry.dialect.auth, keyRef }
    : { type: "none" as const };

  const chosen = options.opIds
    ? entry.ops.filter((op) => options.opIds!.includes(op.id))
    : entry.ops;

  return connectionSchema.parse({
    id,
    title: entry.title,
    kind: "rest",
    authRequired: entry.authRequired,
    resources: entry.resources,
    baseUrl: entry.baseUrl,
    catalog: entry.id,
    auth,
    dialect: { ...entry.dialect, auth },
    ops: chosen.map((op) => ({
      id: op.id,
      title: op.title,
      path: op.path,
      archetype: op.archetype,
      ...(op.rowsPath ? { rowsPath: op.rowsPath } : {}),
      query: op.query,
    })),
    ...(entry.validateOpId && chosen.some((op) => op.id === entry.validateOpId)
      ? { validateOpId: entry.validateOpId }
      : chosen[0]
        ? { validateOpId: chosen[0].id }
        : {}),
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    ...(entry.keyHelp ? { keyHelp: entry.keyHelp } : {}),
  });
};
