import type { AuthSpec, ConnectionSpec, OpSpec } from "@freebirdai/connect-spec";
import { requiredHeadersFor } from "../discovery/openapi.js";
import type { DocsKnowledge } from "./docs.js";
import type { ConnectionPatch } from "./patch.js";
import { sameSite } from "./patch.js";
import type { Attempt, DiagnosisKind } from "./read.js";

/**
 * Repairs a developer would try first, before asking anybody anything.
 *
 * Each strategy reads one kind of failure and proposes changes in the
 * connection's own vocabulary, most likely first. None of them sends a key
 * anywhere new except to a host under the same organisation's domain, and
 * none guesses a value the API or its documentation did not state: a header
 * value comes from the specification, an address from the documentation's
 * own text. The loop tries them within its budget and keeps the first that
 * gets further.
 *
 * A plug-in point: `IntegrateDeps.strategies` replaces this list, so a fork
 * (or a hosted build that has seen more APIs) can add its own.
 */

export interface RepairContext {
  readonly connection: ConnectionSpec;
  readonly op: OpSpec;
  readonly attempt: Attempt;
  readonly docs: DocsKnowledge;
  /** Where discovery started, for the same-site rule. */
  readonly docsUrl?: string | undefined;
}

export interface Candidate {
  readonly patch: ConnectionPatch;
  /** Why this is worth trying, in words for the log. */
  readonly because: string;
}

export interface RepairStrategy {
  readonly id: string;
  readonly handles: readonly DiagnosisKind[];
  propose(context: RepairContext): Promise<Candidate[]>;
}

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

/* ── The address ──────────────────────────────────────────────────────── */

const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%/{}-]*)?/g;
const PREFIXES = ["/v1", "/v2", "/v3", "/api", "/api/v1"];

/**
 * An address the documentation names, cut back to where the API starts.
 *
 * A URL ending in the endpoint's own path (`…/v1/widgets` for `/widgets`) is
 * the example request, and what precedes the path is the base. Otherwise the
 * URL is cut after its last version-like segment.
 */
const baseFrom = (url: string, opPath: string): string | null => {
  const clean = url.replace(/[.,;)]+$/, "").replace(/\/+$/, "");
  const path = opPath.replace(/\{\{[^}]*\}\}/g, "").replace(/\/+$/, "");
  if (path && clean.endsWith(path)) return clean.slice(0, clean.length - path.length) || null;
  try {
    const parsed = new URL(clean);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let version = -1;
    segments.forEach((segment, index) => {
      if (/^(v\d+(\.\d+)?|api)$/i.test(segment)) version = index;
    });
    return `${parsed.origin}${version >= 0 ? `/${segments.slice(0, version + 1).join("/")}` : ""}`;
  } catch {
    return null;
  }
};

