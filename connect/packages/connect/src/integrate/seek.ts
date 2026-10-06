import type { CatalogEntry, ConnectionSpec, ResourceSpec } from "@freebirdai/connect-spec";
import { endpointsNamed } from "../discovery/docs.js";
import { integrate, type IntegrateDeps, type IntegrationReport } from "./agent.js";
import { docsKnowledge } from "./docs.js";
import { withObservedFields } from "./observed.js";
import { applyPatch } from "./patch.js";

/**
 * Finding the records a request is about where nothing imported holds them.
 *
 * A brief that finds no record type for a request, or a check after which
 * none could be described, once ended the setup. Often the documentation
 * names the endpoint all along — `GET /charges` in its prose, a path in a
 * table — and the import never took it. Here the documentation is read again
 * for the endpoints it names on the API's own address, the ones whose path
 * shares a word with the request are added, and each is checked like any
 * other: kept only when it answers with records. The caller writes the brief
 * once more.
 *
 * Nothing is added from a model's guess: only a path the documentation
 * itself names, under the connection's own address.
 */

/** At most this many endpoints are tried for one request. */
const MAX_SOUGHT = 4;

const STOP = new Set([
  "how", "many", "much", "the", "are", "was", "were", "what", "which", "who", "total", "count", "number", "have", "has",
  "been", "with", "from", "this", "that", "our", "all", "every", "each", "last", "this", "month", "year", "week", "day",
  "today", "still", "and", "for", "per", "any", "there", "into", "over", "their", "they", "them", "average", "sum",
]);

const singular = (word: string): string =>
  word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ses") ? word.slice(0, -2) : word.endsWith("s") ? word.slice(0, -1) : word;

/** The request's own nouns, in the form a path writes them. */
const wordsOf = (request: string): Set<string> =>
  new Set(
    request
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP.has(word))
      .map(singular),
  );

const shape = (path: string): string => path.replace(/\{\{[^}]*\}\}|\{[^/{}]+\}/g, "{}").replace(/\/+$/, "").toLowerCase();

export interface Sought {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
  /** The endpoints added, each of which answered with records. */
  readonly added: readonly string[];
  readonly report: IntegrationReport;
  readonly log: readonly string[];
}

export const seekRecords = async (input: {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
  readonly request: string;
  readonly docsUrl?: string | undefined;
  readonly deps: IntegrateDeps;
  /** Requests the endpoints' checks may spend between them. */
  readonly requests?: number;
}): Promise<Sought | null> => {
  const { connection, entry } = input;
  const log: string[] = [];
  let base: URL;
  try {
    base = new URL(connection.baseUrl ?? "");
  } catch {
    return null;
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const docs = docsKnowledge({
    docsUrl: input.docsUrl ?? entry.docsUrl,
    specUrl: entry.specUrl,
    known: [entry.keyHelp, entry.notes].filter((one): one is string => !!one),
    fetchDocument: input.deps.fetchDocument,
  });
  const text = [await docs.outline(), await docs.text()].join("\n");
  const named = endpointsNamed({ text, codeBlocks: [], isClientRendered: false, reason: null });

  /* Each a path under the connection's own address, without an id nobody gives, and not one it reads already. */
  const have = new Set(connection.ops.map((op) => shape(op.path)));
  const wanted = wordsOf(input.request);
  const found = new Map<string, number>();
  for (const one of named) {
    const raw = one.replace(/^(GET|PATH) /, "");
    let path: string;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
        path = url.pathname;
      } catch {
        continue;
      }
    } else if (raw.startsWith("/")) path = raw.split(/[?#]/)[0]!;
    else continue;
    if (prefix && path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) path = path.slice(prefix.length);
    path = path.replace(/\/+$/, "");
    if (path === "" || /[{}:<>]/.test(path) || have.has(shape(path))) continue;
    const segments = path.toLowerCase().split("/").filter(Boolean).map(singular);
    const score = segments.filter((segment) => wanted.has(segment) || [...wanted].some((word) => segment.split(/[_-]/).includes(word))).length;
    if (score > 0) found.set(path, Math.max(found.get(path) ?? 0, score));
  }
  const paths = [...found.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, MAX_SOUGHT).map(([path]) => path);
  if (paths.length === 0) return null;

  const taken = new Set(connection.ops.map((op) => op.id));
  const ops: CatalogEntry["ops"][number][] = [];
  const resources: ResourceSpec[] = [];
  for (const path of paths) {
    const last = path.split("/").filter(Boolean).pop() ?? "records";
    let id = path.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase().slice(0, 60) || "records";
    for (let suffix = 2; taken.has(id); suffix++) id = `${id.slice(0, 56)}-${suffix}`;
    taken.add(id);
    const title = `List ${last.replace(/[_-]+/g, " ")}`;
    ops.push({ id, title, method: "GET", path, archetype: "list", params: [], query: {} } as CatalogEntry["ops"][number]);
    let resource = singular(last.toLowerCase()).replace(/[^a-z0-9-]/g, "-") || "record";
    for (let suffix = 2; [...connection.resources, ...resources].some((one) => one.id === resource); suffix++) resource = `${singular(last.toLowerCase())}-${suffix}`;
    resources.push({ id: resource, title: last.replace(/[_-]+/g, " "), listOp: id, relations: [], verified: false });
  }
  log.push(`Looked for what "${input.request}" is about among the endpoints the documentation names: ${paths.join(", ")}.`);

  const trial = applyPatch(connection, { reads: { ops, resources } });
  if (!trial) return null;
  const ids = ops.map((op) => op.id);
  const report = await integrate(
    trial,
    {
      targets: ids,
      entry: { ...entry, ops: [...entry.ops, ...ops], resources: [...entry.resources, ...resources] },
      ...(input.docsUrl ? { docsUrl: input.docsUrl } : {}),
      requests: input.requests ?? 30,
      objective: input.request,
    },
    input.deps,
  );
  log.push(...report.log);
  const ready = report.ops.filter((one) => one.outcome === "ready" && ids.includes(one.op)).map((one) => one.op);
  if (ready.length === 0) {
    log.push("None of them answered with records.");
    return { connection, entry, added: [], report, log };
  }
  /* Only what answered is kept: an endpoint the documentation names that holds nothing is not a record type. */
  const kept: ConnectionSpec = {
    ...report.connection,
    ops: report.connection.ops.filter((op) => !ids.includes(op.id) || ready.includes(op.id)),
    resources: report.connection.resources.filter((one) => !one.listOp || !ids.includes(one.listOp) || ready.includes(one.listOp)),
  };
  const grown: CatalogEntry = {
    ...entry,
    ops: [...entry.ops, ...ops.filter((op) => ready.includes(op.id))],
    resources: [...entry.resources, ...resources.filter((one) => one.listOp !== undefined && ready.includes(one.listOp))],
  };
  log.push(`Added ${ready.length} endpoint(s) the documentation names and the import missed: ${ready.join(", ")}.`);
  return { connection: kept, entry: withObservedFields(grown, report.observed) ?? grown, added: ready, report, log };
};
