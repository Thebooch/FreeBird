import { createHash, createHmac } from "node:crypto";
import { html, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Dev-set providers for track B (sign-in breadth). Tuned against freely.
 *
 * Each checks the sign-in the way the real thing does, with its own code and
 * `node:crypto` — never the signer being measured — so a request that gets
 * records was signed correctly, not merely signed the way Dash signs.
 */

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const md5 = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

/* ── Depotline: AWS Signature Version 4, behind the API's own domain ───── */

/*
 * A warehouse API served through API Gateway with IAM authorisation, at its
 * own domain — so the address does not say which region to sign for. Its
 * specification marks the scheme the way API Gateway's exports do, and its
 * description names the region in words. Two values are pasted; neither is
 * ever sent as it is.
 */

const D_HOST = "api.depotline.bench.test";
const D_ACCESS = "AKIADEPOTLINE7Q2BENCH";
const D_SECRET = "dL9/benchOnlySecretKey+0aWk3XyZq1RtUv5MnPb";
const D_REGION = "eu-central-1";
const D_SERVICE = "execute-api";
const D_PAGE = 100;

const parts = (() => {
  const next = random(31877);
  return Array.from({ length: 260 }, (_, index) => ({
    sku: `DP-${20_000 + index}`,
    name: `${pick(next, ["Bracket", "Gasket", "Bearing", "Coupling", "Valve", "Flange"] as const)} ${index + 1}`,
    bin: `${pick(next, ["A", "B", "C", "D"] as const)}-${1 + Math.floor(next() * 40)}`,
    on_hand: Math.floor(next() * 500),
    status: pick(next, ["active", "active", "active", "discontinued"] as const),
  }));
})();

const awsEncode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS's refusals, in AWS's words; null when the signature is the one AWS would compute. */
const awsRefusal = (request: BenchRequest): string | null => {
  const header = request.headers.authorization ?? "";
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
    header,
  );
  if (!match) return "Missing Authentication Token";
  const [, access, date, region, service, signedHeaders, signature] = match as unknown as [string, string, string, string, string, string, string];
  if (access !== D_ACCESS) return "The security token included in the request is invalid.";
  if (region !== D_REGION) return `Credential should be scoped to a valid region, not '${region}'.`;
  if (service !== D_SERVICE) return `Credential should be scoped to correct service: '${D_SERVICE}'.`;
  const stamp = request.headers["x-amz-date"] ?? "";
  if (!stamp.startsWith(date)) return "Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP.";
  const names = signedHeaders.split(";");
  if (!names.includes("host") || !names.includes("x-amz-date")) return "'Host' or ':authority' must be a 'SignedHeader' in the AWS Authorization.";
  const canonicalHeaders = names
    .map((name) => `${name}:${(name === "host" ? request.url.host : (request.headers[name] ?? "")).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const query = [...request.url.searchParams]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const path = request.url.pathname.split("/").map(awsEncode).join("/");
  const canonical = [request.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(request.body ?? "")].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = [date, region, service, "aws4_request"].reduce<Buffer>(
    (secret, part) => createHmac("sha256", secret).update(part, "utf8").digest(),
    Buffer.from(`AWS4${D_SECRET}`, "utf8"),
  );
  const expected = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return expected === signature
    ? null
    : "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.";
};

const D_SPEC = {
  openapi: "3.0.1",
  info: {
    title: "Depotline",
    version: "2026-03-01",
    description:
      "Depotline's warehouse API. It is served through Amazon API Gateway in the eu-central-1 region. " +
      "Every request must be signed with AWS Signature Version 4, using the access key ID and secret access key " +
      "issued under Settings, then API access. Unsigned requests are refused.",
  },
  servers: [{ url: `https://${D_HOST}/prod` }],
  components: {
    securitySchemes: {
      sigv4: { type: "apiKey", name: "Authorization", in: "header", "x-amazon-apigateway-authtype": "awsSigv4" },
    },
  },
  security: [{ sigv4: [] }],
  paths: {
    "/parts": {
      get: {
        operationId: "listParts",
        summary: "List parts",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 25, maximum: D_PAGE } },
        ],
        responses: {
          "200": {
            description: "A page of parts, and how many there are in all.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    parts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sku: { type: "string" },
                          name: { type: "string" },
                          bin: { type: "string", description: "Where it is shelved." },
                          on_hand: { type: "integer", description: "Units in the warehouse now." },
                          status: { type: "string", enum: ["active", "discontinued"] },
                        },
                      },
                    },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
          "403": { description: "The request was not signed, or its signature was refused." },
        },
      },
    },
  },
};

