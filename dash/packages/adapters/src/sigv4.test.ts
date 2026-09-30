import { describe, expect, it } from "vitest";
import { awsScopeOf, signSigV4 } from "./sigv4.js";

/* AWS's own SigV4 test suite: its example credentials, and the signatures it publishes. */
const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};
const NOW = Date.UTC(2015, 7, 30, 12, 36, 0);

describe("AWS Signature Version 4", () => {
  it("signs as the test suite's get-vanilla does", async () => {
    const headers = await signSigV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, credentials, now: NOW });
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("orders the query as the suite's get-vanilla-query-order-key-case does", async () => {
    const headers = await signSigV4({
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      headers: {},
      credentials,
      now: NOW,
    });
    expect(headers.authorization).toMatch(/Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  });

  it("signs a session token with temporary credentials, and reads a region and service from an address", async () => {
    const headers = await signSigV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      credentials: { ...credentials, sessionToken: "token-1" },
      now: NOW,
    });
    expect(headers["x-amz-security-token"]).toBe("token-1");
    expect(headers.authorization).toMatch(/SignedHeaders=host;x-amz-date;x-amz-security-token,/);
    expect(awsScopeOf("https://a1b2c3.execute-api.eu-west-1.amazonaws.com/prod")).toEqual({ service: "execute-api", region: "eu-west-1" });
    expect(awsScopeOf("https://api.example.com")).toBeNull();
  });
});
