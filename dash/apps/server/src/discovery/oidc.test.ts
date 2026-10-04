import { describe, expect, it } from "vitest";
import { discover } from "./index.js";

/*
 * OpenID Connect, read as the OAuth sign-in it is: the
 * specification names a discovery document, and the document says where a
 * person signs in and where the code is exchanged.
 */

const SPEC_URL = "https://api.idco.test/openapi.json";
const DISCOVERY_URL = "https://login.idco.test/.well-known/openid-configuration";

const spec = (openIdConnectUrl: string) => ({
  openapi: "3.0.3",
  info: { title: "IdCo", version: "1" },
  servers: [{ url: "https://api.idco.test/v1" }],
  components: { securitySchemes: { oidc: { type: "openIdConnect", openIdConnectUrl } } },
  security: [{ oidc: ["openid", "orders.read", "unknown.scope"] }],
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        summary: "List orders",
        responses: { "200": { description: "Orders", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } },
      },
    },
  },
});

const documents = (discovery: unknown, openIdConnectUrl = DISCOVERY_URL) => async (url: string) => {
  if (url === SPEC_URL) return { status: 200, text: JSON.stringify(spec(openIdConnectUrl)), url };
  if (url === DISCOVERY_URL) return { status: 200, text: JSON.stringify(discovery), url };
  return { status: 404, text: "", url };
};

describe("OpenID Connect", () => {
  it("signs in with the provider its discovery document names, asking for the scopes it offers", async () => {
    const found = await discover(SPEC_URL, {
      fetchDocument: documents({
        issuer: "https://login.idco.test",
        authorization_endpoint: "https://login.idco.test/authorize",
        token_endpoint: "https://login.idco.test/token",
        scopes_supported: ["openid", "orders.read"],
      }),
    });
    expect(found.entry?.dialect.auth).toMatchObject({
      type: "oauth2",
      flow: "authorization_code",
      authorizeUrl: "https://login.idco.test/authorize",
      tokenUrl: "https://login.idco.test/token",
      scopes: ["openid", "orders.read"],
      pkce: true,
    });
    expect(found.warnings.join(" ")).not.toMatch(/OpenID Connect/);
    expect(found.note).toMatch(/signs in with OpenID Connect/);
  });

  it("signs an app in as itself where that is all the provider offers, and never to a plain-http address", async () => {
    const app = await discover(SPEC_URL, {
      fetchDocument: documents({ token_endpoint: "https://login.idco.test/token", grant_types_supported: ["client_credentials"] }),
    });
    expect(app.entry?.dialect.auth).toMatchObject({ type: "oauth2", flow: "client_credentials", tokenUrl: "https://login.idco.test/token" });
    const plain = await discover(SPEC_URL, {
      fetchDocument: documents({ authorization_endpoint: "http://login.idco.test/authorize", token_endpoint: "http://login.idco.test/token" }),
    });
    expect(plain.entry?.dialect.auth?.type).not.toBe("oauth2");
    /* Unreadable: said, as it was. */
    expect(plain.warnings.join(" ")).toMatch(/OpenID Connect/);
  });
});
