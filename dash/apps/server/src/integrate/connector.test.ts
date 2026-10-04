import { fakeLlm } from "@freebirdai/dash-agent";
import { authCredentials, getOp } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { benchConnectors } from "../bench/connectors.js";
import { sessionly } from "../bench/providers/sessionly.js";
import { stampede } from "../bench/providers/stampede.js";
import { benchTransport } from "../bench/transport.js";
import type { MockProvider } from "../bench/types.js";
import { connectionFromCatalog } from "../catalog.js";
import { discover } from "../discovery/index.js";
import { integrate } from "./agent.js";

/**
 * The loop writing connector code, against the dev-set providers for step 4.
 *
 * What is pinned is the loop's behaviour around the code — when it asks for
 * code, what it tells the model, what it keeps — never the model's judgment:
 * the code here is scripted. The held-out provider is absent, as always.
 */

const NOW = Date.UTC(2026, 8, 1);

const setUp = async (provider: MockProvider) => {
  provider.reset?.();
  const transport = benchTransport([provider]);
  const found = await discover(provider.docsUrl, { fetchDocument: transport.fetchDocument, llm: null });
  const connection = connectionFromCatalog(found.entry!, { id: provider.id });
  return { transport, entry: found.entry!, connection };
};

const proposalOf = (provider: MockProvider) => provider.scriptedModel!.propose_connector as Record<string, unknown>;

