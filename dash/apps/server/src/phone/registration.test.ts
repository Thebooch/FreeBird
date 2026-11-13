import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { PolicyScan, TimelineEvent } from "@freebirdai/dash-spec";
import { FAKE_SECRET, FakeCarrier } from "@freebirdai/phone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpecStore } from "../store.js";
import { agentOf } from "../workflows/testing.js";
import { PhoneLines } from "./lines.js";
import { MemoryRegistrationStore, RegistrationError, RegistrationService, STANDARD_USES, finishSamples, suggestUses, type DraftSource } from "./registration.js";
import { MemoryPhoneUsageStore } from "./usage.js";

/*
 * The text registration service over the fake carrier: the draft and its
 * autosave, the EIN sealed in the vault, the drafted use, the checks before
 * submitting, and the timeline as the registry answers.
 */

const T0 = Date.parse("2026-11-13T12:00:00.000Z");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-registration-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const scripted = (text: string): LlmAdapter => ({ defaultModel: "scripted", generate: async () => ({ text, toolCalls: [] }), stream: async function* () {} });

const setUp = async (name: string, options: { sources?: DraftSource[]; llm?: LlmAdapter | null } = {}) => {
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 5)), join(dir, name, "vault.json"));
  const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
  const carrier = new FakeCarrier({ now: () => T0, numbers: ["+15550100100"] });
  const lines = new PhoneLines({
    connections: { list: () => store.listConnections(), get: (id) => store.getConnection(id), put: (spec) => store.putConnection(spec), remove: async (id) => store.deleteConnection(id) },
    keys,
    providers: { fake: carrier.open },
    usage: new MemoryPhoneUsageStore(),
    policy: { can: () => ({ ok: true }) },
    agents: { get: async () => agentOf() },
    now: () => T0,
  });
  const line = await lines.create({ provider: "fake", number: "+15550100100", keys: { secret: FAKE_SECRET } });
  /* A real line starts unregistered; the fake one is pretend-approved, so set it back. */
  await lines.setTextStatus(line.id, "needs_registration");
  const sent: Array<{ event: TimelineEvent; detail: string }> = [];
  const scan = async (url: string): Promise<PolicyScan> => ({ url, reachable: true, https: true, showsName: true, noSharing: true, checkedByDefault: false, consentWithTerms: false, prohibited: [] });
  const service = new RegistrationService({
    store: new MemoryRegistrationStore(),
    keys,
    lines,
    providers: { fake: carrier.open },
    scan,
    sources: async () => options.sources ?? [],
    llm: () => (options.llm === undefined ? null : options.llm),
    hostedPages: () => ({ pageUrl: "https://dash.example/p/local/texts", privacyUrl: "https://dash.example/p/local/texts/privacy", termsUrl: "https://dash.example/p/local/texts/terms" }),
    notify: async (_draft, event, detail) => void sent.push({ event, detail }),
    now: () => T0,
  });
  return { service, carrier, lines, line, keys, sent };
};