export const depotline: MockProvider = {
  id: "depotline",
  split: "dev",
  pattern: "AWS Signature V4 behind the API's own domain: two pasted values, the region named only in words; numbered pages",
  hosts: [D_HOST],
  docsUrl: `https://${D_HOST}/openapi.json`,
  credentials: [D_ACCESS, D_SECRET],
  credentialLabels: ["Access key ID", "Secret access key"],
  reference: {
    connection: {
      id: "depotline",
      title: "Depotline",
      kind: "rest",
      baseUrl: `https://${D_HOST}/prod`,
      auth: { type: "sigv4", accessKeyRef: "depotline-access", keyRef: "depotline-key", region: D_REGION, service: D_SERVICE },
      ops: [
        {
          id: "parts",
          title: "List parts",
          path: "/parts",
          rowsPath: "$.parts",
          pagination: { kind: "page", param: "page", startsAt: 1, limitParam: "per_page", pageSize: D_PAGE },
          maxPages: 10,
        },
      ],
    },
    secrets: { "depotline-access": D_ACCESS, "depotline-key": D_SECRET },
  },
  objectives: [
    {
      id: "discontinued-parts",
      request: "How many parts are discontinued?",
      answer: parts.filter((one) => one.status === "discontinued").length,
      tolerance: 0,
      records: parts.length,
      scripted: { path: "/parts", measure: { agg: "count", where: 'status == "discontinued"' } },
    },
    {
      id: "units-on-hand",
      request: "How many units do we have on hand in total?",
      answer: parts.reduce((sum, one) => sum + one.on_hand, 0),
      tolerance: 0,
      records: parts.length,
      scripted: { path: "/parts", measure: { agg: "sum", field: "on_hand" } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(D_SPEC);
    const refusal = awsRefusal(request);
    if (refusal) return json({ message: refusal }, 403);
    if (url.pathname !== "/prod/parts") return notFound();
    const page = Math.max(1, intParam(request, "page", 1));
    const per = Math.min(D_PAGE, Math.max(1, intParam(request, "per_page", 25)));
    return json({ parts: parts.slice((page - 1) * per, page * per), total: parts.length });
  },
};

/* ── Archivist: HTTP Digest, documented only in prose ──────────────────── */

/*
 * A records archive that signs in with HTTP Digest: the password is never
 * sent, only an answer to the server's challenge. Its nonces last three
 * requests, so a read of several pages is challenged again part-way through.
 */

const A_HOST = "api.archivist.bench.test";
const A_DOCS = "docs.archivist.bench.test";
const A_USER = "acct-40117";
const A_PASSWORD = "ar_pw_6c1e9d";
const A_REALM = "archivist";
const A_PAGE = 40;
const A_NONCE_USES = 3;

const documents = (() => {
  const next = random(90412);
  return Array.from({ length: 190 }, (_, index) => ({
    id: `doc_${5000 + index}`,
    title: `${pick(next, ["Lease", "Invoice", "Permit", "Minutes", "Report"] as const)} ${index + 1}`,
    state: pick(next, ["active", "active", "archived", "archived", "archived", "held"] as const),
    pages: 1 + Math.floor(next() * 60),
  }));
})();

let issued = 0;
const nonceFor = (index: number): string => md5(`archivist-nonce-${index}`);

const challenge = (stale: boolean): BenchResponse =>
  json({ error: "Sign in with HTTP Digest." }, 401, {
    "www-authenticate": `Digest realm="${A_REALM}", qop="auth", nonce="${nonceFor(++issued)}", algorithm=MD5${stale ? ", stale=true" : ""}`,
  });

/** The answer RFC 7616 says a client holding the password gives, checked field by field. */
const digestAnswer = (request: BenchRequest): BenchResponse | null => {
  const header = request.headers.authorization ?? "";
  if (!/^Digest /i.test(header)) return challenge(false);
  const fields: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/([a-z]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi)) fields[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  const uri = `${request.url.pathname}${request.url.search}`;
  if (fields.username !== A_USER || fields.realm !== A_REALM || fields.uri !== uri) return json({ error: "Those credentials were not accepted." }, 401);
  /* Any nonce this server issued, for as many requests as one lasts: reads may overlap. */
  const known = Array.from({ length: issued }, (_, index) => nonceFor(index + 1)).includes(fields.nonce ?? "");
  if (!known) return challenge(true);
  if (Number.parseInt(fields.nc ?? "", 16) > A_NONCE_USES) return challenge(true);
  const expected = md5(
    `${md5(`${A_USER}:${A_REALM}:${A_PASSWORD}`)}:${fields.nonce}:${fields.nc}:${fields.cnonce}:${fields.qop}:${md5(`${request.method.toUpperCase()}:${uri}`)}`,
  );
  return fields.qop === "auth" && fields.response === expected ? null : json({ error: "Those credentials were not accepted." }, 401);
};

const A_PAGE_HTML = `<html><body>
<h1>Archivist API</h1>
<p>The Archivist API reads the documents in your archive. Requests go to
https://${A_HOST}/api/1 and answer in JSON.</p>
<h2>Signing in</h2>
<p>The API uses HTTP Digest authentication (RFC 7616, MD5, qop=auth). The username is
your account number and the password is your API password; both are shown under
Account, then API access. Your password is never sent over the wire. Basic
authentication and API keys in headers are not accepted.</p>
<h2>Documents</h2>
<p>GET /documents lists your documents, ${A_PAGE} to a page, as an object with a
"documents" array and a "count" of every document in the archive. Ask for later
pages with the page parameter, starting at 1: /documents?page=2. A page past the
last is an empty array. Each document has an id, a title, a state ("active",
"archived" or "held") and its number of pages ("pages").</p>
<pre>curl --digest -u ACCOUNT_NUMBER:API_PASSWORD https://${A_HOST}/api/1/documents</pre>
</body></html>`;

export const archivist: MockProvider = {
  id: "archivist",
  split: "dev",
  pattern: "HTTP Digest documented only in prose: a username and password never sent, nonces that expire mid-read",
  hosts: [A_HOST, A_DOCS],
  docsUrl: `https://${A_DOCS}/api`,
  credentials: [A_USER, A_PASSWORD],
  credentialLabels: ["Account number", "API password"],
  scriptedModel: {
    propose_dialect: {
      title: "Archivist",
      baseUrl: `https://${A_HOST}/api/1`,
      authType: "digest",
      authUsernameLabel: "Account number",
      authSecretLabel: "API password",
      paginationKind: "page",
      paginationParam: "page",
      rowsPath: "$.documents",
      endpoints: [{ id: "documents", title: "List documents", path: "/documents", archetype: "list" }],
    },
  },
  reference: {
    connection: {
      id: "archivist",
      title: "Archivist",
      kind: "rest",
      baseUrl: `https://${A_HOST}/api/1`,
      auth: { type: "basic", digest: true, usernameRef: "archivist-user", keyRef: "archivist-key" },
      ops: [
        {
          id: "documents",
          title: "List documents",
          path: "/documents",
          rowsPath: "$.documents",
          pagination: { kind: "page", param: "page", startsAt: 1 },
          maxPages: 10,
        },
      ],
    },
    secrets: { "archivist-user": A_USER, "archivist-key": A_PASSWORD },
  },
  objectives: [
    {
      id: "archived-documents",
      request: "How many documents are archived?",
      answer: documents.filter((one) => one.state === "archived").length,
      tolerance: 0,
      records: documents.length,
      scripted: { path: "/documents", measure: { agg: "count", where: 'state == "archived"' } },
    },
  ],
  reset() {
    issued = 0;
  },
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.hostname === A_DOCS) return url.pathname === "/api" ? html(A_PAGE_HTML) : notFound();
    const refused = digestAnswer(request);
    if (refused) return refused;
    if (url.pathname !== "/api/1/documents") return notFound();
    const page = Math.max(1, intParam(request, "page", 1));
    return json({ documents: documents.slice((page - 1) * A_PAGE, page * A_PAGE), count: documents.length });
  },
};
