import { parseSpecDocument } from "./openapi.js";

/**
 * Pull an OpenAPI document out of a documentation page that embeds it.
 *
 * The three common docs renderers — Redoc, Swagger UI and Stoplight — all ship
 * the entire spec inside the HTML rather than linking to a `.json` file. When
 * they do, the page *is* the spec: exact, complete, machine-readable, and worth
 * far more than any amount of reading the prose around it.
 *
 * Buildium is the case that motivated this. Its docs page is 11MB of HTML with
 * a 2MB OpenAPI 3.0.4 document inlined at `__redoc_state`, 298 endpoints, and
 * no standalone spec URL published anywhere. Without this, the only way to
 * connect it is to type every endpoint by hand.
 *
 * This is deterministic: no model, no inference. Either a spec is in there or
 * it isn't.
 */

/** Markers that precede an embedded document, and how to unwrap what follows. */
const MARKERS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
  /** Dig the spec out of the surrounding state object. */
  readonly unwrap: (value: unknown) => unknown;
}> = [
  {
    // Redoc: window.__redoc_state = { menu: …, spec: { data: <the spec> } }
    pattern: /__redoc_state\s*=\s*/,
    label: "Redoc",
    unwrap: (value) => {
      const spec = (value as { spec?: { data?: unknown } })?.spec;
      return spec?.data ?? value;
    },
  },
  {
    // Swagger UI: SwaggerUIBundle({ spec: <the spec>, … })
    pattern: /SwaggerUIBundle\s*\(\s*/,
    label: "Swagger UI",
    unwrap: (value) => (value as { spec?: unknown })?.spec ?? value,
  },
  {
    // Stoplight Elements and various hand-rolled embeds.
    pattern: /(?:window\.)?__(?:SPEC|OPENAPI|API_SPEC|STOPLIGHT_SPEC)__\s*=\s*/,
    label: "embedded",
    unwrap: (value) => value,
  },
];

/**
 * Read one balanced JSON value starting at `start`, which must be `{` or `[`.
 *
 * A regex cannot do this — the document is megabytes of nested objects whose
 * string values contain braces of their own. So this tracks string state and
 * backslash escapes, which is the only way to know that a `}` is structural
 * rather than part of someone's description text.
 *
 * Returns null if the value never closes (truncated page, or the marker
 * matched something that was not JSON after all).
 */
export const readJsonValueAt = (source: string, start: number): string | null => {
  const opener = source[start];
  if (opener !== "{" && opener !== "[") return null;
  const closer = opener === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
};

/**
 * A spec inside a fenced code block, which is how Markdown carries one.
 *
 * The three markers above all assume a rendered HTML page with the document
 * assigned to a global. That assumption broke once docs platforms started
 * content-negotiating a `.md` rendering to non-browser clients: the same page
 * a browser gets as Redoc HTML arrives here as Markdown with the spec sitting
 * in a ```yaml fence. It is every bit as exact — and was being ignored.
 */
const FENCE = /```+[^\n]*\n([\s\S]*?)```+/g;

const fencedSpecIn = (
  text: string,
  isSpec: (value: unknown) => boolean,
): InlineSpec | null => {
  FENCE.lastIndex = 0;
  for (const match of text.matchAll(FENCE)) {
    const body = match[1];
    // A fence is only worth parsing if it declares a spec version — otherwise
    // every shell snippet on the page gets run through the YAML parser.
    if (!body || !/^\s*(openapi|swagger)\s*:/m.test(body)) continue;

    const parsed = parseSpecDocument(body);
    if (isSpec(parsed)) return { spec: parsed, label: "fenced" };
  }
  return null;
};

export interface InlineSpec {
  readonly spec: unknown;
  /** Which renderer it came from, for the message the user reads. */
  readonly label: string;
}

/**
 * Find an embedded OpenAPI document, or null.
 *
 * `isSpec` is injected rather than imported so this module stays a pure text
 * utility and the openapi module keeps ownership of what counts as a spec.
 */
export const extractInlineSpec = (
  html: string,
  isSpec: (value: unknown) => boolean,
): InlineSpec | null => {
  for (const marker of MARKERS) {
    // A page can define the same global more than once; take the first that
    // actually parses into something spec-shaped.
    let from = 0;
    for (;;) {
      const match = marker.pattern.exec(html.slice(from));
      if (!match) break;

      const valueStart = from + match.index + match[0].length;
      from = valueStart;

      const raw = readJsonValueAt(html, valueStart);
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON — a function call, a JS object literal with unquoted keys,
        // or a truncated blob. Nothing recoverable, so move on.
        continue;
      }

      const candidate = marker.unwrap(parsed);
      if (isSpec(candidate)) return { spec: candidate, label: marker.label };
    }
  }

  // Last, because a rendered page's own state object is more likely to be the
  // complete document than a fence, which may hold only one endpoint.
  return fencedSpecIn(html, isSpec);
};
