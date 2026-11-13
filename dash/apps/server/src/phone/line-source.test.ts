import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { PhoneLineView } from "@freebirdai/dash-spec";
import { FakeCarrier, type RegistrationAdapter } from "@freebirdai/phone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAgentStore } from "../agents/store.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { agentOf } from "../workflows/testing.js";
import type { PhoneLineSource, ProvidedLineRef } from "./line-source.js";
import { PhoneLines } from "./lines.js";
import { PhoneOutreach } from "./outreach.js";
import { MemoryRegistrationStore, RegistrationService } from "./registration.js";
import { MemoryPhoneTextStore } from "./texts.js";
import { MemoryPhoneUsageStore } from "./usage.js";
import type { PhoneUsageEvent } from "./usage-events.js";

/*
 * Lines a server's host provides, through the generic seams: a fake line
 * source over a fake carrier account that is the host's, not the
 * workspace's. The default build offers none.
 */

const HOST_SECRET = "the-hosts-own-secret";
const CUSTOMER = "+15550100200";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-line-source-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A host's line source over its own fake carrier account, recording what Dash asks of it. */
const fakeSource = (host: FakeCarrier, registration?: RegistrationAdapter) => {
  const asked: string[] = [];
  const released: ProvidedLineRef[] = [];
  const held = new Map<string, string>();
  const source: PhoneLineSource = {
    offers: async (workspace) => (asked.push(`offers ${workspace}`), [{ id: "provided", title: "A number from this server", description: "Bought, wired and registered for you.", areaCode: true }]),
    provision: async ({ workspace, offer, areaCode }) => {
      asked.push(`provision ${workspace} ${offer} ${areaCode ?? ""}`);
      const account = host.open({ secret: HOST_SECRET });
      const [first] = await account.numbers.search(areaCode ? { areaCode } : {});
      const bought = await account.numbers.buy(first!.number);
      return { provider: "fake", number: bought.number, ref: `host-${bought.providerId}` };
    },
    keys: (line) => (asked.push(`keys ${line.ref}`), { secret: HOST_SECRET }),
    ...(registration ? { registration: () => registration } : {}),
    suspended: async (line) => (held.has(line.ref) ? { reason: held.get(line.ref)! } : null),
    release: async (line) => void released.push(line),
  };
  return { source, asked, released, held };
};

const server = (name: string, extra: Partial<Parameters<typeof buildServer>[0]> = {}) => {
  const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, name, "vault.json"));
  let app: ReturnType<typeof buildServer>;
  app = buildServer({
    store,
    keys,
    llm: null,
    agents: new MemoryAgentStore(),
    publicOrigin: "https://dash.example",
    phoneProbe: async (url) => {
      const answer = await app.inject({ method: "GET", url: new URL(url).pathname + new URL(url).search });
      return { status: answer.statusCode, text: answer.body };
    },
    ...extra,
  });
  return { app, keys };
};

