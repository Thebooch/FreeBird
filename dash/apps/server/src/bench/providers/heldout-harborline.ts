import { createHash, createHmac } from "node:crypto";
import { connectorHash } from "../../connector/adapter.js";
import { BENCH_NOW, json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * The held-out replacement for vaultbank, written after vaultbank's held-out
 * failure was written up and **before** the defect it exposed was fixed — so
 * the fix cannot have been tuned against it.
 *
 * Its pattern is neither the dev set's nor vaultbank's: no request signing, no
 * export to wait for, no login with a password, no one-object-per-line. A
 * token obtained with a signed JWT assertion; records split across several
 * pre-signed files on a separate host, which refuses a request that carries
 * the API's own token; tab-separated.
 *
 * Nothing here may be read while tuning a prompt or a repair strategy.
 */

const HL_HOST = "api.harborline.bench.test";
const HL_FILES = "files.harborline-cdn.bench.test";
const HL_KEY_ID = "hl_kid_204";
const HL_SECRET = "hl_sec_9c1f";
const FIVE_MINUTES = 300;

const shipments = (() => {
  const next = random(9404);
  return Array.from({ length: 470 }, (_, index) => ({
    shipment_id: `SH-${40_000 + index}`,
    status: pick(next, ["delivered", "delivered", "in_transit", "returned"] as const),
    weight_kg: Math.round((1 + next() * 900) * 10) / 10,
    delivered_on: new Date(Date.UTC(2026, 5, 15) + Math.floor(next() * 100) * 86_400_000).toISOString().slice(0, 10),
  }));
})();

/** The manifest's parts: uneven, as real exports are. */
const PARTS = [
  { name: "part-0001", from: 0, to: 190 },
  { name: "part-0002", from: 190, to: 350 },
  { name: "part-0003", from: 350, to: 470 },
];

const fileSignature = (path: string): string => createHash("sha256").update(`${path}|harborline-files`).digest("hex").slice(0, 32);

const tokens = new Set<string>();

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/** Checks an HS256 assertion the way the service documents it. Null when it holds. */
const assertionProblem = (assertion: unknown): string | null => {
  if (typeof assertion !== "string") return "assertion is required";
  const [header, claims, signature] = assertion.split(".");
  if (!header || !claims || !signature) return "the assertion is not a JWT";
  const expected = createHmac("sha256", HL_SECRET).update(`${header}.${claims}`).digest("base64url");
  if (signature !== expected) return "the assertion's signature does not match";
  let head: Record<string, unknown>;
  let body: Record<string, unknown>;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    body = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  } catch {
    return "the assertion's header or claims are not JSON";
  }
  if (head.alg !== "HS256") return "alg must be HS256";
  if (head.kid !== HL_KEY_ID || body.iss !== HL_KEY_ID) return "kid and iss must be your key ID";
  const now = Math.floor(BENCH_NOW / 1000);
  if (typeof body.iat !== "number" || Math.abs(body.iat - now) > FIVE_MINUTES) return "iat must be the current time in seconds";
  if (typeof body.exp !== "number" || body.exp <= now || body.exp - body.iat > FIVE_MINUTES) return "exp must be at most five minutes after iat";
  return null;
};

