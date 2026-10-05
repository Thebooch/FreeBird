import { fakeLlm } from "@freebirdai/connect/agent";
import { connectorServes, type ConnectionSpec } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { benchConnectors } from "../bench/connectors.js";
import { tfPayments, twofold } from "../bench/providers/twofold.js";
import { benchTransport } from "../bench/transport.js";
import {
  authorConnector,
  budgetOf,
  connectionFromCatalog,
  connectorReader,
  discover,
  docsKnowledge,
  isProving,
  tryRead,
} from "@freebirdai/connect/host";

/*
 * Code for a second endpoint is written beside the first's, never over it;
 * shared code is replaced only when everything it read still reads. The
 * code here is scripted: what is pinned is the loop.
 */

const NOW = Date.UTC(2026, 8, 30);
const API = "api.twofold.bench.test";
const FILES = "files.twofold.bench.test";

const SIGN_IN = `async function authenticate() {
  await auth.exchange({ name: "session", request: { method: "POST", url: "/session", body: { api_key: "{{secret:api_key}}" } }, token: "$.token", expiresIn: "$.expires_in" });
}
const signed = { authorization: "Session {{secret:session}}" };`;

const INVOICES = `${SIGN_IN}
async function read() {
  const started = await http.request({ method: "POST", url: "/invoices/exports", headers: signed, body: {} });
  for (let poll = 0; poll < 10; poll++) {
    const state = await http.request({ url: "/invoices/exports/" + started.body.id, headers: signed });
    if (state.body.status === "ready") return { rows: (await http.request({ url: state.body.file_url, as: "csv" })).body, done: "all" };
    await sleep(2000);
  }
  return { rows: [], done: "partial", reason: "not ready" };
}`;

/* Payments alone, beside the shared code: it calls nothing it does not define but the shared \`signed\`. */
const PAYMENTS = `async function read() {
  const accounts = await http.request({ url: "/accounts", headers: signed });
  const rows = [];
  for (const account of accounts.body.data) rows.push(...(await http.request({ url: "/payments", query: { account_id: account.id }, headers: signed })).body.data);
  return { rows, done: "all" };
}`;

const invoicesProposal = {
  summary: "Starts a session, then reads invoices through an export.",
  credentials: [{ name: "api_key", label: "API key" }],
  exchanges: [{ name: "session" }],
  destinations: [
    { host: API, role: "api", methods: ["GET", "POST"], credentials: ["api_key", "session"] },
    { host: FILES, role: "download", methods: ["GET"], credentials: [] },
  ],
  requests: [
    { id: "session", purpose: "exchange", method: "POST", host: API, path: "/v1/session", credentials: ["api_key"] },
    { id: "start_export", purpose: "export-create", method: "POST", host: API, path: "/v1/invoices/exports", credentials: ["session"] },
  ],
  serves: true,
  code: INVOICES,
};

const paymentsProposal = {
  summary: "Reads each account's payments.",
  credentials: [{ name: "api_key", label: "API key" }],
  destinations: [{ host: API, role: "api", methods: ["GET"], credentials: ["session"] }],
  requests: [],
  serves: true,
  part: "endpoint",
  code: PAYMENTS,
};