describe("lines a host provides, over HTTP", () => {
  it("the default build offers none: bring-your-own only, and no way to ask for a provided line", async () => {
    const { app } = server("default");
    try {
      const listed = (await app.inject({ method: "GET", url: "/api/comms/lines" })).json() as { offers: unknown[]; accounts: Array<{ id: string }> };
      expect(listed.offers).toEqual([]);
      expect(listed.accounts.map((one) => one.id).sort()).toEqual(["sip", "telnyx", "twilio"]);
      const asked = await app.inject({ method: "POST", url: "/api/comms/lines/provided", payload: { offer: "provided" } });
      expect(asked.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("offers, provides with the host's keys (never in the vault), reports use, suspends, and gives the number back on removal", async () => {
    const host = new FakeCarrier({ secret: HOST_SECRET });
    const { source, asked, released, held } = fakeSource(host);
    const events: PhoneUsageEvent[] = [];
    const { app, keys } = server("provided", { phoneProviders: { fake: host.open }, phoneLineSource: source, phoneUsageEvents: { record: (event) => void events.push(event) } });
    try {
      const listed = (await app.inject({ method: "GET", url: "/api/comms/lines" })).json() as { offers: Array<{ id: string; title: string }> };
      expect(listed.offers).toEqual([expect.objectContaining({ id: "provided", title: "A number from this server" })]);
      const made = await app.inject({ method: "POST", url: "/api/comms/lines/provided", payload: { offer: "provided", areaCode: "415", owner: { kind: "team" } } });
      expect(made.statusCode).toBe(200);
      const line = (made.json() as { line: PhoneLineView }).line;
      expect(line).toMatchObject({ provided: true, text: "needs_registration", number: expect.stringMatching(/^\+1415/) });
      expect(asked).toContain("provision local provided 415");
      /* Its texts point at the line, through the host's account; nothing of the host's is in the vault. */
      expect(host.routes.get(line.number!)?.textWebhook).toBe(`https://dash.example/api/public/local/phone/${line.id}/text`);
      expect(keys.get(`phone-${line.id}-secret`)).toBeNull();

      /* An inbound text, verified with the host's keys, reported once however often it arrives. */
      const hook = `https://dash.example/api/public/local/phone/${line.id}/text`;
      const raw = host.inboundText({ from: CUSTOMER, to: line.number!, body: "Hello?" }, hook);
      for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: new URL(hook).pathname, headers: raw.headers as Record<string, string>, payload: raw.body })).statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.map((one) => [one.kind, one.quantity, one.provided, one.workspace, one.provider])).toEqual([
        ["number_held", 1, true, "local", "fake"],
        ["text_received", 1, true, "local", "fake"],
      ]);

      /* Suspended by a person here, then by the host through the seam. */
      const suspended = (await app.inject({ method: "PUT", url: `/api/comms/lines/${line.id}/suspended`, payload: { suspended: true, reason: "Checking a complaint" } })).json() as PhoneLineView;
      expect(suspended.suspended).toEqual({ by: "person", reason: "Checking a complaint" });
      const resumed = (await app.inject({ method: "PUT", url: `/api/comms/lines/${line.id}/suspended`, payload: { suspended: false } })).json() as PhoneLineView;
      expect(resumed.suspended).toBeUndefined();
      held.set(`host-${host.owned[0]!.providerId}`, "Unpaid balance");
      const again = ((await app.inject({ method: "GET", url: "/api/comms/lines" })).json() as { lines: PhoneLineView[] }).lines.find((one) => one.id === line.id)!;
      expect(again.suspended).toEqual({ by: "host", reason: "Unpaid balance" });

      /* Removed: the number goes back to the host. */
      expect((await app.inject({ method: "DELETE", url: `/api/comms/lines/${line.id}` })).statusCode).toBe(200);
      expect(released).toEqual([{ workspace: "local", line: line.id, ref: `host-${host.owned[0]!.providerId}` }]);
      expect(events.at(-1)).toMatchObject({ kind: "number_released", line: line.id, provided: true });
    } finally {
      await app.close();
    }
  });
});