const harborlineSpec = {
  openapi: "3.0.3",
  info: {
    title: "Harborline Freight",
    version: "1",
    description: [
      "Authentication: create a short-lived access token with POST /auth/token, sending a JSON body {\"assertion\": \"<JWT>\"}.",
      "The assertion is a JWT signed with HS256 using your secret key. Its header is {\"alg\": \"HS256\", \"typ\": \"JWT\", \"kid\": \"<your key ID>\"},",
      "and its claims are {\"iss\": \"<your key ID>\", \"iat\": <now, in seconds>, \"exp\": <at most 300 seconds after iat>}.",
      "Tokens last five minutes. Send the token as Authorization: Bearer <token> to this API.",
      "",
      "Bulk data: GET /shipments/manifest lists the files that hold every shipment. Each file's url is pre-signed and served by our file host;",
      "fetch it exactly as given and without an Authorization header — a pre-signed request that also carries a token is rejected.",
      "Files are tab-separated, with a header row.",
    ].join(" "),
  },
  servers: [{ url: `https://${HL_HOST}/v1` }],
  components: {
    securitySchemes: {
      token: { type: "http", scheme: "bearer", description: "An access token from POST /auth/token — see the overview." },
    },
  },
  security: [{ token: [] }],
  paths: {
    "/auth/token": {
      post: {
        summary: "Create an access token",
        security: [],
        requestBody: {
          content: {
            "application/json": { schema: { type: "object", properties: { assertion: { type: "string", description: "A JWT signed with HS256." } } } },
          },
        },
        responses: {
          "200": {
            description: "A token.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { access_token: { type: "string" }, expires_in: { type: "integer" } } },
              },
            },
          },
        },
      },
    },
    "/shipments/manifest": {
      get: {
        summary: "List the files that hold every shipment",
        responses: {
          "200": {
            description: "The files, in order. Their rows together are every shipment.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          url: { type: "string", description: "Pre-signed; fetch without authentication." },
                          rows: { type: "integer" },
                        },
                      },
                    },
                    columns: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const HARBORLINE_REFERENCE_CODE = String.raw`async function authenticate() {
  const now = Math.floor(clock.now() / 1000);
  const kid = await credentials.identifier("key_id");
  const header = base64.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid }));
  const claims = base64.encode(JSON.stringify({ iss: kid, iat: now, exp: now + 240 }));
  const b64url = (text) => text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = b64url(header) + "." + b64url(claims);
  const signature = await crypto.hmac({ key: "secret", data: unsigned, encoding: "base64url" });
  await auth.exchange({ name: "token", request: { method: "POST", url: "/auth/token", body: { assertion: unsigned + "." + signature } }, token: "$.access_token", expiresIn: "$.expires_in" });
}

async function read(ctx) {
  const manifest = await http.request({ url: "/shipments/manifest", headers: { authorization: "Bearer {{secret:token}}" } });
  if (manifest.status !== 200) throw new Error("the manifest answered " + manifest.status);
  const rows = [];
  for (const file of manifest.body.files) {
    const part = await http.request({ url: file.url, as: "text" });
    if (part.status !== 200) throw new Error("a file answered " + part.status);
    rows.push(...CSV.parse(part.body, { delimiter: "\t" }));
  }
  return { rows };
}`;

/*
 * The key ID goes inside the signed assertion, where a `{{secret:…}}` slot
 * cannot reach. As first written, this reference hard-coded it — as somebody
 * configuring their own account could, and an integrator cannot. It now reads
 * it as a declared identifier (`credentials.identifier`), the capability that
 * gap asked for; the answer key did not change.
 */
const referenceCode = HARBORLINE_REFERENCE_CODE;

export const harborline: MockProvider = {
  id: "harborline",
  split: "heldout",
  pattern:
    "A token obtained with an HS256-signed JWT assertion; every record in pre-signed files on a separate host that refuses the API's token; tab-separated",
  hosts: [HL_HOST, HL_FILES],
  docsUrl: `https://${HL_HOST}/openapi.json`,
  credentials: [HL_KEY_ID, HL_SECRET],
  credentialLabels: ["Key ID", "Secret key"],
  /*
   * A dev scenario since 2026-09-29 (PROTOCOL.md): its scripted connector code
   * is the reference's, for CI's mechanics.
   */
  scriptedModel: {
    propose_connector: {
      summary:
        "Signs a short-lived sign-in with the secret key, reads the manifest with the token it gets, and reads every file the manifest lists without it.",
      credentials: [
        { name: "key_id", label: "Key ID", secret: false },
        { name: "secret", label: "Secret key" },
      ],
      exchanges: [{ name: "token" }],
      destinations: [
        { host: HL_HOST, role: "api", methods: ["GET", "POST"], credentials: ["key_id", "secret", "token"] },
        { host: HL_FILES, role: "download", methods: ["GET"], credentials: [] },
      ],
      serves: true,
      code: HARBORLINE_REFERENCE_CODE,
    },
  },
  reset() {
    tokens.clear();
  },
  reference: {
    connection: {
      id: "harborline",
      title: "Harborline Freight",
      kind: "rest",
      baseUrl: `https://${HL_HOST}/v1`,
      auth: {
        type: "connector",
        credentials: [
          { name: "key_id", keyRef: "harborline-key-id", label: "Key ID", secret: false },
          { name: "secret", keyRef: "harborline-secret", label: "Secret key" },
        ],
        tokens: [{ name: "token", keyRef: "harborline-token" }],
      },
      ops: [
        {
          id: "shipments",
          title: "List the files that hold every shipment",
          path: "/shipments/manifest",
          servedBy: "connector",
          rowsPath: "$",
          readSafety: { basis: "person", note: "Creates a token with POST, then reads." },
        },
      ],
      connector: {
        code: referenceCode,
        hash: connectorHash(referenceCode),
        hooks: ["authenticate", "read"],
        serves: ["shipments"],
        authority: {
          destinations: [
            { host: HL_HOST, methods: ["GET", "POST"], credentials: ["key_id", "secret", "token"] },
            { host: HL_FILES, role: "download", methods: ["GET"] },
          ],
          exchanges: [{ name: "token", fields: [] }],
        },
        author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
      },
    },
    secrets: { "harborline-key-id": HL_KEY_ID, "harborline-secret": HL_SECRET },
  },
  objectives: [
    {
      id: "august-delivered-weight",
      request: "How many kilograms did we get delivered in August 2026?",
      answer:
        Math.round(
          shipments
            .filter((one) => one.status === "delivered" && one.delivered_on.startsWith("2026-08"))
            .reduce((sum, one) => sum + one.weight_kg, 0) * 10,
        ) / 10,
      tolerance: 0.05,
      records: shipments.length,
      scripted: {
        path: "/shipments/manifest",
        measure: {
          agg: "sum",
          field: "weight_kg",
          where: 'status == "delivered" && delivered_on >= "2026-08-01" && delivered_on < "2026-09-01"',
        },
      },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.hostname === HL_FILES) {
      if (request.headers.authorization)
        return json({ error: "Only one authentication mechanism is allowed: this address is already signed." }, 400);
      const part = PARTS.find((one) => url.pathname === `/exports/shipments/${one.name}.tsv`);
      if (!part || url.searchParams.get("X-Signature") !== fileSignature(url.pathname))
        return json({ error: "The request signature we calculated does not match." }, 403);
      const lines = shipments
        .slice(part.from, part.to)
        .map((one) => [one.shipment_id, one.status, one.weight_kg.toFixed(1), one.delivered_on].join("\t"));
      return {
        status: 200,
        headers: { "content-type": "text/tab-separated-values" },
        body: [["shipment_id", "status", "weight_kg", "delivered_on"].join("\t"), ...lines].join("\n"),
      };
    }
    if (url.pathname === "/openapi.json") return json(harborlineSpec);
    if (url.pathname === "/v1/auth/token" && request.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.body ?? "{}");
      } catch {
        return json({ error: "the body must be JSON" }, 400);
      }
      const problem = assertionProblem(body.assertion);
      if (problem) return json({ error: problem }, 401);
      const token = `hl_at_${tokens.size + 1}_${createHash("sha256").update(String(tokens.size)).digest("hex").slice(0, 12)}`;
      tokens.add(token);
      return json({ access_token: token, expires_in: 300 });
    }
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(bearer)) return json({ error: "a valid access token is required" }, 401);
    if (url.pathname === "/v1/shipments/manifest" && request.method === "GET")
      return json({
        columns: ["shipment_id", "status", "weight_kg", "delivered_on"],
        files: PARTS.map((part) => {
          const path = `/exports/shipments/${part.name}.tsv`;
          return { url: `https://${HL_FILES}${path}?X-Signature=${fileSignature(path)}`, rows: part.to - part.from };
        }),
      });
    return notFound();
  },
};
