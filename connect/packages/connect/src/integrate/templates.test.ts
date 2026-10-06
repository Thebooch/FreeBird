import type { ConnectorRequest } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { generalizePath, namedInDocs, templatesFromTrace, templatesProblem, uniqueTemplates } from "./templates.js";

const connection = { baseUrl: "https://api.example.test/v2" };
const docs = "POST /login with your key. POST /search with { query }. GET /exports/{id} for an export's status. POST /exports starts one.";
const writes = [
  { method: "POST", path: "/login" },
  { method: "POST", path: "/exports" },
  { method: "POST", path: "/records/{{param.id}}/archive" },
];
const post = (id: string, path: string, purpose: ConnectorRequest["purpose"]): ConnectorRequest => ({
  id,
  purpose,
  method: "POST",
  host: "api.example.test",
  path,
  credentials: [],
});

describe("request templates", () => {
  it("generalize ids, never versions", () => {
    expect(generalizePath("/v2/exports/exp_17/file")).toBe("/v2/exports/{id}/file");
    expect(generalizePath("/v2/accounts/4211/payments/9f1c2d3e-0a1b-4c5d-8e9f-001122334455")).toBe("/v2/accounts/{id}/payments/{id2}");
  });

  it("allow a POST only where the documentation names its path, written on the host or from the address", () => {
    expect(namedInDocs("/v2/search", docs, connection)).toBe(true);
    expect(namedInDocs("/v2/admin/purge", docs, connection)).toBe(false);
    /* Regression: a path written inside a whole address is named too. */
    expect(namedInDocs("/xml/v1/request.api", "Send every request to https://api.example.test/xml/v1/request.api as XML.", connection)).toBe(true);
  });

  it("keep one id each: the same request once, two requests under one name told apart", () => {
    const one = post("search", "/v2/search", "search");
    expect(uniqueTemplates([one, { ...one }, { ...one, path: "/v2/find" }]).map((template) => [template.id, template.path])).toEqual([
      ["search", "/v2/search"],
      ["search-2", "/v2/find"],
    ]);
  });

  it("refuse an endpoint that changes the account, and allow a sign-in, a search or an export declared as one", () => {
    expect(templatesProblem([post("archive", "/v2/records/{id}/archive", "search")], { docs: `${docs} POST /records/{id}/archive`, writes, connection })).toMatch(
      /changes things in the account/,
    );
    expect(templatesProblem([post("login", "/v2/login", "exchange"), post("export", "/v2/exports", "export-create")], { docs, writes, connection })).toBeNull();
    /* The same export endpoint, declared as an ordinary read, is a write like any other. */
    expect(templatesProblem([post("export", "/v2/exports", "read")], { docs, writes, connection })).toMatch(/changes things/);
  });

  it("learn what a run sent, once each, refused requests left out", () => {
    const destinations = [{ host: "api.example.test", role: "api" as const, methods: ["GET" as const, "POST" as const], credentials: ["key"] }];
    const learned = templatesFromTrace(
      [
        { method: "POST", host: "api.example.test", path: "/v2/exports", status: 202, purpose: "read" },
        { method: "GET", host: "api.example.test", path: "/v2/exports/exp_1", status: 200, purpose: "read" },
        { method: "GET", host: "api.example.test", path: "/v2/exports/exp_2", status: 200, purpose: "read" },
        { method: "DELETE", host: "api.example.test", path: "/v2/exports/exp_1", status: null, purpose: "read", refused: "no" },
      ],
      destinations,
    );
    expect(learned.map((one) => `${one.purpose} ${one.method} ${one.path}`)).toEqual(["export-create POST /v2/exports", "read GET /v2/exports/{id}"]);
  });
});
