import {
  requestMatches,
  type ConnectionSpec,
  type ConnectorAuthority,
  type ConnectorDestination,
  type ConnectorPurpose,
  type ConnectorRequest,
} from "@freebirdai/connect-spec";
import { readSideOf, type ConnectorRequestEvent, type KnownWrite } from "../connector/host.js";

/**
 * The requests connector code may send, as templates.
 *
 * A POST is declared by the code's author and checked before the code ever
 * runs: its path must be one the documentation names, and never an endpoint
 * the catalog knows changes the account. A GET may be learned: while code is
 * proven, a GET anywhere on the service's own hosts is allowed, and what it
 * actually asked for becomes its templates. After that, nothing undeclared is
 * sent.
 */

/**
 * An id-looking path segment: a number, a UUID, a prefixed id (`exp_1`,
 * `inv-204`), or a long token with digits in it. Never a version (`v2`).
 */
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+[_-]\d[\w.~-]*|(?=[A-Za-z0-9_.~-]*\d)[A-Za-z0-9_.~-]{8,})$/i;
const VERSION = /^v\d+(\.\d+)*$/i;

/** A path with its ids as `{id}` placeholders, so the next record's request is the same request. */
export const generalizePath = (path: string): string => {
  let index = 0;
  return path
    .split("/")
    .map((segment) => {
      const plain = decodeURIComponent(segment);
      return segment !== "" && !VERSION.test(plain) && ID_SEGMENT.test(plain) ? `{id${++index === 1 ? "" : index}}` : segment;
    })
    .join("/");
};

/** A GET anywhere on a host the service owns: allowed only while code is being proven, then replaced by what it really sent. */
const PROVING = "proving-";

export const provingTemplates = (destinations: readonly ConnectorDestination[]): ConnectorRequest[] =>
  destinations.map((destination, index) => ({
    id: `${PROVING}${index + 1}`,
    purpose: destination.role === "download" ? "download" : "read",
    method: "GET",
    host: destination.host,
    path: "/**",
    credentials: destination.role === "download" ? [] : [...destination.credentials],
  }));

export const isProving = (template: ConnectorRequest): boolean => template.id.startsWith(PROVING);

/**
 * Templates for what a run actually sent, refused requests left out: each
 * method, host and path once, its ids generalized, carrying the credentials
 * its host may receive.
 */
export const templatesFromTrace = (
  events: readonly ConnectorRequestEvent[],
  destinations: readonly ConnectorDestination[],
  taken: ReadonlySet<string> = new Set(),
): ConnectorRequest[] => {
  const out: ConnectorRequest[] = [];
  const ids = new Set(taken);
  for (const event of events) {
    if (event.refused || event.status === null) continue;
    const destination = destinations.find((one) => one.host === event.host.toLowerCase());
    if (!destination) continue;
    const method = event.method.toUpperCase() as ConnectorRequest["method"];
    const path = generalizePath(event.path);
    if (out.some((one) => one.method === method && one.host === destination.host && one.path === path)) continue;
    /* A POST learned from what code sent says what it is by its path: a search, an export started. */
    const purpose: ConnectorPurpose =
      destination.role === "download"
        ? "download"
        : method === "POST" && event.purpose === "read"
          ? (readSideOf(path) ?? "read")
          : event.purpose;
    let id = `${purpose}-${out.length + 1}`;
    for (let suffix = 2; ids.has(id); suffix++) id = `${purpose}-${out.length + 1}-${suffix}`;
    ids.add(id);
    out.push({
      id,
      purpose,
      method,
      host: destination.host,
      path,
      credentials: destination.role === "download" ? [] : [...destination.credentials],
    });
  }
  return out;
};

/** What the documentation's paths look like, compared by shape: `{id}`, `:id` and `<id>` alike. */
const shape = (path: string): string =>
  path
    .replace(/\{\{\s*param\.[^}]*\}\}|\{[^/{}]+\}|:[A-Za-z_][\w-]*|<[^/<>]+>/g, "{}")
    .replace(/\/+$/, "")
    .toLowerCase();

/**
 * Whether the documentation names this path: as written on the host, or
 * relative to the connection's own address (`/v2/login` documented as
 * `/login`). The documentation is the only ground a POST is allowed on.
 */
