import { describe, expect, it } from "vitest";
import { catalogEntrySchema } from "./dialect.js";
import { connectionNeedsAddress, connectionSchema } from "./connection.js";
import {
  authCredentials,
  authKeyRefs,
  authSchema,
  looksLikePlaceholder,
  rekeyAuth,
  resolveServerUrl,
  templateVariableNames,
} from "./primitives.js";

/**
 * Where an API lives, and what somebody must give it to get in.
 *
 * The two things a connection needs from the person making it, for an API
 * from any website: the address — which for a lot of business software is
 * different for every account — and every credential, named the way the
 * vendor names it.
 */

const RENTVINE = {
  url: "https://{account}.rentvine.com/api/manager",
  variables: [{ name: "account", description: "Your account subdomain", default: "example" }],
};

describe("resolveServerUrl", () => {
  it("fills in the blanks", () => {
    expect(resolveServerUrl(RENTVINE, { account: "123pm" }).url).toBe(
      "https://123pm.rentvine.com/api/manager",
    );
  });

  it("says which blank is empty rather than making a half address", () => {
    const result = resolveServerUrl(RENTVINE, {});
    expect(result.url).toBeUndefined();
    expect(result.missing).toEqual(["account"]);
  });

  /* A value that moves the request to another host is not a subdomain. */
  it("refuses a value that could change the host", () => {
    for (const value of ["evil.com/x", "a@evil.com", "a:8080", "a b"]) {
      const result = resolveServerUrl(RENTVINE, { account: value });
      expect(result.url).toBeUndefined();
      expect(result.invalid).toEqual(["account"]);
    }
  });

  it("holds a value to the options the documentation lists", () => {
    const regional = {
      url: "https://{region}.api.example.com",
      variables: [{ name: "region", options: ["us", "eu"] }],
    };
    expect(resolveServerUrl(regional, { region: "eu" }).url).toBe("https://eu.api.example.com");
    expect(resolveServerUrl(regional, { region: "apac" }).invalid).toEqual(["region"]);
  });

  it("reads the names out of a template", () => {
    expect(templateVariableNames("https://{a}.x.com/{b}/{a}")).toEqual(["a", "b"]);
  });
});

describe("looksLikePlaceholder", () => {
  /* "example" filled in would send the first request to a host nobody's
   * account lives on. */
  it("treats a documented example as a hint, not a value", () => {
    expect(looksLikePlaceholder({ name: "account", default: "example" })).toBe(true);
    expect(looksLikePlaceholder({ name: "account", default: "your-company" })).toBe(true);
    expect(looksLikePlaceholder({ name: "account" })).toBe(true);
  });

  it("keeps a default that is a real choice", () => {
    expect(looksLikePlaceholder({ name: "version", default: "v2" })).toBe(false);
    expect(looksLikePlaceholder({ name: "region", default: "us", options: ["us", "eu"] })).toBe(
      false,
    );
  });
});

describe("connectionNeedsAddress", () => {
  const base = { id: "rv", title: "Rentvine", kind: "rest", baseUrl: "https://example.rentvine.com" };

  it("needs one until every blank has a value", () => {
    expect(
      connectionNeedsAddress(
        connectionSchema.parse({ ...base, server: { ...RENTVINE, values: {} } }),
      ),
    ).toBe(true);
    expect(
      connectionNeedsAddress(
        connectionSchema.parse({ ...base, server: { ...RENTVINE, values: { account: "123pm" } } }),
      ),
    ).toBe(false);
  });

  it("needs one while the address is a guess", () => {
    expect(connectionNeedsAddress(connectionSchema.parse({ ...base, addressPending: true }))).toBe(
      true,
    );
  });

  it("does not ask of a connection with a fixed address", () => {
    expect(connectionNeedsAddress(connectionSchema.parse(base))).toBe(false);
  });
});

describe("Basic auth with a stored username", () => {
  const basic = authSchema.parse({
    type: "basic",
    usernameRef: "rv-user",
    keyRef: "rv-key",
    usernameLabel: "Access key",
    label: "Secret",
  });

  it("asks for both halves, username first, by the vendor's names", () => {
    expect(authKeyRefs(basic)).toEqual(["rv-user", "rv-key"]);
    expect(authCredentials(basic).map((one) => one.label)).toEqual(["Access key", "Secret"]);
  });

  /* The catalog's names are placeholders; every connection gets its own. A
   * username left on the catalog's name would be shared by two accounts. */
  it("gives every credential a new name, not only the password", () => {
    const renamed = rekeyAuth(basic, (_old, index) => `mine-${index + 1}`);
    expect(authKeyRefs(renamed)).toEqual(["mine-1", "mine-2"]);
  });

  it("still reads a fixed username saved before the username could be a secret", () => {
    const legacy = authSchema.parse({ type: "basic", username: "api", keyRef: "k" });
    expect(authKeyRefs(legacy)).toEqual(["k"]);
    expect(authCredentials(legacy)).toHaveLength(1);
  });
});

describe("catalogEntrySchema", () => {
  it("carries an address template and a guessed address", () => {
    const entry = catalogEntrySchema.parse({
      id: "rentvine",
      title: "Rentvine",
      baseUrl: "https://example.rentvine.com/api/manager",
      dialect: {},
      server: RENTVINE,
    });
    expect(entry.server?.variables[0]?.name).toBe("account");

    const guessed = catalogEntrySchema.parse({
      id: "x",
      title: "X",
      baseUrl: "https://docs.x.com",
      dialect: {},
      baseUrlGuessed: true,
    });
    expect(guessed.baseUrlGuessed).toBe(true);
  });
});
