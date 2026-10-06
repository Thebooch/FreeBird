import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowlistEgress, assertReachable, configureEgress, guardedFetch, publicOnlyEgress } from "./safe-fetch.js";

/*
 * An API on a private network, reached only where the server's
 * operator allows its address and the connection says it is on one.
 */

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  configureEgress(publicOnlyEgress);
});

describe("the operator's allowance", () => {
  it("names hosts, suffixes and ranges, and never link-local, however it is listed", () => {
    const policy = allowlistEgress("erp.office.lan, *.corp.example, 10.20.0.0/16, 169.254.0.0/16");
    expect(policy.allowsPrivate("erp.office.lan", "192.168.1.10")).toBe(true);
    expect(policy.allowsPrivate("billing.corp.example", "10.99.0.4")).toBe(true);
    expect(policy.allowsPrivate("anything", "10.20.7.8")).toBe(true);
    expect(policy.allowsPrivate("anything", "10.21.0.1")).toBe(false);
    expect(policy.allowsPrivate("metadata", "169.254.169.254")).toBe(false);
    expect(publicOnlyEgress.allowsPrivate("erp.office.lan", "192.168.1.10")).toBe(false);
  });

  it("is needed as well as the connection's own word, and says what is missing", async () => {
    const url = `http://127.0.0.1:${port}/items`;
    /* The connection did not say it is on a private network: the public guard, as always. */
    await expect(assertReachable(url, false)).rejects.toThrow(/isn't reachable/);
    /* It did, and nobody allowed the address. */
    await expect(assertReachable(url, true)).rejects.toThrow(/DASH_PRIVATE_EGRESS/);
    configureEgress(allowlistEgress("10.0.0.0/8"));
    await expect(assertReachable(url, true)).rejects.toThrow(/not in this server's allowance \(10\.0\.0\.0\/8\)/);
    configureEgress(allowlistEgress("127.0.0.1"));
    expect(await assertReachable(url, true)).toMatchObject({ pinned: "127.0.0.1" });
  });
});

describe("a request to a private address", () => {
  it("is sent to the address that was checked, and only where both said yes", async () => {
    const url = `http://127.0.0.1:${port}/items?page=2`;
    await expect(guardedFetch(url, { privateNetwork: true }, "127.0.0.1")).rejects.toThrow();
    configureEgress(allowlistEgress("127.0.0.1"));
    const answer = await guardedFetch(url, { privateNetwork: true }, "127.0.0.1");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toMatchObject({ path: "/items?page=2" });
    /* The connection's own host pin still holds on a private network. */
    await expect(guardedFetch(url, { privateNetwork: true }, "erp.office.lan")).rejects.toThrow(/may only reach/);
  });
});