describe("lines a host provides, through the services", () => {
  const T0 = Date.parse("2026-11-13T12:00:00Z");

  const setUp = async (name: string) => {
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 8)), join(dir, name, "vault.json"));
    const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
    const host = new FakeCarrier({ secret: HOST_SECRET, now: () => T0 });
    /* The host registers its lines its own way: a registration adapter of its own, recording each call, over the same account. */
    const own = host.open({ secret: HOST_SECRET }).registration!;
    const used: string[] = [];
    const registration: RegistrationAdapter = {
      submitBrand: async (p) => (used.push("submitBrand"), own.submitBrand(p)),
      useCases: async (b) => (used.push("useCases"), own.useCases(b)),
      submitCampaign: async (b, c) => (used.push("submitCampaign"), own.submitCampaign(b, c)),
      attachNumbers: async (c, n) => (used.push("attachNumbers"), own.attachNumbers(c, n)),
      status: async (r) => (used.push("status"), own.status(r)),
      explain: (code) => own.explain(code),
    };
    const { source, held } = fakeSource(host, registration);
    const events: PhoneUsageEvent[] = [];
    const usage = new MemoryPhoneUsageStore();
    const lines = new PhoneLines({
      connections: { list: () => store.listConnections(), get: (id) => store.getConnection(id), put: (spec) => store.putConnection(spec), remove: async (id) => store.deleteConnection(id) },
      keys,
      providers: { fake: host.open },
      usage,
      policy: { can: () => ({ ok: true }) },
      agents: { get: async () => agentOf() },
      now: () => T0,
      workspace: "acme",
      source,
      report: (use) => void events.push({ workspace: "acme", ...use }),
    });
    const made = await source.provision({ workspace: "acme", offer: "provided" });
    const line = await lines.createProvided({ offer: "provided", ...made, owner: { kind: "agent", id: "desk" } });
    const outreach = new PhoneOutreach({
      lines: () => lines.all(),
      providers: { fake: host.open },
      keysFor: (one) => lines.keysFor(one),
      usage,
      agents: { get: async () => agentOf({ id: "desk" }) },
      consent: async () => ({ status: "given" }),
      texts: new MemoryPhoneTextStore(),
      now: () => T0,
      suspended: (one) => lines.suspension(one),
      report: (one, use) => lines.report(one, use),
    });
    const service = new RegistrationService({
      store: new MemoryRegistrationStore(),
      keys,
      lines,
      providers: { fake: host.open },
      scan: async (url) => ({ url, reachable: true, https: true, showsName: true, noSharing: true, checkedByDefault: false, consentWithTerms: false, prohibited: [] }),
      sources: async () => [],
      llm: () => null,
      hostedPages: () => ({ pageUrl: "https://dash.example/p/local/texts", privacyUrl: "https://dash.example/p/local/texts/privacy", termsUrl: "https://dash.example/p/local/texts/terms" }),
      notify: async () => undefined,
      now: () => T0,
    });
    return { host, lines, line, outreach, service, used, events, held, keys };
  };

  it("registers through the host's registration adapter, not the provider's, and reports each submission", async () => {
    const { service, line, used, events, host } = await setUp("register");
    await service.save(line.id, {
      business: { legalName: "Acme Plumbing LLC", businessType: "llc", street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", website: "https://acmeplumbing.example", industry: "Home services" },
      contact: { name: "Ann Owner", title: "Owner", email: "ann@acmeplumbing.example", phone: "+15550100999" },
      campaign: { use: "ACCOUNT_NOTIFICATION", description: "Appointment reminders for people who booked a visit.", samples: ["Acme Plumbing: your visit is tomorrow at [time]. Reply STOP to opt out.", "Your plumber is on the way."], frequency: "One or two texts per visit", containsLinks: false, containsPhoneNumbers: false },
      optIn: { methods: ["booking_page"], description: "An unticked box on the booking page." },
    });
    await service.setEin(line.id, "12-3456789");
    await service.save(line.id, { confirmed: { legalName: true, ein: true } });
    const submitted = await service.submit(line.id);
    expect(used).toEqual(["submitBrand"]);
    host.settleRegistration(submitted.submitted.brand!.id, "approved");
    await service.poll(line.id);
    expect(used).toEqual(["submitBrand", "status", "useCases", "submitCampaign"]);
    expect(events.filter((one) => one.kind === "registration_submitted").map((one) => one.key)).toEqual([`registration:${line.id}:brand:${submitted.submitted.brand!.id}`, expect.stringMatching(new RegExp(`^registration:${line.id}:campaign:`))]);
  });

  it("sends with the host's keys, reports each text once by its key, and sends nothing while the host has it suspended", async () => {
    const { lines, line, outreach, events, held, host } = await setUp("send");
    await lines.setTextStatus(line.id, "approved");
    const message = { channel: "text" as const, to: CUSTOMER, text: "Acme: see you at 9.", key: "k-1", agent: { id: "desk", name: "Front desk" } };
    expect((await outreach.send(message as never)).status).toBe("queued");
    expect((await outreach.send(message as never)).detail).toMatch(/not sent again/);
    expect(host.sent).toHaveLength(1);
    expect(events.filter((one) => one.kind === "text_sent")).toEqual([expect.objectContaining({ workspace: "acme", line: line.id, provider: "fake", quantity: 1, key: `text:${line.id}:k-1`, provided: true })]);
    held.set(line.phone.source!.ref, "Carrier complaint");
    const refused = await outreach.send({ ...message, key: "k-2" } as never);
    expect(refused).toEqual({ status: "not_sent", detail: "This line is suspended (Carrier complaint), so nothing was sent." });
    expect(host.sent).toHaveLength(1);
  });

  it("a person's suspension stops calls too, and keeps no secret for a provided line", async () => {
    const { lines, line, outreach, keys } = await setUp("suspend");
    await lines.setSuspended(line.id, true);
    const refused = await outreach.send({ channel: "call", to: CUSTOMER, text: "Confirm the visit", key: "c-1", agent: { id: "desk", name: "Front desk" } } as never);
    expect(refused).toEqual({ status: "not_sent", detail: "This line is suspended, so nobody was called." });
    expect(keys.get(`phone-${line.id}-secret`)).toBeNull();
    expect(lines.keysFor(lines.get(line.id)!)).toEqual({ secret: HOST_SECRET });
  });
});
