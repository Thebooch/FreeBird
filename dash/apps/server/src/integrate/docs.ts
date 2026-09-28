import { extractText } from "../discovery/docs.js";
import { looksLikeOpenApi, parseSpecDocument } from "../discovery/openapi.js";

/**
 * What the documentation says, read once per integration and only when a
 * repair needs it.
 *
 * These are documentation reads — public pages, never the account — so they
 * are not counted against the request budget, but they are capped: three
 * documents is what a person would open before asking somebody.
 */
export interface DocsKnowledge {
  /** The documentation's text: the page, the specification's own prose, the key help. */
  text(): Promise<string>;
  /** The specification, parsed, when there is one. */
  spec(): Promise<Record<string, unknown> | null>;
  /**
   * The specification's endpoints in words: each one's method, path, inputs,
   * body and answers, and its sign-in schemes. What somebody writing code for
   * the API reads — `text()` is only the prose around it.
   */
  outline(): Promise<string>;
}

const DOCUMENT_CAP = 3;

export const docsKnowledge = (input: {
  readonly docsUrl?: string | undefined;
  readonly specUrl?: string | undefined;
  /** Text already known: key help, notes. */
  readonly known?: readonly string[];
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
}): DocsKnowledge => {
  let fetched = 0;
  const read = async (url: string | undefined): Promise<string | null> => {
    if (!url || fetched >= DOCUMENT_CAP) return null;
    fetched++;
    try {
      const document = await input.fetchDocument(url);
      return document.status >= 200 && document.status < 300 ? document.text : null;
    } catch {
      return null;
    }
  };

  let specPromise: Promise<Record<string, unknown> | null> | null = null;
  const spec = () =>
    (specPromise ??= (async () => {
      const text = await read(input.specUrl ?? (input.docsUrl && /\.(json|ya?ml)$/i.test(input.docsUrl) ? input.docsUrl : undefined));
      if (!text) return null;
      try {
        const parsed = parseSpecDocument(text);
        return looksLikeOpenApi(parsed) && parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })());

  let textPromise: Promise<string> | null = null;
  const text = () =>
    (textPromise ??= (async () => {
      const parts: string[] = [...(input.known ?? [])];
      const page = input.docsUrl && input.docsUrl !== input.specUrl ? await read(input.docsUrl) : null;
      if (page) parts.push(/<[a-z!]/i.test(page) ? extractText(page) : page);
      const document = await spec();
      const info = document?.info as { description?: unknown } | undefined;
      if (typeof info?.description === "string") parts.push(info.description);
      return parts.join("\n\n");
    })());

  let outlinePromise: Promise<string> | null = null;
  const outline = () =>
    (outlinePromise ??= (async () => {
      const document = await spec();
      return document ? specOutline(document) : "";
    })());

  return { text, spec, outline };
};

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** Follow a local `$ref`, a few deep. */
const resolve = (doc: Json, value: unknown, depth = 0): unknown => {
  if (!isJson(value) || typeof value.$ref !== "string" || depth > 5) return value;
  const path = value.$ref.replace(/^#\//, "").split("/");
  let here: unknown = doc;
  for (const step of path) here = isJson(here) ? here[step.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return resolve(doc, here, depth + 1);
};

/** A schema in a line: `id: string, amount: number — In cents.`, one level of properties. */
const shape = (doc: Json, raw: unknown, depth = 0): string => {
  const schema = resolve(doc, raw);
  if (!isJson(schema)) return "";
  const type = str(schema.type);
  if (type === "array") {
    const items = shape(doc, schema.items, depth + 1);
    return items ? `a list of { ${items} }` : "a list";
  }
  const properties = isJson(schema.properties) ? schema.properties : null;
  if (!properties) return type ?? "";
  return Object.entries(properties)
    .slice(0, 25)
    .map(([name, rawProperty]) => {
      const property = resolve(doc, rawProperty);
      if (!isJson(property)) return name;
      const inner = depth < 1 && (isJson(property.properties) || str(property.type) === "array") ? shape(doc, property, depth + 1) : "";
      const kind = inner && inner !== str(property.type) ? inner : (str(property.type) ?? "");
      const note = str(property.description);
      return `${name}${kind ? `: ${kind}` : ""}${note ? ` (${note.slice(0, 120)})` : ""}`;
    })
    .join(", ");
};

const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

/**
 * An OpenAPI or Swagger document as a developer would skim it: servers, sign-in
 * schemes, then every endpoint with its inputs and answers. Bounded, so a very
 * large specification is cut rather than crowding out everything else.
 */
export const specOutline = (doc: Json, limit = 12_000): string => {
  const lines: string[] = [];
  const servers = Array.isArray(doc.servers)
    ? doc.servers.map((one) => (isJson(one) ? str(one.url) : undefined)).filter((one): one is string => !!one)
    : str(doc.host)
      ? [`${Array.isArray(doc.schemes) ? String(doc.schemes[0]) : "https"}://${String(doc.host)}${str(doc.basePath) ?? ""}`]
      : [];
  if (servers.length > 0) lines.push(`Servers: ${servers.join(", ")}`);
  const components = isJson(doc.components) ? doc.components : {};
  const schemes = { ...(isJson(doc.securityDefinitions) ? doc.securityDefinitions : {}), ...(isJson(components.securitySchemes) ? components.securitySchemes : {}) };
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = resolve(doc, raw);
    if (!isJson(scheme)) continue;
    const parts = [str(scheme.type), str(scheme.scheme), str(scheme.in) && `in ${String(scheme.in)}`, str(scheme.name)].filter(Boolean);
    lines.push(`Sign-in scheme "${name}": ${parts.join(" ")}${str(scheme.description) ? ` — ${str(scheme.description)}` : ""}`);
  }
  lines.push("Endpoints:");
  const paths = isJson(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(doc, rawItem);
    if (!isJson(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!isJson(operation)) continue;
      const summary = str(operation.summary) ?? str(operation.operationId) ?? "";
      lines.push(`${method.toUpperCase()} ${path}${summary ? ` — ${summary}` : ""}`);
      const description = str(operation.description);
      if (description) lines.push(`  ${description.slice(0, 400)}`);
      const params = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .map((raw) => resolve(doc, raw))
        .filter(isJson);
      const body = params.find((param) => param.in === "body");
      for (const param of params.filter((one) => one.in !== "body")) {
        const schema = resolve(doc, param.schema);
        const type = str(param.type) ?? (isJson(schema) ? str(schema.type) : undefined);
        const fallback = isJson(schema) && schema.default !== undefined ? `, default ${JSON.stringify(schema.default)}` : "";
        lines.push(
          `  ${String(param.in)} ${String(param.name)}${type ? ` (${type}${param.required ? ", required" : ""}${fallback})` : ""}${str(param.description) ? ` — ${str(param.description)!.slice(0, 200)}` : ""}`,
        );
      }
      const requestBody = resolve(doc, operation.requestBody);
      if (isJson(requestBody) && isJson(requestBody.content)) {
        for (const [type, entry] of Object.entries(requestBody.content))
          lines.push(`  Body (${type}): ${isJson(entry) ? shape(doc, entry.schema) : ""}`);
      } else if (body) lines.push(`  Body: ${shape(doc, body.schema)}`);
      const responses = isJson(operation.responses) ? operation.responses : {};
      for (const [code, rawResponse] of Object.entries(responses)) {
        const response = resolve(doc, rawResponse);
        if (!isJson(response)) continue;
        const content = isJson(response.content) ? Object.entries(response.content) : [];
        const described = str(response.description);
        if (content.length === 0)
          lines.push(`  ${code}: ${described ?? ""}${response.schema ? ` ${shape(doc, response.schema)}` : ""}`);
        for (const [type, entry] of content)
          lines.push(`  ${code} (${type}): ${described ? `${described} ` : ""}${isJson(entry) ? shape(doc, entry.schema) : ""}`);
      }
    }
  }
  const text = lines.join("\n");
  return text.length > limit ? `${text.slice(0, limit)}\n(the specification continues)` : text;
};
