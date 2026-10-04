import { createHash } from "node:crypto";
import { html, intParam, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Archivist: HTTP Digest, documented only in prose.
 *
 * A records archive that signs in with HTTP Digest: the password is never
 * sent, only an answer to the server's challenge. Its nonces last three
 * requests, so a read of several pages is challenged again part-way through.
 *
 * It checks the sign-in the way the real thing does, with its own code and
 * `node:crypto` — never the signer being measured — so a request that gets
 * records was signed correctly, not merely signed the way Dash signs.
 */

const md5 = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");

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
