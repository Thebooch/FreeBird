/**
 * Fold many one-operation specs into a single document.
 *
 * Docs platforms increasingly publish an OpenAPI fragment on each endpoint's
 * own page — one path, one method, its own `components`. Read individually
 * those fragments are nearly useless: `deriveResourceGraph` only builds a
 * resource when a collection *and* its detail endpoint appear in the same
 * array, so a page-at-a-time import yields no resources, no drill-downs and
 * nothing for the widget engine to suggest. Merged, they yield the graph.
 *
 * The merge happens at the *document* level, deliberately. Combining finished
 * `CatalogEntry` objects instead would mean re-implementing operation id
 * allocation, auth ranking and pagination detection — and `opId` strips `{…}`
 * segments, so `/users` and `/users/{id}` both slug to `users` with
 * de-duplication scoped to a single `parseOpenApi` call. Merging first and
 * parsing once means every one of those rules runs exactly as it always has,
 * over the whole set, with no second code path to drift.
 *
 * First-wins throughout, because the alternative is silently preferring
 * whichever page happened to be fetched last. Every genuine conflict is
 * reported rather than resolved quietly.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface SpecFragment {
  readonly spec: unknown;
  /** Where it came from, so a conflict can name the page that caused it. */
  readonly sourceUrl: string;
}

export interface MergedSpec {
  readonly merged: Json | null;
  readonly warnings: readonly string[];
  /** Distinct path+method operations in the result. */
  readonly operations: number;
}

/** The page, not the whole URL — a conflict message wants to stay readable. */
const shortName = (url: string): string => {
  try {
    const path = new URL(url).pathname.replace(/\.md$/, "");
    return path.split("/").filter(Boolean).slice(-2).join("/") || url;
  } catch {
    return url;
  }
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Are two definitions the same thing said twice, or a real disagreement?
 *
 * Fragments repeat their shared pieces — the same security scheme and the
 * same `Error` schema appear on every page — so an identity check is what
 * separates the routine duplication from the collision worth warning about.
 * Key order is normalised because these arrive from separate YAML parses.
 */
const sameShape = (a: unknown, b: unknown): boolean => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isObject(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    }
    return value;
  };
  try {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  } catch {
    // Circular or otherwise unserialisable: treat as different and warn.
    return false;
  }
};

/** Merge one named map (`securitySchemes`, `schemas`) with conflict reporting. */
const mergeNamed = (
  into: Json,
  from: unknown,
  label: string,
  source: string,
  warnings: string[],
): void => {
  if (!isObject(from)) return;
  for (const [name, definition] of Object.entries(from)) {
    const existing = into[name];
    if (existing === undefined) {
      into[name] = definition;
      continue;
    }
    if (sameShape(existing, definition)) continue;
    /*
     * A real collision. Both fragments `$ref` this name from their own
     * operations, so keeping the first silently repoints the second's
     * response schema at a different shape — which surfaces much later as a
     * widget bound to columns that never arrive.
     */
    warnings.push(
      `Two pages define a different \`${name}\` under ${label}; kept the first. ` +
        `The one from ${shortName(source)} was dropped.`,
    );
  }
};

