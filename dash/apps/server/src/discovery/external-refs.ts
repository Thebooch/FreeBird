import { parse as parseYaml } from "yaml";
import { sameSite } from "../integrate/patch.js";
import { parseSpecDocument } from "./openapi.js";

/**
 * A specification split across files, put back together.
 *
 * `$ref: "paths/invoices.yaml"` points into another file, and the importer
 * reads one document: a specification whose paths all live elsewhere imported
 * as nothing at all, and said only that external references were "not
 * supported yet" (plan, track C). Each file is fetched once, through the same
 * public-document reader as the specification itself, and only from the
 * specification's own site — a reference is an address a document chose, and
 * it is followed no further than the document's own organisation.
 *
 * Inside a fetched file, `#/…` means that file, so its own references are
 * resolved there too. A reference that comes back round to itself is left as
 * it was: a cycle is a schema describing itself, not something to unroll.
 */

type FetchDocument = (url: string) => Promise<{ status: number; text: string; url: string }>;

export interface ExternalRefsResult {
  readonly doc: unknown;
  /** Files read, and references that could not be followed, in words. */
  readonly read: number;
  readonly unresolved: readonly string[];
}

const MAX_FILES = 40;
const MAX_DEPTH = 24;
const MAX_NODES = 400_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A JSON pointer's target, or undefined. `#/components/schemas/Pet`, with `~1` for `/` and `~0` for `~`. */
const pointAt = (doc: unknown, pointer: string): unknown => {
  if (pointer === "" || pointer === "/") return doc;
  let node: unknown = doc;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
  }
  return node;
};

/** Whether a document refers into any other file. */
export const hasExternalRefs = (doc: unknown): boolean => {
  let budget = MAX_NODES;
  const walk = (node: unknown): boolean => {
    if (--budget < 0) return false;
    if (Array.isArray(node)) return node.some(walk);
    if (!isObject(node)) return false;
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) return true;
    return Object.values(node).some(walk);
  };
  return walk(doc);
};

export const resolveExternalRefs = async (
  doc: unknown,
  specUrl: string,
  fetchDocument: FetchDocument,
): Promise<ExternalRefsResult> => {
  if (!hasExternalRefs(doc)) return { doc, read: 0, unresolved: [] };
  let origin: URL;
  try {
    origin = new URL(specUrl);
  } catch {
    return { doc, read: 0, unresolved: [] };
  }

  const files = new Map<string, Promise<unknown>>();
  const unresolved: string[] = [];
  let nodes = MAX_NODES;

  const load = (url: string): Promise<unknown> => {
    const known = files.get(url);
    if (known) return known;
    if (files.size >= MAX_FILES) return Promise.resolve(undefined);
    const loading = fetchDocument(url)
      .then((answer) => (answer.status === 200 ? parseSpecDocument(answer.text) ?? parseAny(answer.text) : undefined))
      .catch(() => undefined);
    files.set(url, loading);
    return loading;
  };

  /**
   * One node, with the file it came from: `base` is that file's address and
   * `root` its parsed whole, which `#/…` inside it points into. The main
   * document's own `#/…` references are left for the importer, which reads them.
   */
  const resolve = async (node: unknown, base: string, root: unknown, depth: number, trail: readonly string[]): Promise<unknown> => {
    if (--nodes < 0 || depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) return Promise.all(node.map((item) => resolve(item, base, root, depth, trail)));
    if (!isObject(node)) return node;

    const ref = node.$ref;
    if (typeof ref === "string") {
      const [file, pointer = ""] = ref.split("#");
      const inMain = !file && base === specUrl;
      if (!inMain) {
        let target: string;
        try {
          target = file ? new URL(file, base).toString() : base;
        } catch {
          unresolved.push(ref);
          return node;
        }
        const key = `${target}#${pointer}`;
        if (trail.includes(key)) return node;
        if (file && !sameSite(new URL(target).hostname, origin.hostname)) {
          unresolved.push(ref);
          return node;
        }
        const whole = file ? await load(target) : root;
        const found = whole === undefined ? undefined : pointAt(whole, pointer);
        if (found === undefined) {
          unresolved.push(ref);
          return node;
        }
        /* Siblings of a `$ref` (a description beside it) are kept over what it points at. */
        const { $ref: _ref, ...beside } = node;
        const resolved = await resolve(found, target, whole, depth + 1, [...trail, key]);
        return isObject(resolved) && Object.keys(beside).length > 0 ? { ...resolved, ...beside } : resolved;
      }
    }

    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) out[name] = await resolve(value, base, root, depth, trail);
    return out;
  };

  const resolved = await resolve(doc, specUrl, doc, 0, []);
  return { doc: resolved, read: files.size, unresolved: [...new Set(unresolved)].slice(0, 20) };
};

/** A referenced file that is a fragment — a schema, a path item — not a whole specification. */
const parseAny = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    /* not JSON */
  }
  try {
    return parseYaml(text, { maxAliasCount: 100 });
  } catch {
    return undefined;
  }
};