export const namedInDocs = (path: string, docs: string, connection: Pick<ConnectionSpec, "baseUrl">): boolean => {
  let prefix = "";
  try {
    prefix = connection.baseUrl ? new URL(connection.baseUrl).pathname.replace(/\/+$/, "") : "";
  } catch {
    prefix = "";
  }
  const full = shape(path);
  const relative = prefix && full.startsWith(prefix.toLowerCase()) ? full.slice(prefix.length) || "/" : full;
  /* A path written inside a whole address — `https://api.example.com/xml/v1/request.api` — is named as much as one written alone. */
  const text = shape(docs.replace(/\\\//g, "/").replace(/https?:\/\/[^\s/"'<>`]+/gi, " "));
  const mentions = (candidate: string) =>
    candidate.length > 1 && new RegExp(`(^|[^a-z0-9_{}-])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`).test(text);
  return mentions(full) || mentions(relative);
};

/** The catalog's endpoints that change the account, as templates on the connection's own host. */
const writeTemplates = (writes: readonly KnownWrite[], connection: Pick<ConnectionSpec, "baseUrl">) => {
  let base: URL;
  try {
    base = new URL(connection.baseUrl ?? "");
  } catch {
    return [];
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  return writes.map((write) => ({
    method: write.method.toUpperCase(),
    host: base.hostname.toLowerCase(),
    path: `${prefix}${write.path.startsWith("/") ? "" : "/"}${write.path}`
      .replace(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g, "{$1}")
      .replace(/\/+$/, ""),
  }));
};

/**
 * Why these templates may not be installed, or null. A POST must be named by
 * the documentation, and no template may be one of the catalog's endpoints
 * that change the account — matched both ways, since either may hold the
 * placeholder.
 */
export const templatesProblem = (
  templates: readonly ConnectorRequest[],
  context: { readonly docs: string; readonly writes: readonly KnownWrite[]; readonly connection: Pick<ConnectionSpec, "baseUrl"> },
): string | null => {
  const writes = writeTemplates(context.writes, context.connection);
  for (const template of templates) {
    if (isProving(template)) continue;
    const concrete = template.path.replace(/\{[^/{}]+\}/g, "x");
    const write = writes.find(
      (one) =>
        (requestMatches(one, template.method, template.host, concrete) ||
          requestMatches(template, one.method, one.host, one.path.replace(/\{[^/{}]+\}/g, "x"))) &&
        /*
         * A sign-in, a search or an export the catalog imported among its
         * writes, declared as exactly that: a read's own step, not a change.
         */
        readSideOf(one.path) !== template.purpose,
    );
    if (write)
      return `${template.id} (${template.method} ${template.path}) is an endpoint that changes things in the account; a connector only reads.`;
    if (template.method === "POST" && !namedInDocs(template.path, context.docs, context.connection))
      return `${template.id} (POST ${template.path}) is not a path the documentation names, and a POST is sent only where it does.`;
  }
  return null;
};

/**
 * Templates with one id each: the same request declared twice is kept once,
 * and two requests declared under one name are told apart. A model listing
 * its requests beside ones already declared once had every connection it
 * proposed refused for a repeated name (seen with the twofold mock API).
 */
export const uniqueTemplates = (templates: readonly ConnectorRequest[]): ConnectorRequest[] => {
  const out: ConnectorRequest[] = [];
  for (const template of templates) {
    if (out.some((one) => one.method === template.method && one.host === template.host && one.path === template.path && one.purpose === template.purpose))
      continue;
    let id = template.id;
    for (let suffix = 2; out.some((one) => one.id === id); suffix++) id = `${template.id.slice(0, 36)}-${suffix}`;
    out.push(id === template.id ? template : { ...template, id });
  }
  return out;
};

/** One line per template, for the model and the log. */
export const describeTemplate = (template: ConnectorRequest): string =>
  `${template.id}: ${template.method} ${template.host}${template.path} (${template.purpose})`;

/** Two authorities as one: every host with every method and credential either allows, and every template either declares. */
export const mergeAuthority = (base: ConnectorAuthority, more: ConnectorAuthority): ConnectorAuthority => {
  const destinations = [...base.destinations];
  for (const destination of more.destinations) {
    const index = destinations.findIndex((one) => one.host === destination.host);
    if (index < 0) destinations.push(destination);
    else {
      const held = destinations[index]!;
      destinations[index] = {
        ...held,
        methods: [...new Set([...held.methods, ...destination.methods])],
        credentials: [...new Set([...held.credentials, ...destination.credentials])],
      };
    }
  }
  const exchanges = [...base.exchanges, ...more.exchanges.filter((one) => !base.exchanges.some((held) => held.name === one.name))];
  const templates =
    base.templates || more.templates
      ? uniqueTemplates([
          ...(base.templates ?? []).filter((one) => !(more.templates ?? []).some((other) => other.id === one.id)),
          ...(more.templates ?? []),
        ])
      : undefined;
  return { ...base, destinations, exchanges, ...(templates ? { templates } : {}) };
};
