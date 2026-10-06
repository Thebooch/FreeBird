import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePem } from "./adapters/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendWithCertificate } from "./safe-fetch.js";

/*
 * Mutual TLS: a request that presents the account's client
 * certificate, to a server that refuses anybody who does not. The
 * certificates are throwaway fixtures (`fixtures/mtls/README.md`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "fixtures", "mtls", name), "utf8");
const ca = read("ca.pem");
const client = { cert: read("client.pem"), key: read("client.key") };

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer(
    { key: read("server.key"), cert: read("server.pem"), ca, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      const peer = (request.socket as TLSSocket).getPeerCertificate();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ client: peer.subject?.CN ?? null, method: request.method }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

describe("a client certificate", () => {
  it("is presented, and the server that asked for it answers", async () => {
    const answer = await sendWithCertificate(new URL(`https://localhost:${port}/records`), {
      method: "GET",
      headers: {},
      signal: new AbortController().signal,
      certificate: { ...client, ca },
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ client: "dash-client", method: "GET" });
  });

  it("is read from a one-line paste, and never offered to a plain connection", async () => {
    const pasted = normalizePem(client.cert.replace(/\n/g, " "));
    const answer = await sendWithCertificate(new URL(`https://localhost:${port}/records`), {
      method: "GET",
      headers: {},
      signal: new AbortController().signal,
      certificate: { cert: pasted, key: normalizePem(client.key.replace(/\n/g, "")), ca },
    });
    expect(answer.status).toBe(200);
    await expect(
      sendWithCertificate(new URL(`http://localhost:${port}/records`), {
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
        certificate: { ...client, ca },
      }),
    ).rejects.toThrow(/only sent over https/);
  });

  it("is refused by the server when it is not one it trusts", async () => {
    /* The server's own certificate is no client certificate this server accepts from anyone but its CA — here, a wrong key. */
    await expect(
      sendWithCertificate(new URL(`https://localhost:${port}/records`), {
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
        certificate: { cert: client.cert, key: read("server.key"), ca },
      }),
    ).rejects.toThrow();
  });
});
