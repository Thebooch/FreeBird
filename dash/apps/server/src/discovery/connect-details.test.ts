import { IMPORT_VERSION, catalogEntrySchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { importIsOutdated, refreshOutdatedConnectDetails } from "./connect-details.js";

/**
 * An entry imported before the importer learned to read addresses and logins
 * properly — Rentvine as it was first imported: requests aimed at the docs
 * site, a Basic login with a placeholder username — beside work that was paid
 * for since. The refresh has to fix the first and keep the second.
 */

const OLD = catalogEntrySchema.parse({
  id: "rentvine-api-docs",
  title: "Rentvine API Docs",
  baseUrl: "https://docs.rentvine.com",
  specUrl: "https://docs.rentvine.com/openapi.json",
  origin: "openapi",
  dialect: { auth: { type: "basic", username: "api", keyRef: "rentvine-api-docs-key" } },
  ops: [
    {
      id: "properties",
      title: "Properties",
      path: "/properties",
      description: "Written by the mapping pass, and paid for.",
    },
  ],
  entities: [
    {
      id: "property",
      resource: "property",
      name: { one: "Property", many: "Properties" },
      kind: "place",
      identity: { field: "propertyID", observed: true },
      fields: [{ path: "propertyID" }],
    },
  ],
});

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Rentvine API Docs" },
  servers: [
    {
      url: "https://{account}.rentvine.com/api/manager",
      variables: { account: { description: "Your account subdomain", default: "example" } },
    },
  ],
  components: { securitySchemes: { basicAuth: { type: "http", scheme: "basic" } } },
  security: [{ basicAuth: [] }],
  tags: [
    {
      name: "Authentication",
      description: "Use HTTP Basic Authentication with the access key as the username and secret as the password.",
    },
  ],
  paths: { "/properties": { get: { summary: "Properties", responses: {} } } },
};

const fetchDocument = async (url: string) => ({ status: 200, text: JSON.stringify(SPEC), url });

describe("refreshing how to connect", () => {
  it("knows an entry written by an older importer", () => {
    expect(importIsOutdated(OLD)).toBe(true);
    expect(importIsOutdated({ ...OLD, importVersion: IMPORT_VERSION })).toBe(false);
    /* Hand-written entries were never an import's reading. */
    expect(importIsOutdated({ ...OLD, origin: "repo" })).toBe(false);
  });

  it("fixes the address and the login, and keeps what was learned since", async () => {
    const { entry, refreshed } = await refreshOutdatedConnectDetails(OLD, fetchDocument);
    expect(refreshed).toBe(true);
    expect(entry.server?.url).toBe("https://{account}.rentvine.com/api/manager");
    expect(entry.dialect.auth).toMatchObject({
      type: "basic",
      usernameLabel: "Access key",
      label: "Secret",
    });
    expect(entry.keyHelp).toMatch(/access key as the username/);
    expect(entry.importVersion).toBe(IMPORT_VERSION);
    /* Untouched: the paid-for description and the record types. */
    expect(entry.ops[0]?.description).toBe("Written by the mapping pass, and paid for.");
    expect(entry.entities?.map((one) => one.id)).toEqual(["property"]);
  });

  it("leaves a current entry alone, and does not fetch for it", async () => {
    let fetched = 0;
    const current = { ...OLD, importVersion: IMPORT_VERSION };
    const { entry, refreshed } = await refreshOutdatedConnectDetails(current, async (url) => {
      fetched++;
      return fetchDocument(url);
    });
    expect(refreshed).toBe(false);
    expect(entry).toBe(current);
    expect(fetched).toBe(0);
  });

  it("keeps the old reading when the spec cannot be read", async () => {
    const { entry, refreshed } = await refreshOutdatedConnectDetails(OLD, async (url) => ({
      status: 500,
      text: "",
      url,
    }));
    expect(refreshed).toBe(false);
    expect(entry).toBe(OLD);
  });
});
