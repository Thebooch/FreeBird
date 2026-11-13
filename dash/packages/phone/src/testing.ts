import assert from "node:assert/strict";
import { E164, PHONE_DELIVERY_STATUSES, type BrandProfile, type CampaignDraft, type SubmissionRef } from "@freebirdai/dash-spec";
import { PhoneKeysError, RepeatSendError, type OpenPhoneProvider, type PhoneKeys, type RawRequest } from "./contract.js";

/**
 * The provider contract as one set of cases, for every adapter to pass
 * unchanged: the fake carrier, Twilio, Telnyx and whatever comes next. Each
 * adapter's tests give a `ContractAccount` (a pretend account in that
 * provider's own shapes) and run every case:
 *
 * ```ts
 * for (const one of providerContractCases(harness)) it(one.name, one.run);
 * ```
 *
 * The cases use `node:assert`, so they need no test runner of their own. A
 * case for a capability the provider does not declare is not given.
 */

export interface ContractAccount {
  readonly open: OpenPhoneProvider;
  /** Keys the account takes. */
  readonly keys: PhoneKeys;
  /** Keys it refuses, which must also fail a webhook's check. */
  readonly badKeys: PhoneKeys;
  /** A number already in the account, which can text and take calls. */
  readonly number: string;
  /** A three-digit area code to search; found numbers start with +1 and it. */
  readonly areaCode: string;
  /** How many texts the provider really made. */
  sends(): number;
  /** Someone texts `to`: the provider's signed webhook, to `url`. */
  inbound(text: { readonly from: string; readonly to: string; readonly body: string }, url: string): RawRequest;
  /** The provider's signed status webhook for a message it sent. */
  status(providerId: string, outcome: { readonly status: "delivered" } | { readonly status: "failed"; readonly errorCode: string }, url: string): RawRequest;
  /** The registry decides a submission. */
  settle?(ref: SubmissionRef, state: "approved" | "rejected"): void | Promise<void>;
  /** The media layer's SIP address, as LiveKit gives it. */
  readonly sipUri?: string;
}

export interface ContractHarness {
  readonly name: string;
  /** A fresh account for each case. */
  account(): ContractAccount | Promise<ContractAccount>;
}

export interface ContractCase {
  readonly name: string;
  run(): Promise<void>;
}

const HOOK = "https://dash.example/api/public/local/phone/line-1";
const CUSTOMER = "+15550100299";

export const CONTRACT_BRAND: BrandProfile = {
  legalName: "Acme Plumbing LLC",
  businessType: "llc",
  ein: "12-3456789",
  address: { street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", country: "US" },
  website: "https://acme.example",
  industry: "Plumbing",
  contact: { name: "Ann Owner", title: "Owner", email: "ann@acme.example", phone: "+15550100999" },
};

export const CONTRACT_CAMPAIGN: CampaignDraft = {
  use: "ACCOUNT_NOTIFICATION",
  description: "Appointment reminders and confirmations for Acme Plumbing's customers.",
  samples: ["Acme Plumbing: your visit is tomorrow at 9. Reply STOP to opt out.", "Acme Plumbing: your plumber is on the way."],
  frequency: "A reminder before each appointment",
  optIn: { methods: ["booking_page"], description: "People tick a box on Acme's booking page to get texts about their visit.", pageUrl: "https://acme.example/texts" },
  privacyUrl: "https://acme.example/privacy",
  containsLinks: false,
  containsPhoneNumbers: false,
};

const rejects = async (run: () => Promise<unknown>, kind: abstract new (...args: never[]) => Error, what: string): Promise<void> => {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof kind, `${what}: expected ${kind.name}, got ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`);
};