/** Fills every step the way a person would. */
const fill = async (service: RegistrationService, line: string) => {
  await service.save(line, {
    business: { legalName: "Acme Plumbing LLC", businessType: "llc", street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", website: "https://acmeplumbing.example", industry: "Home services" },
    contact: { name: "Ann Owner", title: "Owner", email: "ann@acmeplumbing.example", phone: "+15550100999" },
    campaign: {
      use: "ACCOUNT_NOTIFICATION",
      description: "Appointment reminders for customers who booked a visit.",
      samples: ["Acme Plumbing: your visit is tomorrow at [time]. Reply STOP to opt out.", "Your plumber is on the way."],
      frequency: "One or two texts per visit",
      containsLinks: false,
      containsPhoneNumbers: false,
    },
    optIn: { methods: ["booking_page"], description: "An unticked box on the booking page." },
  });
  await service.setEin(line, "12-3456789");
  await service.save(line, { confirmed: { legalName: true, ein: true } });
};

describe("the draft", () => {
  it("starts with Dash's own opt-in pages, autosaves, and refuses to take the EIN with the rest", async () => {
    const { service, line } = await setUp("draft");
    expect((await service.view(line.id)).optIn.hosted).toBe(true);
    const saved = await service.save(line.id, { step: "contact", field: "name", contact: { name: "Ann" }, timeline: [{ at: "x", event: "brand_approved" }] });
    expect(saved).toMatchObject({ step: "contact", field: "name", contact: { name: "Ann" }, timeline: [] });
    await expect(service.save(line.id, { business: { ein: "123456789" } })).rejects.toBeInstanceOf(RegistrationError);
  });

  it("seals the EIN in the vault, shows it masked, and asks again for the name to be confirmed when it changes", async () => {
    const { service, line, keys } = await setUp("ein");
    await expect(service.setEin(line.id, "1234")).rejects.toThrow(/nine digits/);
    const view = await service.setEin(line.id, "12-3456789");
    expect(view.business.ein).toBe("••-•••6789");
    expect(JSON.stringify(view)).not.toContain("123456789");
    expect(JSON.stringify(await service.draft(line.id))).not.toContain("3456789");
    expect(keys.get(`phone-registration-${line.id}-ein`)).toBe("123456789");
    await service.save(line.id, { confirmed: { legalName: true, ein: true }, business: { legalName: "Acme" } });
    await service.save(line.id, { business: { legalName: "Acme Plumbing LLC" } });
    expect((await service.view(line.id)).confirmed).toEqual({ legalName: false, ein: true });
  });
});

describe("the drafted use description", () => {
  const sources: DraftSource[] = [
    { kind: "workflow", name: "Appointment reminders", words: ["Your visit is tomorrow at [time]."] },
    { kind: "workflow", name: "Missed-call follow-up", words: ["Sorry we missed you. How can we help?"] },
  ];

  it("is blank, with no model called, when nothing in the workspace texts", async () => {
    const { service, line } = await setUp("blank", { llm: scripted("never") });
    expect((await service.draftUse(line.id)).campaign.drafted).toBeUndefined();
  });

  it("is drafted from what texts, says what from, and reaches the campaign only on Use this", async () => {
    const { service, line } = await setUp("drafted", { sources, llm: scripted('{"use":"MIXED","description":"Reminders and follow-ups for customers.","samples":["Your visit is tomorrow at [time].","Sorry we missed you."]}') });
    await service.save(line.id, { business: { legalName: "Acme Plumbing" } });
    const drafted = (await service.draftUse(line.id)).campaign;
    expect(drafted.drafted).toMatchObject({ from: ["Appointment reminders", "Missed-call follow-up"], use: "MIXED", accepted: false });
    expect(drafted.drafted!.samples).toEqual(["Acme Plumbing: Your visit is tomorrow at [time].", "Sorry we missed you. Reply STOP to opt out."]);
    expect(drafted.description).toBe("");
    const used = (await service.acceptDraft(line.id, true)).campaign;
    expect(used).toMatchObject({ use: "MIXED", description: "Reminders and follow-ups for customers.", drafted: { accepted: true } });
  });

  it("says so when there is no model, rather than guessing", async () => {
    const { service, line } = await setUp("nomodel", { sources });
    await expect(service.draftUse(line.id)).rejects.toThrow(/No AI model/);
  });

  it("finishes samples with the name and opt-out wording, and leaves good ones alone", () => {
    expect(finishSamples(["Acme: hi. Reply STOP to opt out.", "b"], "Acme")).toEqual(["Acme: hi. Reply STOP to opt out.", "b"]);
  });

  it("suggests fitting uses first, with why, and notes extra vetting", () => {
    const suggested = suggestUses(STANDARD_USES, sources);
    expect(suggested.slice(0, 4).map((one) => one.id)).toEqual(["ACCOUNT_NOTIFICATION", "CUSTOMER_CARE", "MIXED", "LOW_VOLUME"]);
    expect(suggested[0]!.suggested).toBe("Suggested: matches Appointment reminders");
    expect(suggested.find((one) => one.id === "POLITICAL")).toMatchObject({ extraVetting: true });
    expect(suggestUses(STANDARD_USES, []).some((one) => one.suggested)).toBe(false);
  });
});

describe("submitting and the timeline", () => {
  it("refuses to submit with a failing check, naming each", async () => {
    const { service, line, carrier } = await setUp("refuse");
    await fill(service, line.id);
    await service.save(line.id, { confirmed: { legalName: false } });
    const error = (await service.submit(line.id).catch((caught: unknown) => caught)) as RegistrationError;
    expect(error.problems!.map((one) => one.rule)).toEqual(["legal-name-ein-confirmed"]);
    expect(carrier.submissions.size).toBe(0);
  });

  it("submits the brand, then the campaign once it is approved, then attaches the line; one email per change", async () => {
    const { service, line, carrier, lines, sent } = await setUp("flow");
    await fill(service, line.id);
    const submitted = await service.submit(line.id);
    expect(submitted.timeline.map((one) => one.event)).toEqual(["brand_submitted"]);
    expect(lines.get(line.id)!.phone.text.status).toBe("pending");
    const brand = [...carrier.submissions.values()][0]!;
    expect(brand.brand).toMatchObject({ legalName: "Acme Plumbing LLC", ein: "12-3456789" });
    await expect(service.submit(line.id)).rejects.toThrow(/already submitted/);

    expect((await service.poll(line.id)).timeline).toHaveLength(1);
    carrier.settleRegistration(brand.ref.id, "approved");
    const afterBrand = await service.poll(line.id);
    expect(afterBrand.timeline.map((one) => one.event)).toEqual(["brand_submitted", "brand_approved", "campaign_submitted"]);
    const campaign = [...carrier.submissions.values()][1]!;
    expect(campaign.campaign).toMatchObject({ use: "ACCOUNT_NOTIFICATION", optIn: { pageUrl: "https://dash.example/p/local/texts" }, privacyUrl: "https://dash.example/p/local/texts/privacy" });

    carrier.settleRegistration(campaign.ref.id, "approved");
    const done = await service.poll(line.id);
    expect(done.timeline.map((one) => one.event)).toEqual(["brand_submitted", "brand_approved", "campaign_submitted", "campaign_approved", "numbers_attached"]);
    expect(carrier.attached.get(campaign.ref.id)).toEqual(["+15550100100"]);
    expect(lines.get(line.id)!.phone.text.status).toBe("approved");
    expect(sent.map((one) => one.event)).toEqual(done.timeline.map((one) => one.event));
  });

  it("explains a rejection with the field to fix, and lets the business resubmit", async () => {
    const { service, line, carrier, lines } = await setUp("reject");
    await fill(service, line.id);
    carrier.rejectNextRegistration("30794");
    await service.submit(line.id);
    const rejected = await service.poll(line.id);
    expect(rejected.timeline.at(-1)).toMatchObject({ event: "brand_rejected", codes: ["30794"] });
    expect(rejected.submitted.codes).toEqual([{ code: "30794" }]);
    expect(lines.get(line.id)!.phone.text.status).toBe("rejected");
    expect(await service.explain(line.id, "30794")).toMatchObject({ field: "legalName" });
    await service.submit(line.id);
    expect((await service.draft(line.id)).submitted.brandState).toBe("pending");
  });

  it("waits on a use the registry does not take for this brand", async () => {
    const { service, line, carrier } = await setUp("use");
    await fill(service, line.id);
    await service.save(line.id, { campaign: { use: "NOT_A_USE" } });
    await service.submit(line.id);
    carrier.settleRegistration([...carrier.submissions.values()][0]!.ref.id, "approved");
    const after = await service.poll(line.id);
    expect(after.timeline.at(-1)).toMatchObject({ event: "campaign_rejected", codes: ["use"] });
  });

  it("polls every line waiting, and leaves the rest", async () => {
    const { service, line } = await setUp("all");
    await fill(service, line.id);
    await service.submit(line.id);
    const seen: string[] = [];
    await service.pollAll((id) => seen.push(id));
    expect(seen).toEqual([]);
  });
});

describe("the registration routes", () => {
  it("serve the draft with the EIN masked, refuse to submit a draft that fails its checks, and keep the vault's copy", async () => {
    const { buildServer } = await import("../server.js");
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 6)), join(dir, "routes", "vault.json"));
    const store = new SpecStore(join(dir, "routes", "d"), join(dir, "routes", "c"), join(dir, "routes", "r"));
    const carrier = new FakeCarrier({ numbers: ["+15550100100"] });
    const app = buildServer({ store, keys, llm: null, phoneProviders: { fake: carrier.open }, publicOrigin: "https://dash.example", fetchPolicyPage: async () => ({ status: 200, text: "<h1>Acme Plumbing</h1>" }) });
    try {
      const line = (await app.inject({ method: "POST", url: "/api/comms/lines", payload: { provider: "fake", number: "+15550100100", keys: { secret: FAKE_SECRET } } })).json() as { id: string };
      const base = `/api/comms/lines/${line.id}/registration`;
      expect((await app.inject({ method: "GET", url: base })).json()).toMatchObject({ line: line.id, step: "business", optIn: { hosted: true } });
      expect((await app.inject({ method: "POST", url: `${base}/ein`, payload: { ein: "12-3456789" } })).json()).toMatchObject({ business: { ein: "••-•••6789" } });
      await app.inject({ method: "PUT", url: base, payload: { step: "campaign", business: { legalName: "Acme Plumbing LLC" } } });
      expect((await app.inject({ method: "GET", url: base })).body).not.toContain("3456789");
      const uses = (await app.inject({ method: "GET", url: `${base}/uses` })).json() as { uses: { id: string }[] };
      expect(uses.uses.map((one) => one.id)).toContain("ACCOUNT_NOTIFICATION");
      const checked = (await app.inject({ method: "POST", url: `${base}/check` })).json() as { problems: { rule: string }[] };
      expect(checked.problems.map((one) => one.rule)).toContain("required-filled");
      const refused = await app.inject({ method: "POST", url: `${base}/submit` });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { problems: unknown[] }).problems.length).toBeGreaterThan(0);
      expect(carrier.submissions.size).toBe(0);
      expect((await app.inject({ method: "POST", url: `${base}/draft` })).json()).toMatchObject({ campaign: { description: "" } });
      expect((await app.inject({ method: "GET", url: "/api/comms/lines/nope/registration" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
