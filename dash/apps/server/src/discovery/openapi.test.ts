import { describe, expect, it } from "vitest";
import {
  indexLinksIn,
  looksLikeOpenApi,
  parseOpenApi,
  parseSpecDocument,
  specLinksIn,
} from "./openapi.js";

const SPEC_URL = "https://api.example.com/openapi.json";

const spec = (overrides: Record<string, unknown> = {}) => ({
  openapi: "3.0.3",
  info: { title: "Billing API" },
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Charge: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "The charge's identifier." },
          created: { type: "string", format: "date-time" },
        },
      },
      ChargeList: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Charge" } },
          has_more: { type: "boolean" },
        },
      },
    },
  },
  paths: {
    "/charges": {
      get: {
        operationId: "listCharges",
        summary: "List charges",
        description: "Every charge on the account, newest first.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "starting_after", in: "query", schema: { type: "string" } },
          { name: "created[gte]", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ChargeList" } },
            },
          },
        },
      },
    },
  },
  ...overrides,
});

describe("looksLikeOpenApi", () => {
  it("recognises both spec versions and rejects anything else", () => {
    expect(looksLikeOpenApi({ openapi: "3.0.0" })).toBe(true);
    expect(looksLikeOpenApi({ swagger: "2.0" })).toBe(true);
    expect(looksLikeOpenApi({ data: [] })).toBe(false);
    expect(looksLikeOpenApi("<html>")).toBe(false);
    expect(looksLikeOpenApi(null)).toBe(false);
  });
});