export const mergeSpecDocuments = (fragments: readonly SpecFragment[]): MergedSpec => {
  const warnings: string[] = [];
  const usable = fragments.filter((fragment) => isObject(fragment.spec));
  if (usable.length === 0) return { merged: null, warnings, operations: 0 };

  const first = usable[0]!.spec as Json;

  const paths: Json = {};
  const securitySchemes: Json = {};
  const schemas: Json = {};
  const security: unknown[] = [];
  const seenSecurity = new Set<string>();

  let servers = Array.isArray(first.servers) ? first.servers : undefined;
  /*
   * Titles are counted rather than taken from the first page.
   *
   * Fragments carry whichever product spec they were generated from, and the
   * first page of a section is as likely to be an outlier as anything else —
   * reading HubSpot's calls endpoints produced a connection called
   * "Appointments". The title most pages agree on is the section's real name.
   */
  const titles = new Map<string, number>();
  let version: string | undefined;
  let description: string | undefined;
  let operations = 0;
  const serverHosts = new Set<string>();

  for (const { spec, sourceUrl } of usable) {
    const doc = spec as Json;

    // ── info: the first page to state something wins ──────────────────────
    const info = isObject(doc.info) ? doc.info : {};
    if (typeof info.title === "string" && info.title.trim() !== "") {
      titles.set(info.title, (titles.get(info.title) ?? 0) + 1);
    }
    if (!version && typeof info.version === "string") version = info.version;
    if (!description && typeof info.description === "string") description = info.description;

    // ── servers: one base URL survives, so a second host is load-bearing ──
    if (Array.isArray(doc.servers)) {
      for (const server of doc.servers) {
        const url = isObject(server) ? server.url : undefined;
        const host = typeof url === "string" ? hostOf(url) : null;
        if (host) serverHosts.add(host);
      }
      if (!servers || servers.length === 0) servers = doc.servers;
    }

    // ── paths: the union, and the reason any of this exists ───────────────
    const docPaths = isObject(doc.paths) ? doc.paths : {};
    for (const [path, rawItem] of Object.entries(docPaths)) {
      if (!isObject(rawItem)) continue;
      const target = isObject(paths[path]) ? (paths[path] as Json) : {};

      for (const [method, operation] of Object.entries(rawItem)) {
        if (target[method] !== undefined) {
          // Same endpoint documented on two pages. Routine on sites that
          // cross-list, so only worth saying when the two disagree.
          if (!sameShape(target[method], operation)) {
            warnings.push(
              `${method.toUpperCase()} ${path} is described differently on two pages; ` +
                `kept the first and ignored ${shortName(sourceUrl)}.`,
            );
          }
          continue;
        }
        target[method] = operation;
        // `parameters` is a sibling of the methods, not an operation itself.
        if (method !== "parameters" && method !== "servers" && method !== "$ref") {
          operations += 1;
        }
      }
      paths[path] = target;
    }

    // ── components: the $ref targets each fragment carries with it ────────
    const components = isObject(doc.components) ? doc.components : {};
    mergeNamed(securitySchemes, components.securitySchemes, "securitySchemes", sourceUrl, warnings);
    mergeNamed(schemas, components.schemas, "schemas", sourceUrl, warnings);
    // Swagger 2 keeps them at the root.
    mergeNamed(securitySchemes, doc.securityDefinitions, "securityDefinitions", sourceUrl, warnings);
    mergeNamed(schemas, doc.definitions, "definitions", sourceUrl, warnings);

    // ── security: the union feeds authFrom's declared-scheme bonus ────────
    if (Array.isArray(doc.security)) {
      for (const requirement of doc.security) {
        const key = JSON.stringify(requirement);
        if (seenSecurity.has(key)) continue;
        seenSecurity.add(key);
        security.push(requirement);
      }
    }
  }

  if (serverHosts.size > 1) {
    /*
     * Only one `baseUrl` survives into the entry, and it also becomes the
     * SSRF allowlist for every request. An operation belonging to a second
     * host would be silently repointed at the first and fail at run time
     * rather than at import, which is the worse place to find out.
     */
    warnings.push(
      `These pages describe ${serverHosts.size} different hosts (${[...serverHosts].join(", ")}). ` +
        `Only ${[...serverHosts][0]} was kept — endpoints belonging to the others will not work.`,
    );
  }

  if (operations === 0) return { merged: null, warnings, operations: 0 };

  // Ties fall to the first seen, which is insertion order on a Map.
  const title = [...titles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const merged: Json = {
    openapi: typeof first.openapi === "string" ? first.openapi : "3.0.0",
    info: {
      title: title ?? "API",
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
    },
    ...(servers ? { servers } : {}),
    ...(security.length > 0 ? { security } : {}),
    paths,
    ...(Object.keys(securitySchemes).length > 0 || Object.keys(schemas).length > 0
      ? {
          components: {
            ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
            ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
          },
        }
      : {}),
  };

  // Swagger 2 fragments carry `swagger` rather than `openapi`; keep whichever
  // the first document declared so `looksLikeOpenApi` and `specVersionOf` agree.
  if (typeof first.swagger === "string") {
    delete merged.openapi;
    merged.swagger = first.swagger;
    if (typeof first.host === "string") merged.host = first.host;
    if (typeof first.basePath === "string") merged.basePath = first.basePath;
    if (Array.isArray(first.schemes)) merged.schemes = first.schemes;
  }

  return { merged, warnings, operations };
};
