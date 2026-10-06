import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilityNote, compatibilityMarkdown } from "./capabilities.js";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "dash", "COMPATIBILITY.md");

describe("the compatibility manifest", () => {
  it("names every capability once", () => {
    const ids = CAPABILITIES.map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("says a gap in words a person connecting an API can act on", () => {
    expect(capabilityNote("auth.signing", 'The "signed" sign-in scheme')).toBe(
      'The "signed" sign-in scheme uses signed requests (AWS Signature, HMAC), which is only partly supported. Connector code signs each request: the server makes the signature with your key, and the code never sees the key. Each API\'s signing is written from its documentation and proven by a read. AWS Signature Version 4 needs no code: it is built in, signing each request with your secret access key for the region its address or documentation names.',
    );
    expect(capabilityNote("response.csv", "3 endpoints")).toMatch(/^3 endpoints use CSV/);
    expect(capabilityNote("auth.oauth2-token")).toMatch(
      /^This API uses OAuth 2\.0 without a flow Dash can run, which is only partly supported\. When the documentation/,
    );
  });

  /*
   * The document is generated from the manifest, so the two cannot drift: a
   * change to one without the other fails here. Set UPDATE_COMPATIBILITY=1 to
   * rewrite the file from the manifest.
   */
  it("matches COMPATIBILITY.md", () => {
    const generated = compatibilityMarkdown();
    if (process.env.UPDATE_COMPATIBILITY === "1") writeFileSync(DOC, generated);
    expect(readFileSync(DOC, "utf8").replace(/\r\n/g, "\n")).toBe(generated);
  });
});