export const addressStrategy: RepairStrategy = {
  id: "address",
  handles: ["notFound", "notJson", "unreachable"],
  async propose({ connection, op, docs, docsUrl }) {
    const current = connection.baseUrl ?? "";
    const currentHost = hostOf(current);
    const docsHost = hostOf(docsUrl);
    const allowed = (url: string) => {
      const host = hostOf(url);
      if (!host || !url.startsWith("https://")) return false;
      return [currentHost, docsHost].some((known) => known !== null && sameSite(host, known));
    };

    const seen = new Set<string>([current.replace(/\/+$/, "")]);
    const out: Candidate[] = [];
    const add = (base: string | null, because: string) => {
      if (!base) return;
      const clean = base.replace(/\/+$/, "");
      if (seen.has(clean) || !allowed(clean)) return;
      seen.add(clean);
      out.push({ patch: { baseUrl: clean }, because });
    };

    const text = await docs.text();
    for (const found of text.match(URL_RE) ?? []) {
      if (found.includes("{") || /\.(html?|png|svg|css|js|json|ya?ml)$/i.test(found)) continue;
      add(baseFrom(found, op.path), `the documentation names ${found.replace(/\/+$/, "")}`);
    }
    const spec = await docs.spec();
    const servers = Array.isArray(spec?.servers) ? (spec!.servers as Array<{ url?: unknown }>) : [];
    for (const server of servers) {
      if (typeof server.url === "string" && /^https:\/\//.test(server.url) && !server.url.includes("{"))
        add(server.url, `the specification lists ${server.url}`);
    }
    try {
      const parsed = new URL(current);
      const trimmed = parsed.pathname.replace(/\/+$/, "");
      /*
       * The address already holds the start of the endpoint's own path —
       * `…/rest/api/3` and `/rest/api/3/search/jql` — so every request sends it
       * twice. Tried first, before any guess (seen with the trackwell mock
       * API).
       */
      if (trimmed !== "" && op.path.startsWith(`${trimmed}/`)) add(parsed.origin, `the address repeats the start of ${op.path}`);
      for (const prefix of PREFIXES) {
        if (!trimmed.endsWith(prefix)) add(`${parsed.origin}${trimmed}${prefix}`, `APIs often live under ${prefix}`);
      }
      const segments = trimmed.split("/").filter(Boolean);
      if (segments.length > 0)
        add(`${parsed.origin}/${segments.slice(0, -1).join("/")}`, "one path segment too many");
    } catch {
      /* no current address to vary */
    }
    return out.slice(0, 8);
  },
};

/* ── How the key is sent ──────────────────────────────────────────────── */

const HEADER_NAME_RE = /\b(X-[A-Za-z0-9-]*(?:Key|Token|Auth)[A-Za-z0-9-]*|Api-Key|Apikey|Access-Token)\b/gi;
const QUERY_NAME_RE = /[?&]([A-Za-z_]*(?:key|token)[A-Za-z_]*)=/gi;

/** Every single-secret way of sending one key, keeping its vault reference. */
const restyles = (keyRef: string, text: string): Array<{ auth: AuthSpec; because: string }> => {
  const styles: Array<{ auth: AuthSpec; because: string; weight: number }> = [];
  const mentions = (pattern: RegExp) => pattern.test(text);
  styles.push({
    auth: { type: "bearer", keyRef },
    because: "a bearer token in the Authorization header",
    weight: mentions(/\bbearer\b/i) ? 3 : 1,
  });
  styles.push({
    auth: { type: "header", header: "Authorization", template: "Token {{key}}", keyRef },
    because: "“Token …” in the Authorization header",
    weight: mentions(/\btoken\s+(?:<|\{|\[|YOUR)/i) ? 2 : 0,
  });
  styles.push({
    auth: { type: "header", header: "Authorization", keyRef },
    because: "the key alone in the Authorization header",
    weight: 0,
  });
  const headers = new Set<string>(["X-API-Key"]);
  for (const match of text.matchAll(HEADER_NAME_RE)) headers.add(match[1]!);
  for (const header of headers)
    styles.push({
      auth: { type: "header", header, keyRef },
      because: `the key in the ${header} header`,
      weight: text.includes(header) ? 3 : 0,
    });
  const params = new Set<string>(["api_key"]);
  for (const match of text.matchAll(QUERY_NAME_RE)) params.add(match[1]!);
  for (const param of params)
    styles.push({
      auth: { type: "query", param, keyRef },
      because: `the key as the ${param} parameter`,
      weight: text.includes(`${param}=`) ? 3 : 0,
    });
  return styles.sort((a, b) => b.weight - a.weight);
};

export const authStrategy: RepairStrategy = {
  id: "auth-style",
  handles: ["unauthorized"],
  async propose({ connection, docs }) {
    const auth = connection.auth;
    if (auth.type === "basic" && auth.usernameRef) {
      return [
        {
          patch: { auth: { ...auth, usernameRef: auth.keyRef, keyRef: auth.usernameRef } },
          because: "the username and password the other way round",
        },
      ];
    }
    if (auth.type !== "bearer" && auth.type !== "header" && auth.type !== "query") return [];
    const text = await docs.text();
    const same = (other: AuthSpec) => JSON.stringify({ ...other, label: undefined }) === JSON.stringify({ ...auth, label: undefined });
    return restyles(auth.keyRef, text)
      .filter((style) => !same(style.auth))
      .slice(0, 6)
      .map((style) => ({
        patch: { auth: auth.label ? { ...style.auth, label: auth.label } as AuthSpec : style.auth },
        because: `send ${style.because}`,
      }));
  },
};

/* ── What an AWS signature is scoped to ───────────────────────────────── */

const AWS_REGION_RE = /\b(?:us|eu|ap|sa|ca|me|af|il|cn)(?:-gov)?-(?:north|south|east|west|central|northeast|southeast|southwest|northwest)-\d\b/g;

/**
 * A signature made for the wrong region or service is refused, and AWS's
 * refusal often names the right one (“expecting 'eu-west-1'”, “scoped to
 * correct service: 'execute-api'”). Otherwise the documentation does: a
 * region it names is tried, most mentioned first. Never a region nobody
 * stated.
 */
export const awsScopeStrategy: RepairStrategy = {
  id: "aws-scope",
  /* `failed`: no region to sign for, so nothing was sent at all. */
  handles: ["unauthorized", "forbidden", "badRequest", "failed"],
  async propose({ connection, attempt, docs }) {
    const auth = connection.auth;
    if (auth.type !== "sigv4") return [];
    const said = attempt.said ?? attempt.message;
    const out: Candidate[] = [];
    const service = /scoped to (?:the )?correct service:?\s*'([a-z0-9-]+)'/i.exec(said)?.[1];
    if (service && service !== auth.service)
      out.push({ patch: { auth: { ...auth, service } }, because: `the API says its signatures are for the ${service} service` });
    const expected = /expecting\s+'([a-z0-9-]+)'/i.exec(said)?.[1];
    if (expected && expected !== auth.region) {
      out.push({ patch: { auth: { ...auth, region: expected } }, because: `the API says its signatures are for ${expected}` });
      return out;
    }
    if (!/region/i.test(said)) return out;
    const counts = new Map<string, number>();
    for (const match of (await docs.text()).match(AWS_REGION_RE) ?? []) counts.set(match, (counts.get(match) ?? 0) + 1);
    for (const [region] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      if (region !== auth.region)
        out.push({ patch: { auth: { ...auth, region } }, because: `the documentation names the ${region} region` });
    }
    return out;
  },
};

/* ── A header the API requires ────────────────────────────────────────── */

const MENTIONED_HEADER_RE = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\b(?=[^.]{0,40}\bheader\b)|\bheader\s+["'`]?([A-Za-z][A-Za-z0-9-]+)/gi;
const VERSION_VALUE_RE = /\b(\d{4}-\d{2}-\d{2}|v?\d+(?:\.\d+){0,2})\b/;

export const headerStrategy: RepairStrategy = {
  id: "required-header",
  handles: ["badRequest", "notFound"],
  async propose({ op, attempt, docs }) {
    const out: Candidate[] = [];
    const spec = await docs.spec();
    const declared = spec ? requiredHeadersFor(spec, op.path) : [];
    const sent = new Set(Object.keys(op.headers).map((name) => name.toLowerCase()));

    /* Declared by the specification with one documented value. */
    const fromSpec: Record<string, string> = {};
    for (const header of declared) {
      if (header.value !== undefined && !sent.has(header.name.toLowerCase())) fromSpec[header.name] = header.value;
    }
    if (Object.keys(fromSpec).length > 0)
      out.push({ patch: { headers: fromSpec }, because: `the specification requires ${Object.keys(fromSpec).join(", ")}` });

    /* Named by the API's own refusal; the value comes from the documentation. */
    const named = new Set<string>();
    for (const match of (attempt.said ?? "").matchAll(MENTIONED_HEADER_RE)) {
      const name = match[1] ?? match[2];
      if (name && !sent.has(name.toLowerCase()) && !(name in fromSpec)) named.add(name);
    }
    if (named.size > 0) {
      const text = await docs.text();
      for (const name of named) {
        const at = text.indexOf(name);
        const near = at >= 0 ? text.slice(at + name.length, at + name.length + 120) : "";
        const value = declared.find((one) => one.name.toLowerCase() === name.toLowerCase())?.value ?? near.match(VERSION_VALUE_RE)?.[1];
        if (value) out.push({ patch: { headers: { [name]: value } }, because: `the API asked for ${name}, and the documentation gives ${value}` });
      }
    }
    return out;
  },
};

/* ── Where the records are ────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const PREFERRED = /^(data|items|results|records|rows|entries|list|values)$/i;

export const rowsStrategy: RepairStrategy = {
  id: "rows-path",
  handles: ["noRows"],
  async propose({ op, attempt }) {
    const lists: Array<{ path: string; size: number; key: string }> = [];
    const walk = (node: unknown, path: string, depth: number) => {
      if (!isRecord(node) || depth > 2) return;
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value) && value.length > 0 && isRecord(value[0]))
          lists.push({ path: `${path}.${key}`, size: value.length, key });
        else walk(value, `${path}.${key}`, depth + 1);
      }
    };
    walk(attempt.body, "$", 0);
    const noun = op.path.split("/").filter((part) => part && !part.includes("{")).pop()?.toLowerCase() ?? "";
    lists.sort(
      (a, b) =>
        Number(b.key.toLowerCase() === noun) - Number(a.key.toLowerCase() === noun) ||
        Number(PREFERRED.test(b.key)) - Number(PREFERRED.test(a.key)) ||
        b.size - a.size,
    );
    return lists.slice(0, 3).map((list) => ({
      patch: { ops: { [op.id]: { rowsPath: list.path } } },
      because: `the records are in ${list.path}`,
    }));
  },
};

/* ── The request: a method, a body type ───────────────────────────────── */

/** The specification's operations on one path, found by the path's shape. */
const specOperations = (spec: Record<string, unknown> | null, opPath: string): Record<string, unknown> | null => {
  const paths = spec && isRecord(spec.paths) ? spec.paths : null;
  if (!paths) return null;
  const shape = (path: string) => path.replace(/\{\{\s*param\.[^}]*\}\}|\{[^/{}]+\}/g, "{}").replace(/\/+$/, "");
  const wanted = shape(opPath);
  for (const [path, operations] of Object.entries(paths)) if (shape(path) === wanted && isRecord(operations)) return operations;
  return null;
};

/** An operation the specification describes as a read: a search, a list, a query, a report. Never a create. */
const READS = /\b(search|list|query|find|lookup|filter|report|export)\b/i;

/**
 * Refused with 405 on a GET, where the specification reads the same path with
 * a POST it describes as a search or a list: that POST, with the body its
 * example gives (or none). A POST the specification describes as anything
 * else could create something, and is never tried.
 */
export const methodStrategy: RepairStrategy = {
  id: "method",
  handles: ["notFound"],
  async propose({ op, attempt, docs }) {
    if (attempt.status !== 405 || op.method !== "GET") return [];
    const post = specOperations(await docs.spec(), op.path)?.post;
    if (!isRecord(post)) return [];
    const words = [post.operationId, post.summary, post.description].filter((one) => typeof one === "string").join(" ");
    if (!READS.test(words) && !READS.test(op.path)) return [];
    const content = isRecord(post.requestBody) && isRecord(post.requestBody.content) ? post.requestBody.content : {};
    const json = isRecord(content["application/json"]) ? content["application/json"] : null;
    const example = json && "example" in json ? json.example : undefined;
    return [
      {
        patch: {
          ops: {
            [op.id]: {
              method: "POST",
              ...(example !== undefined || json ? { body: { type: "json" as const, template: example ?? {} } } : {}),
              readSafety: { basis: "spec-declared", note: `The specification reads ${op.path} with POST: ${words.slice(0, 120)}` },
            },
          },
        },
        because: `the API refused GET (405), and its specification reads ${op.path} with POST as a ${READS.exec(words)?.[0]?.toLowerCase() ?? "read"}`,
      },
    ];
  },
};

/**
 * Refused with 415: the body is sent the way the specification says it is
 * taken — form fields for a JSON object, or the other way round.
 */
export const bodyTypeStrategy: RepairStrategy = {
  id: "body-type",
  handles: ["failed", "badRequest"],
  async propose({ op, attempt, docs }) {
    if (attempt.status !== 415 || op.method !== "POST" || !op.body) return [];
    const post = specOperations(await docs.spec(), op.path)?.post;
    const content = isRecord(post) && isRecord(post.requestBody) && isRecord(post.requestBody.content) ? Object.keys(post.requestBody.content) : [];
    if (op.body.type === "json" && content.includes("application/x-www-form-urlencoded") && isRecord(op.body.template)) {
      const template = Object.fromEntries(Object.entries(op.body.template).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
      return [{ patch: { ops: { [op.id]: { body: { type: "form" as const, template } } } }, because: "the API refused JSON (415), and its specification takes form fields" }];
    }
    if (op.body.type === "form" && content.some((one) => /json/i.test(one)))
      return [{ patch: { ops: { [op.id]: { body: { type: "json" as const, template: op.body.template } } } }, because: "the API refused form fields (415), and its specification takes JSON" }];
    return [];
  },
};

export const DEFAULT_STRATEGIES: readonly RepairStrategy[] = [
  addressStrategy,
  authStrategy,
  awsScopeStrategy,
  headerStrategy,
  rowsStrategy,
  methodStrategy,
  bodyTypeStrategy,
];
