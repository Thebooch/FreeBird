import { sameSite } from "../integrate/patch.js";
import { resolveExternalRefs } from "./external-refs.js";
import { mergeSpecDocuments, type SpecFragment } from "./merge-specs.js";
import { looksLikeOpenApi, parseSpecDocument } from "./openapi.js";

/**
 * An API that publishes one specification per service, and a list of them.
 *
 * `GET /openapi` answering `{ specs: [{ name, url }] }` is how a large API
 * describes itself when no single document covers it (`urls` is the same list
 * as Swagger UI configures it). The list is no specification, so it was
 * skipped as one, and with no spec found the reading fell to a model and the
 * API's overview page: 12 endpoints of a real API's 198.
 *
 * Every service is fetched and merged at the document level, as pages are in
 * `readIndex`, so one `parseOpenApi` sees the whole API and resources span
 * services. The merged document is what the importer reads, and the list's
 * address stays the `specUrl`, so anything reading it again comes back here.
 */

type FetchDocument = (url: string) => Promise<{ status: number; text: string; url: string }>;

/** As many files as a split specification may be read from. */
const MAX_SPECS = 40;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The specifications a directory lists, or nothing when this is not one. */
export const specDirectoryIn = (doc: unknown, url: string): string[] => {
  if (!isObject(doc) || looksLikeOpenApi(doc)) return [];
  const listed = Array.isArray(doc.specs) ? doc.specs : Array.isArray(doc.urls) ? doc.urls : [];
  const found = new Set<string>();
  for (const item of listed) {
    if (!isObject(item) || typeof item.url !== "string") continue;
    try {
      found.add(new URL(item.url, url).toString());
    } catch {
      /* not a usable URL */
    }
  }
  return [...found];
};

/**
 * The API's name, from its services': "Coval Agents API" and "Coval Runs API"
 * are the "Coval API". Many titles open with it rather than all, because some
 * services are only "Test Sets API".
 */
const sharedTitle = (titles: readonly string[]): string | null => {
  const split = titles.map((title) => title.trim().split(/\s+/));
  const counts = new Map<string, number>();
  for (const words of split) counts.set(words[0]!, (counts.get(words[0]!) ?? 0) + 1);
  const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!name || count! < 2 || count! * 3 < titles.length) return null;
  const last = split[0]!.at(-1)!;
  const closing = last !== name && split.every((words) => words.at(-1) === last);
  return closing ? `${name} ${last}` : name;
};

/**
 * The whole API when `doc` is a directory of specifications; `doc` otherwise,
 * so a caller can pass every document it reads through here.
 */
export const gatherSpecDirectory = async (
  doc: unknown,
  url: string,
  fetchDocument: FetchDocument,
  said: { readonly warnings?: string[]; readonly tried?: string[] } = {},
): Promise<unknown> => {
  /* An address a document chose: followed no further than its own organisation, as references are. */
  const listed = specDirectoryIn(doc, url).filter((candidate) =>
    sameSite(new URL(candidate).hostname, new URL(url).hostname),
  );
  if (listed.length === 0) return doc;
  if (listed.length > MAX_SPECS)
    said.warnings?.push(`This API lists ${listed.length} specifications; the first ${MAX_SPECS} were read.`);

  const fragments: SpecFragment[] = [];
  const titles: string[] = [];
  const missed: string[] = [];
  for (const candidate of listed.slice(0, MAX_SPECS)) {
    said.tried?.push(candidate);
    try {
      const response = await fetchDocument(candidate);
      const spec = response.status < 400 ? parseSpecDocument(response.text) : null;
      if (!looksLikeOpenApi(spec)) {
        missed.push(candidate);
        continue;
      }
      /* Before merging: a reference to another file means relative to this one. What stays unfollowed is said once, of the whole. */
      const whole = await resolveExternalRefs(spec, response.url, fetchDocument);
      fragments.push({ spec: whole.doc, sourceUrl: response.url });
      const title = isObject(spec) && isObject(spec.info) ? spec.info.title : undefined;
      if (typeof title === "string" && title.trim() !== "") titles.push(title);
    } catch {
      missed.push(candidate);
    }
  }

  const { merged, warnings } = mergeSpecDocuments(fragments, { keepApart: true });
  if (!merged) return doc;
  said.warnings?.push(
    `This API publishes ${listed.length} specifications, one per service; ${fragments.length} were read and combined.`,
    ...warnings,
  );
  if (missed.length > 0)
    said.warnings?.push(`Some of its specifications could not be read: ${missed.slice(0, 3).join(", ")}.`);
  const title = sharedTitle(titles);
  return title ? { ...merged, info: { ...(merged.info as object), title } } : merged;
};