describe("parseOpenApi", () => {
  it("turns a spec into a usable catalog entry", () => {
    const result = parseOpenApi(spec(), SPEC_URL)!;
    expect(result.entry.title).toBe("Billing API");
    expect(result.entry.id).toBe("billing-api");
    expect(result.entry.baseUrl).toBe("https://api.example.com/v1");
    expect(result.entry.dialect.auth).toMatchObject({ type: "bearer", keyRef: "billing-api-key" });
  });

  it("reads the rows path out of the declared response schema, through $ref", () => {
    const [op] = parseOpenApi(spec(), SPEC_URL)!.entry.ops;
    expect(op).toMatchObject({ id: "listcharges", title: "List charges", archetype: "list", rowsPath: "$.data" });
  });

  it("keeps the endpoint's own description, which is all that tells two apart", () => {
    // On an API where two hundred endpoints are titled "Retrieve all X", the
    // summary is not enough to choose between them. This used to be dropped.
    const [op] = parseOpenApi(spec(), SPEC_URL)!.entry.ops;
    expect(op?.description).toBe("Every charge on the account, newest first.");
  });

  it("reads the row's fields out of the same schema it found the rows in", () => {
    /*
     * The cheap half of mapping an API. `shapeOf` already resolved this
     * response to locate `$.data`; reading the field list costs nothing more,
     * and it is the only route to the shape of an endpoint that cannot be
     * called without an id.
     */
    const [op] = parseOpenApi(spec(), SPEC_URL)!.entry.ops;
    const byName = new Map((op?.fields ?? []).map((field) => [field.name, field]));

    expect([...byName.keys()]).toEqual(["id", "created"]);
    expect(byName.get("id")).toMatchObject({
      kinds: ["string"],
      nullable: false,
      description: "The charge's identifier.",
    });
    expect(byName.get("created")).toMatchObject({ format: "iso8601", nullable: true });
    // The envelope is not the row: `has_more` belongs to the wrapper.
    expect(byName.has("has_more")).toBe(false);
  });

  it("infers pagination and the date filter from parameter names", () => {
    const { entry } = parseOpenApi(spec(), SPEC_URL)!;
    expect(entry.dialect.pagination).toMatchObject({ kind: "cursor", param: "starting_after" });
    expect(entry.dialect.timeFilter).toEqual({ param: "created[gte]", format: "unix" });
  });

  it("warns that a spec cannot reveal which field feeds the cursor", () => {
    // The request parameter is declared; the response field never is.
    const { warnings } = parseOpenApi(spec(), SPEC_URL)!;
    expect(warnings.join()).toMatch(/never says which response field holds the next cursor/);
  });

  it("never marks an imported spec verified", () => {
    // A spec is a description, not a proof.
    const { entry } = parseOpenApi(spec(), SPEC_URL)!;
    expect(entry.verified).toBe(false);
    expect(entry.origin).toBe("openapi");
  });

  it("imports GET only — read-only by construction", () => {
    const withWrites = spec({
      paths: {
        "/charges": {
          get: { summary: "List", responses: {} },
          post: { summary: "Create a charge", responses: {} },
          delete: { summary: "Delete everything", responses: {} },
        },
      },
    });
    const { entry } = parseOpenApi(withWrites, SPEC_URL)!;
    expect(entry.ops).toHaveLength(1);
    expect(entry.ops[0]?.title).toBe("List");
  });

  it("skips deprecated operations", () => {
    const withDeprecated = spec({
      paths: { "/old": { get: { summary: "Old", deprecated: true, responses: {} } } },
    });
    expect(parseOpenApi(withDeprecated, SPEC_URL)).toBeNull();
  });

  it("turns path templating into a filter token", () => {
    const templated = spec({
      paths: { "/repos/{owner}/{repo}/issues": { get: { summary: "Issues", responses: {} } } },
    });
    expect(parseOpenApi(templated, SPEC_URL)!.entry.ops[0]?.path).toBe(
      "/repos/{{param.owner}}/{{param.repo}}/issues",
    );
  });

  it("treats a bare array response as the rows", () => {
    const bare = spec({
      paths: {
        "/items": {
          get: {
            summary: "Items",
            responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
          },
        },
      },
    });
    expect(parseOpenApi(bare, SPEC_URL)!.entry.ops[0]).toMatchObject({
      archetype: "list",
      rowsPath: "$",
    });
  });

  it("falls back to summary rather than guessing between several arrays", () => {
    const ambiguous = spec({
      paths: {
        "/mixed": {
          get: {
            summary: "Mixed",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { alpha: { type: "array" }, beta: { type: "array" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(parseOpenApi(ambiguous, SPEC_URL)!.entry.ops[0]?.archetype).toBe("summary");
  });

  it("prefers a conventional envelope name when several arrays are present", () => {
    const enveloped = spec({
      paths: {
        "/mixed": {
          get: {
            summary: "Mixed",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { data: { type: "array" }, warnings: { type: "array" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(parseOpenApi(enveloped, SPEC_URL)!.entry.ops[0]?.rowsPath).toBe("$.data");
  });

  describe("auth schemes", () => {
    const authOf = (securitySchemes: Record<string, unknown>) =>
      parseOpenApi(spec({ components: { securitySchemes } }), SPEC_URL)!.entry.dialect.auth;

    it("maps the shapes real specs use", () => {
      expect(authOf({ a: { type: "http", scheme: "bearer" } })).toMatchObject({ type: "bearer" });
      expect(authOf({ a: { type: "http", scheme: "basic" } })).toMatchObject({ type: "basic" });
      expect(authOf({ a: { type: "apiKey", in: "header", name: "X-Api-Key" } })).toMatchObject({
        type: "header",
        header: "X-Api-Key",
      });
      expect(authOf({ a: { type: "apiKey", in: "query", name: "api_key" } })).toMatchObject({
        type: "query",
        param: "api_key",
      });
    });

    it("stands OAuth in as a bearer token, since there is no consent flow yet", () => {
      expect(authOf({ a: { type: "oauth2", flows: {} } })).toMatchObject({ type: "bearer" });
    });

    it("prefers a pasteable key over OAuth when a spec offers both", () => {
      // Petstore does exactly this, and lists OAuth first. OAuth needs a
      // registered app; an API key is something the user can actually provide.
      expect(
        authOf({
          petstore_auth: { type: "oauth2", flows: {} },
          api_key: { type: "apiKey", in: "header", name: "api_key" },
        }),
      ).toMatchObject({ type: "header", header: "api_key" });
    });

    it("says so when no scheme is declared at all", () => {
      const result = parseOpenApi(spec({ components: {} }), SPEC_URL)!;
      expect(result.entry.dialect.auth).toEqual({ type: "none" });
      expect(result.warnings.join()).toMatch(/needs an API key to function/);
    });
  });

  describe("swagger 2.0", () => {
    const swagger = {
      swagger: "2.0",
      info: { title: "Legacy API" },
      host: "legacy.example.com",
      basePath: "/api",
      schemes: ["https"],
      securityDefinitions: { key: { type: "apiKey", in: "header", name: "Authorization" } },
      paths: {
        "/things": {
          get: {
            summary: "Things",
            parameters: [{ name: "page", in: "query", type: "integer" }],
            responses: { "200": { schema: { type: "object", properties: { rows: { type: "array" } } } } },
          },
        },
      },
    };

    it("is still very common, so it parses too", () => {
      const { entry } = parseOpenApi(swagger, SPEC_URL)!;
      expect(entry.baseUrl).toBe("https://legacy.example.com/api");
      expect(entry.dialect.auth).toMatchObject({ type: "header", header: "Authorization" });
      expect(entry.dialect.pagination).toMatchObject({ kind: "page", param: "page" });
      expect(entry.ops[0]?.rowsPath).toBe("$.rows");
    });
  });

  it("resolves a relative server URL against where the spec was served", () => {
    const relative = spec({ servers: [{ url: "/v2" }] });
    expect(parseOpenApi(relative, SPEC_URL)!.entry.baseUrl).toBe("https://api.example.com/v2");
  });

  it("skips a templated server URL it cannot use", () => {
    const templated = spec({ servers: [{ url: "https://{tenant}.example.com" }] });
    // Falls back to the spec's own origin rather than emitting a broken base.
    expect(parseOpenApi(templated, SPEC_URL)!.entry.baseUrl).toBe("https://api.example.com");
  });

  it("imports a huge spec whole and says how big it is", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      paths[`/thing${i}`] = { get: { summary: `Thing ${i}`, responses: {} } };
    }
    const result = parseOpenApi(spec({ paths }), SPEC_URL)!;
    expect(result.entry.ops).toHaveLength(60);
    expect(result.totalOperations).toBe(60);
  });

  /*
   * A cap did not merely truncate — it took an arbitrary slice, so a
   * collection could be dropped while its own sub-collections survived,
   * leaving endpoints nobody could reach. The relation model reads structure
   * out of the whole set of paths, so a partial import is a broken graph
   * rather than a smaller one.
   */
  it("never leaves a child endpoint without the collection it hangs from", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      paths[`/pad${i}`] = { get: { summary: `Pad ${i}`, responses: {} } };
    }
    paths["/crates"] = { get: { summary: "Crates", responses: {} } };
    paths["/crates/{crateId}/items"] = {
      get: { summary: "Crate items", parameters: [], responses: {} },
    };

    const ops = parseOpenApi(spec({ paths }), SPEC_URL)!.entry.ops;
    const byPath = new Set(ops.map((op) => op.path));
    expect(byPath.has("/crates")).toBe(true);
    expect(byPath.has("/crates/{{param.crateId}}/items")).toBe(true);
  });

  describe("required parameters", () => {
    const withRequired = (parameters: unknown[]) =>
      parseOpenApi(
        spec({ paths: { "/find": { get: { summary: "Find", parameters, responses: {} } } } }),
        SPEC_URL,
      )!;

    it("seeds a required parameter from its default, so the endpoint works when tested", () => {
      // Without this, the very first validation of a discovered spec 400s.
      const { entry } = withRequired([
        { name: "status", in: "query", required: true, schema: { type: "string", default: "available" } },
      ]);
      expect(entry.ops[0]?.query).toEqual({ status: "available" });
    });

    it("falls back to an example, then to the first enum value", () => {
      expect(
        withRequired([{ name: "kind", in: "query", required: true, example: "widget" }]).entry.ops[0]?.query,
      ).toEqual({ kind: "widget" });

      expect(
        withRequired([
          { name: "state", in: "query", required: true, schema: { enum: ["open", "closed"] } },
        ]).entry.ops[0]?.query,
      ).toEqual({ state: "open" });
    });

    it("leaves optional parameters alone", () => {
      const { entry } = withRequired([
        { name: "verbose", in: "query", schema: { type: "boolean", default: true } },
      ]);
      expect(entry.ops[0]?.query).toEqual({});
    });

    it("does not seed pagination parameters — those belong to the dialect", () => {
      const { entry } = withRequired([
        { name: "limit", in: "query", required: true, schema: { default: 25 } },
        { name: "page", in: "query", required: true, schema: { default: 1 } },
      ]);
      expect(entry.ops[0]?.query).toEqual({});
    });

    it("warns about a required parameter it cannot fill in", () => {
      const { warnings } = withRequired([{ name: "accountId", in: "query", required: true }]);
      expect(warnings.join()).toMatch(/requires a "accountId" parameter that the spec gives no example for/);
    });
  });

  it("returns null for something that is not a spec", () => {
    expect(parseOpenApi({ hello: "world" }, SPEC_URL)).toBeNull();
    expect(parseOpenApi(spec({ paths: {} }), SPEC_URL)).toBeNull();
  });

  it("survives a circular $ref instead of hanging", () => {
    const circular = spec({
      components: {
        securitySchemes: {},
        schemas: { Loop: { $ref: "#/components/schemas/Loop" } },
      },
      paths: {
        "/loop": {
          get: {
            summary: "Loop",
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } } },
            },
          },
        },
      },
    });
    expect(() => parseOpenApi(circular, SPEC_URL)).not.toThrow();
  });
});

describe("specLinksIn", () => {
  it("finds spec links embedded in a docs page", () => {
    const html = `
      <script>const spec = "/static/openapi.json";</script>
      <a href="https://cdn.example.com/swagger.yaml">spec</a>
      <link href="/v3/api-docs" />
    `;
    const links = specLinksIn(html, "https://docs.example.com/reference");
    expect(links).toContain("https://docs.example.com/static/openapi.json");
    expect(links).toContain("https://cdn.example.com/swagger.yaml");
    expect(links).toContain("https://docs.example.com/v3/api-docs");
  });

  it("returns nothing when the page has no spec", () => {
    expect(specLinksIn("<html><body>Read the docs</body></html>", "https://x.com")).toEqual([]);
  });
});

describe("a spec that declares no security scheme", () => {
  const noScheme = {
    openapi: "3.0.0",
    info: { title: "Buildium-like" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/v1/leases": {
        get: { summary: "List leases", responses: { "200": { description: "ok" } } },
      },
    },
  };

  it("records that a key is needed rather than asserting the API is public", () => {
    const parsed = parseOpenApi(noScheme, "https://docs.example.com/");
    // Absent securitySchemes is silence, not a statement that it is open.
    expect(parsed?.entry.authRequired).toBe(true);
    expect(parsed?.entry.dialect.auth?.type ?? "none").toBe("none");
    expect(parsed?.warnings).toContain("This API needs an API key to function.");
  });

  it("does not flag a spec that does declare one", () => {
    const withScheme = {
      ...noScheme,
      components: {
        securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Key" } },
      },
    };
    const parsed = parseOpenApi(withScheme, "https://docs.example.com/");
    expect(parsed?.entry.authRequired).toBe(false);
    expect(parsed?.entry.dialect.auth?.type).toBe("header");
  });
});

describe("choosing the validation endpoint", () => {
  const spec = (paths: Record<string, unknown>) => ({
    openapi: "3.0.0",
    info: { title: "Params API" },
    servers: [{ url: "https://api.example.com" }],
    paths,
  });

  const listGet = (summary: string) => ({
    get: {
      summary,
      responses: {
        "200": {
          content: { "application/json": { schema: { type: "array" } } },
        },
      },
    },
  });

  it("never picks a path that still needs a parameter", () => {
    // The Buildium failure: validate hit /v1/applications/{applicationId}/…
    // and the unfilled placeholder went into the URL, returning 404 — which
    // reads as a bad key when the key was fine.
    const parsed = parseOpenApi(
      spec({
        "/v1/applications/{applicationId}/transactions": listGet("Application transactions"),
        "/v1/associations": listGet("All associations"),
      }),
      "https://docs.example.com/",
    );

    const chosen = parsed?.entry.ops.find((op) => op.id === parsed.entry.validateOpId);
    expect(chosen?.path).toBe("/v1/associations");
  });

  it("leaves it unset rather than naming an endpoint that cannot be called", () => {
    /*
     * This used to fall back to the first op. On a spec of only detail paths
     * that means validating against a URL with a live `{{param.x}}` in it,
     * which sends the placeholder literally, returns 404, and reads to the
     * user as "your key is wrong" when the key was fine. No validation
     * endpoint is the honest answer.
     */
    const parsed = parseOpenApi(
      spec({ "/v1/things/{thingId}": listGet("One thing") }),
      "https://docs.example.com/",
    );
    expect(parsed?.entry.ops).toHaveLength(1);
    expect(parsed?.entry.validateOpId).toBeUndefined();
  });
});

describe("parameter metadata", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "Params API" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/v1/leases": {
        get: {
          summary: "All leases",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "Free text" },
            { name: "status", in: "query", required: true, schema: { type: "string", enum: ["active", "terminated"] } },
            { name: "since", in: "query", schema: { type: "string", format: "date" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
        },
      },
      "/v1/leases/{leaseId}": {
        get: {
          summary: "One lease",
          parameters: [{ name: "leaseId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };

  const parsed = () => parseOpenApi(spec, "https://docs.example.com/")!;
  const opNamed = (path: string) => parsed().entry.ops.find((op) => op.path.includes(path))!;

  it("captures path parameters, which used to be discarded entirely", () => {
    const detail = opNamed("{{param.leaseId}}");
    const param = detail.params.find((p) => p.name === "leaseId")!;
    expect(param.in).toBe("path");
    expect(param.required).toBe(true);
    expect(param.type).toBe("number");
    expect(param.role).toBe("id");
  });

  it("keeps types, enums and descriptions rather than reducing to a seed value", () => {
    const list = opNamed("/v1/leases");
    const status = list.params.find((p) => p.name === "status")!;
    expect(status.enum).toEqual(["active", "terminated"]);
    expect(list.params.find((p) => p.name === "q")?.description).toBe("Free text");
  });

  it("labels what each parameter is for, so search and range are vendor-agnostic", () => {
    const list = opNamed("/v1/leases");
    expect(list.params.find((p) => p.name === "q")?.role).toBe("search");
    expect(list.params.find((p) => p.name === "since")?.role).toBe("rangeStart");
    // Pagination stays the dialect's job — duplicating it per op invites drift.
    expect(list.params.find((p) => p.name === "limit")?.role).toBeUndefined();
  });

  it("labels both ends of a range when the vendor runs the words together", () => {
    // Buildium ships `lastupdatedfrom` / `lastupdatedto` with no separator.
    // Matching only `_to_` labelled both ends rangeStart, and a range with
    // two starts silently filters nothing.
    const ranged = parseOpenApi(
      {
        openapi: "3.0.0",
        info: { title: "Ranges" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/v1/txns": {
            get: {
              summary: "Transactions",
              parameters: [
                { name: "transactiondatefrom", in: "query", schema: { type: "string", format: "date" } },
                { name: "transactiondateto", in: "query", schema: { type: "string", format: "date" } },
                { name: "created_after", in: "query", schema: { type: "string", format: "date" } },
                { name: "created[lte]", in: "query", schema: { type: "string" } },
              ],
              responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
            },
          },
        },
      },
      "https://docs.example.com/",
    )!;
    const byName = Object.fromEntries(
      ranged.entry.ops[0]!.params.map((p) => [p.name, p.role]),
    );
    expect(byName.transactiondatefrom).toBe("rangeStart");
    expect(byName.transactiondateto).toBe("rangeEnd");
    expect(byName.created_after).toBe("rangeStart");
    expect(byName["created[lte]"]).toBe("rangeEnd");
  });

  it("still seeds a required query param so the endpoint works on first test", () => {
    expect(opNamed("/v1/leases").query.status).toBe("active");
  });
});

describe("deriveResources", () => {
  const build = (paths: Record<string, unknown>) =>
    parseOpenApi(
      {
        openapi: "3.0.0",
        info: { title: "R" },
        servers: [{ url: "https://api.example.com" }],
        paths,
      },
      "https://docs.example.com/",
    )!;

  const list = (summary: string) => ({
    get: {
      summary,
      responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
    },
  });
  const detail = (summary: string, param: string) => ({
    get: {
      summary,
      parameters: [{ name: param, in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
    },
  });

  it("pairs a collection with its by-id endpoint", () => {
    const entry = build({
      "/v1/leases": list("All leases"),
      "/v1/leases/{leaseId}": detail("One lease", "leaseId"),
    }).entry;

    expect(entry.resources).toHaveLength(1);
    const resource = entry.resources[0]!;
    expect(resource.id).toBe("lease"); // singularised
    expect(resource.detailParam).toBe("leaseId");
    expect(entry.ops.find((op) => op.id === resource.listOp)?.path).toBe("/v1/leases");
    expect(entry.ops.find((op) => op.id === resource.detailOp)?.path).toBe(
      "/v1/leases/{{param.leaseId}}",
    );
  });

  it("leaves idField unset, because no specification states it", () => {
    // The path says {leaseId}; the response says Id. Only a sample can say.
    const entry = build({
      "/v1/leases": list("All leases"),
      "/v1/leases/{leaseId}": detail("One lease", "leaseId"),
    }).entry;
    expect(entry.resources[0]!.idField).toBeUndefined();
    expect(entry.resources[0]!.verified).toBe(false);
  });

  it("does not treat a nested collection as a record", () => {
    // Two parameters means this addresses a sub-collection, not one lease.
    const entry = build({
      "/v1/leases": list("All leases"),
      "/v1/leases/{leaseId}/notes/{noteId}": detail("A note", "noteId"),
    }).entry;
    expect(entry.resources).toHaveLength(0);
  });

  it("singularises without mangling the common API nouns", () => {
    const entry = build({
      "/v1/leases": list("Leases"),
      "/v1/leases/{leaseId}": detail("A lease", "leaseId"),
      "/v1/addresses": list("Addresses"),
      "/v1/addresses/{addressId}": detail("An address", "addressId"),
      "/v1/companies": list("Companies"),
      "/v1/companies/{companyId}": detail("A company", "companyId"),
      "/v1/boxes": list("Boxes"),
      "/v1/boxes/{boxId}": detail("A box", "boxId"),
    }).entry;
    expect(entry.resources.map((r) => r.id).sort()).toEqual([
      "address",
      "box",
      "company",
      "lease",
    ]);
  });

  it("ignores a detail endpoint with no matching collection", () => {
    const entry = build({ "/v1/widgets/{widgetId}": detail("One widget", "widgetId") }).entry;
    expect(entry.resources).toHaveLength(0);
  });
});

/**
 * The Aptly failure, as unit tests.
 *
 * A user submitted a docs URL and discovery offered a different company's API.
 * Each test below is one link in that chain — the first is the one that
 * actually caused it.
 */
describe("reading a spec that is not JSON", () => {
  const yamlSpec = [
    "openapi: 3.0.3",
    "info:",
    "  title: Aptly API",
    "  version: '1.0'",
    "servers:",
    "  - url: https://core-api.getaptly.com",
    "paths:",
    "  /api/users:",
    "    get:",
    "      summary: List users",
    "      responses:",
    "        '200':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: array",
    "",
  ].join("\n");

  it("parses YAML, which is what /openapi.yaml actually serves", () => {
    /*
     * The root cause: `WELL_KNOWN_SPEC_PATHS` asks for `/openapi.yaml` by
     * name and the caller checked the reply with `JSON.parse`. A real 153KB
     * spec came back, failed to parse, and was discarded as if the path had
     * 404'd — after which discovery fell through to a web search.
     */
    const doc = parseSpecDocument(yamlSpec);
    expect(looksLikeOpenApi(doc)).toBe(true);
    expect(parseOpenApi(doc, "https://docs.example.com/openapi.yaml")?.entry.baseUrl).toBe(
      "https://core-api.getaptly.com",
    );
  });

  it("still reads JSON, and prefers it", () => {
    const doc = parseSpecDocument('{"openapi":"3.0.0","info":{"title":"X"},"paths":{}}');
    expect(looksLikeOpenApi(doc)).toBe(true);
  });

  it("returns null for prose rather than throwing", () => {
    // The ladder calls this on every fetched document, most of which are HTML.
    expect(parseSpecDocument("<html><body>Not a spec</body></html>")).toBeNull();
    expect(parseSpecDocument("just some words")).toBeNull();
  });

  it("does not hand a huge non-spec document to the YAML parser", () => {
    // The version key is the cheap gate — without it every page on the web
    // gets fully parsed as YAML before being rejected.
    expect(parseSpecDocument("title: something\nvalue: 3\n")).toBeNull();
  });
});

describe("finding spec links in text that is not HTML", () => {
  it("picks up a bare URL, as Markdown carries it", () => {
    /*
     * Docs platforms content-negotiate a `.md` rendering to non-browser
     * clients, so the `<a href>` a browser sees arrives here as prose. The
     * quoted-attribute patterns walked straight past it.
     */
    const md = "Fetch the spec at https://docs.getaptly.com/openapi.yaml for all endpoints.";
    expect(specLinksIn(md, "https://docs.getaptly.com/api-reference")).toEqual([
      "https://docs.getaptly.com/openapi.yaml",
    ]);
  });

  it("trims the punctuation that ends a Markdown link or a sentence", () => {
    const md = "See [the spec](https://api.example.com/openapi.json), then try it.";
    expect(specLinksIn(md, "https://api.example.com/")).toEqual([
      "https://api.example.com/openapi.json",
    ]);
  });

  it("still reads a quoted HTML attribute", () => {
    const html = '<a href="/openapi.json">spec</a>';
    expect(specLinksIn(html, "https://api.example.com/docs")).toEqual([
      "https://api.example.com/openapi.json",
    ]);
  });
});

describe("choosing between several declared security schemes", () => {
  const withSchemes = (schemes: unknown, security?: unknown) => ({
    openapi: "3.0.3",
    info: { title: "X" },
    servers: [{ url: "https://api.example.com" }],
    ...(security ? { security } : {}),
    components: { securitySchemes: schemes },
    paths: { "/things": { get: { responses: { "200": { content: {} } } } } },
  });

  it("uses the scheme the document itself nominates", () => {
    /*
     * Aptly declares an `x-token` header, a delegate token and a partner
     * bearer, with `security: [{ApiKeyHeader: []}]` naming the first. Ranking
     * by type alone picked the bearer — every request would have 401'd.
     */
    const doc = withSchemes(
      {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "x-token" },
        PartnerBearer: { type: "http", scheme: "bearer" },
      },
      [{ ApiKeyHeader: [] }],
    );
    expect(parseOpenApi(doc, "https://api.example.com/openapi.yaml")?.entry.dialect.auth)
      .toMatchObject({ type: "header", header: "x-token" });
  });

  it("falls back to ranking when the document nominates nothing", () => {
    const doc = withSchemes({
      ApiKeyHeader: { type: "apiKey", in: "header", name: "x-token" },
      PartnerBearer: { type: "http", scheme: "bearer" },
    });
    expect(parseOpenApi(doc, "https://api.example.com/openapi.yaml")?.entry.dialect.auth)
      .toMatchObject({ type: "bearer" });
  });

  it("still prefers a pasteable key over a nominated OAuth flow", () => {
    // The nomination is a bonus, not an override: OAuth needs a registered app
    // and a consent flow, neither of which exists at connection time.
    const doc = withSchemes(
      {
        OAuth: { type: "oauth2", flows: {} },
        ApiKeyHeader: { type: "apiKey", in: "header", name: "x-token" },
      },
      [{ OAuth: [] }],
    );
    expect(parseOpenApi(doc, "https://api.example.com/openapi.yaml")?.entry.dialect.auth)
      .toMatchObject({ type: "header", header: "x-token" });
  });
});

describe("indexLinksIn", () => {
  it("finds the index a page names in its own body", () => {
    const page = "> Fetch the complete documentation index at: https://developers.example.com/docs/llms.txt";
    expect(indexLinksIn(page, "https://developers.example.com/docs/api-reference/overview")).toEqual([
      "https://developers.example.com/docs/llms.txt",
    ]);
  });

  it("resolves a root-relative mention against the page", () => {
    expect(indexLinksIn("See /docs/llms.txt for the index.", "https://x.example.com/docs/a/b")).toEqual([
      "https://x.example.com/docs/llms.txt",
    ]);
  });

  it("says nothing when the page does not mention one", () => {
    expect(indexLinksIn("# Overview\n\nJust prose.", "https://x.example.com/docs")).toEqual([]);
  });

  it("does not repeat the same index mentioned twice", () => {
    const page = "index: https://x.example.com/llms.txt … and again https://x.example.com/llms.txt";
    expect(indexLinksIn(page, "https://x.example.com/docs")).toHaveLength(1);
  });
});

/**
 * A `$ref` wearing an annotation, which is how OpenAPI 3 spells one.
 *
 * The specification ignores every sibling of a `$ref`, so a description or a
 * `nullable` can only be attached by wrapping the reference in a composition.
 * Generators do this by default, so it is the normal shape of a nested record
 * on a real enterprise spec — and unflattened it declares no type, no
 * properties and no items, which reads as a string.
 *
 * The cost was not one field. It was every field below it: nothing with a dot
 * in its name existed anywhere in the map, so drill-downs, record views and
 * object-valued foreign keys were all reasoning about a flat world.
 */
describe("a nested schema behind allOf", () => {
  const nested = spec({
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Category: {
          type: "object",
          properties: {
            Id: { type: "integer" },
            Name: { type: "string" },
          },
        },
        Task: {
          type: "object",
          properties: {
            Id: { type: "integer" },
            // The annotated reference. Siblings of `$ref` are ignored, so the
            // description forces the wrapper.
            Category: {
              allOf: [{ $ref: "#/components/schemas/Category" }],
              description: "Task category.",
              nullable: true,
            },
            // The other spelling of the same idea: a schema paired with null.
            Owner: {
              oneOf: [{ $ref: "#/components/schemas/Category" }, { type: "null" }],
            },
          },
        },
      },
    },
    paths: {
      "/tasks": {
        get: {
          operationId: "listTasks",
          summary: "List tasks",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                },
              },
            },
          },
        },
      },
    },
  });

  const fields = parseOpenApi(nested, SPEC_URL)?.entry.ops[0]?.fields ?? [];
  const named = (name: string) => fields.find((field) => field.name === name);

  it("reads the wrapper as the object it references", () => {
    expect(named("Category")?.kinds).toEqual(["object"]);
  });

  it("descends into it, which is where the useful field lives", () => {
    // `Category.Name` is the field somebody means by "maintenance tasks", and
    // it does not exist at all until the wrapper comes off.
    expect(named("Category.Name")?.kinds).toEqual(["string"]);
    expect(named("Category.Id")?.kinds).toEqual(["number"]);
  });

  it("keeps the annotation, which is the only reason the wrapper is there", () => {
    expect(named("Category")?.description).toBe("Task category.");
    expect(named("Category")?.nullable).toBe(true);
  });

  it("collapses a single-branch oneOf the same way", () => {
    expect(named("Owner")?.kinds).toEqual(["object"]);
    expect(named("Owner.Name")?.kinds).toEqual(["string"]);
  });
});

describe("a genuine union of several shapes", () => {
  const union = spec({
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Card: { type: "object", properties: { last4: { type: "string" } } },
        Bank: { type: "object", properties: { iban: { type: "string" } } },
        Payment: {
          type: "object",
          properties: {
            source: {
              oneOf: [{ $ref: "#/components/schemas/Card" }, { $ref: "#/components/schemas/Bank" }],
            },
          },
        },
      },
    },
    paths: {
      "/payments": {
        get: {
          operationId: "listPayments",
          summary: "List payments",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Payment" } },
                },
              },
            },
          },
        },
      },
    },
  });

  it("is left alone rather than resolved to whichever branch came first", () => {
    // Two real alternatives. Picking one would put fields in the map that half
    // the rows do not have, which is a worse answer than declining to descend.
    const fields = parseOpenApi(union, SPEC_URL)?.entry.ops[0]?.fields ?? [];
    expect(fields.map((field) => field.name)).not.toContain("source.last4");
    expect(fields.map((field) => field.name)).not.toContain("source.iban");
  });
});