const setUp = async () => {
  twofold.reset?.();
  const transport = benchTransport([twofold]);
  const found = await discover(twofold.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
  const connection = connectionFromCatalog(found.entry!, { id: "twofold" });
  const opOf = (path: string) => connection.ops.find((op) => op.path === path)!.id;
  const kit = benchConnectors(NOW);
  const read = { http: transport.http, resolveSecret: async () => twofold.credentials[0]!, now: () => NOW, budget: budgetOf(400) };
  const author = (on: ConnectionSpec, opId: string, answers: unknown[]) => {
    const llm = fakeLlm(answers.map((args) => ({ args })));
    return {
      llm,
      result: authorConnector({
        connection: on,
        opId,
        problem: "The API needs a session from POST /session, and this endpoint is not answered as documented.",
        docs: docsKnowledge({ docsUrl: twofold.docsUrl, fetchDocument: transport.fetchDocument }),
        docsUrl: twofold.docsUrl,
        llm,
        kit,
        read,
        attempts: 3,
        now: () => NOW,
        writes: (found.entry!.writes ?? []).map((write) => ({ method: write.method, path: write.path })),
      }),
    };
  };
  const readThrough = (on: ConnectionSpec, opId: string) => tryRead(on, opId, { ...read, budget: budgetOf(400), adapter: connectorReader(kit) });
  return { connection, opOf, author, readThrough };
};

describe("connector code for a second endpoint", () => {
  it("is written beside the first's, which goes on reading exactly as before", async () => {
    const { connection, opOf, author, readThrough } = await setUp();
    const invoices = opOf("/invoices");
    const payments = opOf("/payments");

    const first = await author(connection, invoices, [invoicesProposal]).result;
    expect(first.connection?.connector?.serves).toEqual([invoices]);
    const shared = first.connection!.connector!;
    /* Proven: what it sent became its templates, and the GET-anywhere it was proven with is gone. */
    expect(shared.authority.templates?.some(isProving)).toBe(false);
    expect(shared.authority.templates?.map((one) => `${one.method} ${one.host}${one.path}`)).toEqual(
      expect.arrayContaining([`POST ${API}/v1/session`, `POST ${API}/v1/invoices/exports`, `GET ${API}/v1/invoices/exports/{id}`]),
    );

    const second = author(first.connection!, payments, [paymentsProposal]);
    const beside = await second.result;
    const asked = second.llm.calls[0]!.messages.map((message) => String(message.content)).join("\n");
    expect(asked).toContain("THE SHARED CODE");
    const after = beside.connection!.connector!;
    expect(after.code).toBe(shared.code);
    expect(after.version).toBe(1);
    expect(Object.keys(after.operations)).toEqual([payments]);
    expect(connectorServes(after, invoices) && connectorServes(after, payments)).toBe(true);

    const invoicesAgain = await readThrough(beside.connection!, invoices);
    expect(invoicesAgain.rows).toHaveLength(140);
    const paid = await readThrough(beside.connection!, payments);
    expect(paid.rows).toHaveLength(tfPayments.length);
  });

  it("never replaces shared code that something already reads with code that breaks it", async () => {
    const { connection, opOf, author, readThrough } = await setUp();
    const invoices = opOf("/invoices");
    const payments = opOf("/payments");
    const first = await author(connection, invoices, [invoicesProposal]).result;

    /* A rewrite of the whole that reads payments and nothing else. */
    const breaking = {
      ...invoicesProposal,
      part: "whole",
      code: `${SIGN_IN}
async function read(ctx) {
  if (ctx.op.path.indexOf("payments") < 0) throw new Error("this code reads payments only");
  const accounts = await http.request({ url: "/accounts", headers: signed });
  const rows = [];
  for (const account of accounts.body.data) rows.push(...(await http.request({ url: "/payments", query: { account_id: account.id }, headers: signed })).body.data);
  return { rows, done: "all" };
}`,
    };
    const replaced = await author(first.connection!, payments, [breaking, breaking, breaking]).result;
    expect(replaced.connection).toBeNull();
    expect(replaced.log.join("\n")).toMatch(/no longer reads what the old code read/);
    /* What was there is what there is: the invoices still read through the first code. */
    const still = await readThrough(first.connection!, invoices);
    expect(still.rows).toHaveLength(140);
  });

  it("refuses, before it runs, a template for an endpoint the documentation never names", async () => {
    const { connection, opOf, author } = await setUp();
    const invented = {
      ...invoicesProposal,
      requests: [...invoicesProposal.requests, { id: "purge", purpose: "search", method: "POST", host: API, path: "/v1/admin/purge", credentials: ["session"] }],
    };
    const { result } = author(connection, opOf("/invoices"), [invented, invented, invented]);
    const refused = await result;
    expect(refused.connection).toBeNull();
    expect(refused.log.join("\n")).toMatch(/POST \/v1\/admin\/purge\) is not a path the documentation names/);
  });

  it("never tries code that may POST without declaring the requests it sends", async () => {
    const { connection, opOf, author } = await setUp();
    const undeclared = { ...invoicesProposal, requests: [] };
    const { result } = author(connection, opOf("/invoices"), [undeclared, undeclared, undeclared]);
    const refused = await result;
    expect(refused.connection).toBeNull();
    /* Refused before it ran: no attempt, so no request left. */
    expect(refused.attempt).toBeNull();
    expect(refused.log.join("\n")).toMatch(/not tried: it may send POST and declares none of its requests/);
  });
});