export const providerContractCases = (harness: ContractHarness): ContractCase[] => {
  const cases: ContractCase[] = [];
  const add = (name: string, run: (account: ContractAccount) => Promise<void>) => cases.push({ name: `${harness.name}: ${name}`, run: async () => run(await harness.account()) });

  add("declares capabilities that match its adapters, and works opened with no keys for what takes keys itself", async (a) => {
    const bare = a.open({});
    assert.equal(bare.text !== undefined, bare.capabilities.text, "text adapter present exactly when it says it texts");
    assert.equal(bare.voice !== undefined, bare.capabilities.voice === "sip", "voice adapter present exactly when it says it has SIP calls");
    assert.equal(bare.registration !== undefined, bare.capabilities.registration !== "none", "registration adapter present exactly when it says it registers");
    assert.ok(bare.id && bare.title && bare.credentials.length > 0, "an id, a title and what a person pastes");
    for (const field of bare.credentials) assert.ok(a.keys[field.key] !== undefined, `the account's keys fill "${field.key}"`);
  });

  add("verify names the account and refuses keys the provider refuses", async (a) => {
    const info = await a.open({}).verify(a.keys);
    assert.equal(typeof info.name, "string");
    assert.equal(typeof info.trial, "boolean");
    await rejects(() => a.open({}).verify(a.badKeys), PhoneKeysError, "verify with refused keys");
  });

  add("numbers: lists what the account has, and refuses refused keys", async (a) => {
    const owned = await a.open(a.keys).numbers.list();
    assert.ok(owned.some((one) => one.number === a.number), `${a.number} is listed`);
    for (const one of owned) assert.match(one.number, E164);
    await rejects(() => a.open(a.badKeys).numbers.list(), PhoneKeysError, "list with refused keys");
  });

  cases.push({
    name: `${harness.name}: numbers: searches by area code, buys, routes texts and releases`,
    run: async () => {
      const a = await harness.account();
      const provider = a.open(a.keys);
      if (!provider.capabilities.text) return;
      const found = await provider.numbers.search({ areaCode: a.areaCode });
      assert.ok(found.length > 0, "something to buy");
      for (const one of found) assert.ok(one.number.startsWith(`+1${a.areaCode}`), `${one.number} is in area code ${a.areaCode}`);
      const bought = await provider.numbers.buy(found[0]!.number);
      assert.equal(bought.number, found[0]!.number);
      assert.ok((await provider.numbers.list()).some((one) => one.number === bought.number), "a bought number is listed");
      await provider.numbers.route(bought.number, { textWebhook: new URL(`${HOOK}/text`) });
      await provider.numbers.release(bought.number);
      assert.ok(!(await provider.numbers.list()).some((one) => one.number === bought.number), "a released number is gone");
    },
  });

  cases.push({
    name: `${harness.name}: texts: a send gives an id and a Dash status, and the same key is never sent twice`,
    run: async () => {
      const a = await harness.account();
      const text = a.open(a.keys).text;
      if (!text) return;
      const sent = await text.send({ from: a.number, to: CUSTOMER, body: "Acme: see you at 9.", key: "contract-k1" });
      assert.ok(sent.providerId, "a provider id");
      assert.ok((PHONE_DELIVERY_STATUSES as readonly string[]).includes(sent.status), `"${sent.status}" is one of Dash's statuses`);
      await rejects(() => a.open(a.keys).text!.send({ from: a.number, to: CUSTOMER, body: "Acme: see you at 9.", key: "contract-k1" }), RepeatSendError, "a repeated key");
      assert.equal(a.sends(), 1, "the provider made one text");
      await text.send({ from: a.number, to: CUSTOMER, body: "Acme: running late.", key: "contract-k2" });
      assert.equal(a.sends(), 2, "another key is another text");
    },
  });

  cases.push({
    name: `${harness.name}: webhooks: a signed inbound text verifies and parses; a changed body, other keys or no signature does not verify`,
    run: async () => {
      const a = await harness.account();
      const text = a.open({}).text;
      if (!text) return;
      const raw = a.inbound({ from: CUSTOMER, to: a.number, body: "Yes, 9 works" }, `${HOOK}/text`);
      assert.equal(text.verify(raw, a.keys), true, "the provider's own signature verifies");
      assert.equal(text.verify({ ...raw, body: raw.body.replace("9 works", "10 works") }, a.keys), false, "a changed body does not");
      assert.equal(text.verify(raw, a.badKeys), false, "other keys do not");
      const unsigned = { ...raw, headers: Object.fromEntries(Object.entries(raw.headers).filter(([name]) => name === "content-type")) };
      assert.equal(text.verify(unsigned, a.keys), false, "no signature does not");
      const parsed = text.parseInbound(raw);
      assert.equal(parsed.from, CUSTOMER);
      assert.equal(parsed.to, a.number);
      assert.equal(parsed.body, "Yes, 9 works");
      assert.ok(parsed.providerId && !Number.isNaN(Date.parse(parsed.at)), "an id and when");
    },
  });

  cases.push({
    name: `${harness.name}: webhooks: delivery statuses parse as delivered, and failed with the provider's code`,
    run: async () => {
      const a = await harness.account();
      const text = a.open(a.keys).text;
      if (!text) return;
      const sent = await text.send({ from: a.number, to: CUSTOMER, body: "Acme: see you at 9.", key: "contract-status" });
      const delivered = a.status(sent.providerId, { status: "delivered" }, `${HOOK}/status`);
      assert.equal(text.verify(delivered, a.keys), true);
      assert.deepEqual(text.parseStatus(delivered), { providerId: sent.providerId, status: "delivered" });
      const failed = a.status(sent.providerId, { status: "failed", errorCode: "30003" }, `${HOOK}/status`);
      assert.equal(text.verify(failed, a.keys), true);
      assert.deepEqual(text.parseStatus(failed), { providerId: sent.providerId, status: "failed", errorCode: "30003" });
    },
  });

  cases.push({
    name: `${harness.name}: calls: connectTrunk points the numbers at the media layer with a dial-out credential; disconnectTrunk undoes it`,
    run: async () => {
      const a = await harness.account();
      const voice = a.open(a.keys).voice;
      if (!voice) return;
      const sipUri = a.sipUri ?? "sip:dash-test.sip.livekit.cloud";
      const trunk = await voice.connectTrunk({ sipUri, numbers: [a.number] });
      assert.ok(trunk.id);
      assert.equal(trunk.sipUri, sipUri);
      assert.deepEqual(trunk.numbers, [a.number]);
      if (trunk.termination) assert.ok(trunk.termination.address && trunk.termination.username && trunk.termination.password, "a whole dial-out credential");
      await voice.disconnectTrunk(trunk.id);
    },
  });

  cases.push({
    name: `${harness.name}: registration: brand, use cases, campaign, numbers, status and explain`,
    run: async () => {
      const a = await harness.account();
      const registration = a.open(a.keys).registration;
      if (!registration) return;
      assert.ok(a.settle, "a harness for a registering provider can settle submissions");
      const brand = await registration.submitBrand(CONTRACT_BRAND);
      assert.equal(brand.kind, "brand");
      assert.equal((await registration.status(brand)).state, "pending");
      await a.settle(brand, "approved");
      assert.equal((await registration.status(brand)).state, "approved");
      const uses = await registration.useCases(brand);
      assert.ok(uses.some((one) => one.id === CONTRACT_CAMPAIGN.use), `${CONTRACT_CAMPAIGN.use} is offered`);
      const campaign = await registration.submitCampaign(brand, CONTRACT_CAMPAIGN);
      assert.equal(campaign.kind, "campaign");
      await a.settle(campaign, "approved");
      assert.equal((await registration.status(campaign)).state, "approved");
      await a.open(a.keys).numbers.route(a.number, { textWebhook: new URL(`${HOOK}/text`) });
      await registration.attachNumbers(campaign, [a.number]);
      const second = await registration.submitBrand({ ...CONTRACT_BRAND, legalName: "Acme Drains LLC" });
      await a.settle(second, "rejected");
      const rejected = await registration.status(second);
      assert.equal(rejected.state, "rejected");
      assert.ok(rejected.codes.length > 0, "a rejection carries a code");
      const help = registration.explain(rejected.codes[0]!.code);
      assert.equal(help.code, rejected.codes[0]!.code);
      assert.ok(help.sentence.length > 10, "a plain sentence");
    },
  });

  return cases;
};