describe("the loop writes connector code", () => {
  it("drafts code for a login it cannot express, asks for what it declares, then proves it", async () => {
    const { transport, entry, connection } = await setUp(sessionly);
    /* The login's session is not something anybody pastes: nothing is asked for yet. */
    expect(connection.auth.type).toBe("none");
    const opId = connection.ops.find((op) => op.path === "/tickets")!.id;
    const secrets: Record<string, string> = {};
    const kit = benchConnectors(NOW);
    const llm = fakeLlm([{ args: proposalOf(sessionly) }]);
    const deps = {
      http: transport.http,
      resolveSecret: async (ref: string) => secrets[ref] ?? null,
      fetchDocument: transport.fetchDocument,
      now: () => NOW,
      llm,
      connectors: kit,
    };

    const draft = await integrate(connection, { targets: [opId], entry, docsUrl: sessionly.docsUrl }, deps);
    expect(draft.outcome).toBe("blocked");
    expect(draft.blocked).toBe("Paste the Email and Password from your Sessionly account. The check runs again by itself once you have.");
    expect(draft.needsCredentials?.map((one) => one.label)).toEqual(["Email", "Password"]);
    expect(draft.connection.connector?.serves).toEqual([opId]);
    expect(getOp(draft.connection, opId)?.readSafety?.basis).toBe("model-inferred");
    expect(transport.apiRequests()).toBe(0);
    /* Written from the reference, not only the overview: every endpoint's inputs and answers. */
    const asked = llm.calls[0]!.messages.map((message) => String(message.content)).join("\n");
    expect(asked).toContain("POST /login — Log in\n  Body (application/json): email: string, password: string");
    expect(asked).toContain("query after (integer)");

    const [email, password] = authCredentials(draft.connection.auth);
    secrets[email!.keyRef] = sessionly.credentials[0]!;
    secrets[password!.keyRef] = sessionly.credentials[1]!;
    const proven = await integrate(draft.connection, { targets: [opId], entry, docsUrl: sessionly.docsUrl }, deps);
    expect(proven.outcome).toBe("ready");
    expect(proven.ops[0]?.note).toMatch(/230 record/);
    expect(llm.calls).toHaveLength(1);
  });

  /* 2026-09-30: code written before the key was pasted gave up on an export and answered with nothing, and the check took that as an empty account. */
  it("revises code that reads nothing once the key is pasted, rather than keeping it", async () => {
    const { transport, entry, connection } = await setUp(sessionly);
    const opId = connection.ops.find((op) => op.path === "/tickets")!.id;
    const secrets: Record<string, string> = {};
    const good = proposalOf(sessionly);
    const empty = {
      ...good,
      serves: true,
      code: `${String(good.code)}
async function read(ctx) {
  return { rows: [], complete: true };
}`,
    };
    const llm = fakeLlm([{ args: empty }, { args: good }]);
    const deps = {
      http: transport.http,
      resolveSecret: async (ref: string) => secrets[ref] ?? null,
      fetchDocument: transport.fetchDocument,
      now: () => NOW,
      llm,
      connectors: benchConnectors(NOW),
    };
    const draft = await integrate(connection, { targets: [opId], entry, docsUrl: sessionly.docsUrl }, deps);
    const [email, password] = authCredentials(draft.connection.auth);
    secrets[email!.keyRef] = sessionly.credentials[0]!;
    secrets[password!.keyRef] = sessionly.credentials[1]!;
    const proven = await integrate(draft.connection, { targets: [opId], entry, docsUrl: sessionly.docsUrl }, deps);
    expect(proven.outcome).toBe("ready");
    expect(proven.ops[0]?.note).toMatch(/230 record/);
    const revision = llm.calls[1]!.messages.map((message) => String(message.content)).join("\n");
    expect(revision).toMatch(/produced no records/);
  });

  it("revises code that failed, shown what happened and never a credential", async () => {
    const { transport, entry, connection } = await setUp(stampede);
    const opId = connection.ops[0]!.id;
    const secrets = Object.fromEntries(authCredentials(connection.auth).map((one) => [one.keyRef, stampede.credentials[0]!]));
    const good = proposalOf(stampede);
    const forgetful = { ...good, code: String(good.code).replace(/\n\s*request\.headers\["x-date"\][^\n]*/, "") };
    const llm = fakeLlm([
      { args: stampede.scriptedModel!.propose_repair },
      { args: forgetful },
      { args: good },
    ]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: stampede.docsUrl },
      {
        http: transport.http,
        resolveSecret: async (ref: string) => secrets[ref] ?? null,
        fetchDocument: transport.fetchDocument,
        now: () => NOW,
        llm,
        connectors: benchConnectors(NOW),
      },
    );
    expect(report.outcome).toBe("ready");
    expect(report.connection.connector?.code).toBe(good.code);
    /* The key the person pasted still signs in: the connector took over its vault name. */
    expect(authCredentials(report.connection.auth).map((one) => one.keyRef)).toEqual(Object.keys(secrets));
    const revision = llm.calls[2]!.messages.map((message) => String(message.content)).join("\n");
    expect(revision).toMatch(/YOUR PREVIOUS CODE/);
    expect(revision).toMatch(/X-Date is required/);
    expect(revision).toMatch(/GET api\.stampede\.bench\.test\/v1\/orders → 400/);
    expect(revision).not.toContain(stampede.credentials[0]);
  });

  /* Regression: code that read 100 of 180 records and said so was kept, and the total was wrong. */
  it("revises code that stopped before the end of the records, rather than keeping it", async () => {
    const { transport, entry, connection } = await setUp(stampede);
    const opId = connection.ops[0]!.id;
    const secrets = Object.fromEntries(authCredentials(connection.auth).map((one) => [one.keyRef, stampede.credentials[0]!]));
    const good = proposalOf(stampede);
    const onePage = {
      ...good,
      serves: true,
      code: `${String(good.code)}
async function read(ctx) {
  const answer = await http.request({ url: "/orders", query: { page: 1, per_page: 50 } });
  return { rows: answer.body.orders, complete: answer.body.pages <= 1 };
}`,
    };
    const llm = fakeLlm([{ args: stampede.scriptedModel!.propose_repair }, { args: onePage }, { args: good }]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: stampede.docsUrl },
      {
        http: transport.http,
        resolveSecret: async (ref: string) => secrets[ref] ?? null,
        fetchDocument: transport.fetchDocument,
        now: () => NOW,
        llm,
        connectors: benchConnectors(NOW),
      },
    );
    expect(report.outcome).toBe("ready");
    expect(report.connection.connector?.code).toBe(good.code);
    const revision = llm.calls[2]!.messages.map((message) => String(message.content)).join("\n");
    expect(revision).toMatch(/It read 50 record\(s\) and then stopped before the end of them/);
    expect(revision).toMatch(/not a size to stop at/);
  });

  it("does not try code whose authority reaches outside the service", async () => {
    const { transport, entry, connection } = await setUp(stampede);
    const opId = connection.ops[0]!.id;
    const secrets = Object.fromEntries(authCredentials(connection.auth).map((one) => [one.keyRef, stampede.credentials[0]!]));
    const good = proposalOf(stampede);
    const leaky = { ...good, destinations: [...(good.destinations as object[]), { host: "collector.example.org", role: "api", methods: ["GET"], credentials: ["api_key"] }] };
    const llm = fakeLlm([{ args: stampede.scriptedModel!.propose_repair }, { args: leaky }, { args: good }]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: stampede.docsUrl },
      {
        http: transport.http,
        resolveSecret: async (ref: string) => secrets[ref] ?? null,
        fetchDocument: transport.fetchDocument,
        now: () => NOW,
        llm,
        connectors: benchConnectors(NOW),
      },
    );
    expect(report.log.join("\n")).toMatch(/collector\.example\.org is not part of the service/);
    expect(report.outcome).toBe("ready");
    expect(report.connection.connector?.authority.destinations.map((one) => one.host)).toEqual(["api.stampede.bench.test"]);
  });

  /* A caveat in `cannot` beside working code once stopped a check before the code ran. */
  it("tries code that comes with a caveat, and keeps the caveat as an assumption", async () => {
    const { transport, entry, connection } = await setUp(sessionly);
    const opId = connection.ops.find((op) => op.path === "/tickets")!.id;
    const llm = fakeLlm([
      { args: { ...proposalOf(sessionly), cannot: "The documentation does not say how long a session lasts; this logs in again when one is refused." } },
    ]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: sessionly.docsUrl },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW, llm, connectors: benchConnectors(NOW) },
    );
    expect(report.connection.connector?.serves).toEqual([opId]);
    expect(report.needsCredentials?.map((one) => one.label)).toEqual(["Email", "Password"]);
    expect(report.log.join("\n")).toMatch(/assuming: The documentation does not say how long a session lasts/);
  });

  it("stops, and says why, when the model finds the documentation does not say enough", async () => {
    const { transport, entry, connection } = await setUp(sessionly);
    const opId = connection.ops.find((op) => op.path === "/tickets")!.id;
    const llm = fakeLlm([
      {
        args: {
          ...proposalOf(sessionly),
          code: "// nothing to write",
          cannot: "The documentation never says what the login answers with.",
        },
      },
    ]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: sessionly.docsUrl },
      {
        http: transport.http,
        resolveSecret: async () => null,
        fetchDocument: transport.fetchDocument,
        now: () => NOW,
        llm,
        connectors: benchConnectors(NOW),
      },
    );
    expect(report.outcome).toBe("blocked");
    expect(report.connection.connector).toBeUndefined();
    expect(report.log.join("\n")).toMatch(/could not write connector code: The documentation never says/);
  });

  it("leaves a connection alone when there is no sandbox to run code in", async () => {
    const { transport, entry, connection } = await setUp(sessionly);
    const opId = connection.ops.find((op) => op.path === "/tickets")!.id;
    const llm = fakeLlm([{ args: proposalOf(sessionly) }]);
    const report = await integrate(
      connection,
      { targets: [opId], entry, docsUrl: sessionly.docsUrl },
      { http: transport.http, resolveSecret: async () => null, fetchDocument: transport.fetchDocument, now: () => NOW, llm },
    );
    expect(report.outcome).toBe("blocked");
    expect(report.blocked).toMatch(/signing in for a session token/i);
    expect(llm.calls).toHaveLength(0);
  });
});
