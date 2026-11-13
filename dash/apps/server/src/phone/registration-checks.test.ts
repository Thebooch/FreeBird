import { registrationDraftSchema, type PolicyScan, type RegistrationDraft } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { pageWords, scanPolicy, shortName } from "./policy-scan.js";
import { REGISTRATION_RULES, checkDraft, type RegistrationScans } from "./registration-checks.js";

/*
 * Every pre-submit rule has its own test: a draft that passes all of them,
 * then for each rule the one change that makes exactly that rule fail.
 * `REGRESSIONS` below are drafts written the way real ones go wrong, each
 * pinned to the rules it must trip.
 */

const scan = (fields: Partial<PolicyScan> = {}): PolicyScan => ({ url: "https://acmeplumbing.example", reachable: true, https: true, showsName: true, noSharing: true, checkedByDefault: false, consentWithTerms: false, prohibited: [], ...fields });
const SCANS: RegistrationScans = { website: scan() };

const good = (): RegistrationDraft =>
  registrationDraftSchema.parse({
    line: "line-1",
    updatedAt: "2026-11-13T00:00:00.000Z",
    business: { legalName: "Acme Plumbing LLC", businessType: "llc", ein: { sealed: "x", last4: "6789" }, street: "1 Main St", city: "Springfield", region: "IL", postalCode: "62701", website: "https://acmeplumbing.example", industry: "Home services" },
    contact: { name: "Ann Owner", title: "Owner", email: "ann@acmeplumbing.example", phone: "+15550100999" },
    campaign: {
      use: "ACCOUNT_NOTIFICATION",
      description: "Appointment reminders and confirmations for customers who booked a plumbing visit.",
      samples: ["Acme Plumbing: your visit is tomorrow at [time]. Reply STOP to opt out.", "Hi [first name], your plumber is on the way."],
      frequency: "One or two texts per appointment",
      containsLinks: false,
      containsPhoneNumbers: false,
    },
    optIn: { methods: ["booking_page"], description: "Customers tick an unticked box on the booking page.", hosted: true },
    confirmed: { legalName: true, ein: true },
  });

const failing = (draft: RegistrationDraft, scans: RegistrationScans = SCANS) => checkDraft(draft, scans).map((one) => one.rule);

/** One change per rule, and the rule it trips. */
const ONE_CHANGE: Record<string, (draft: RegistrationDraft) => { draft: RegistrationDraft; scans?: RegistrationScans }> = {
  "brand-in-sample": (d) => ({ draft: { ...d, campaign: { ...d.campaign, samples: ["Your visit is tomorrow. Reply STOP to opt out.", "Your plumber is on the way."] } } }),
  "opt-out-in-sample": (d) => ({ draft: { ...d, campaign: { ...d.campaign, samples: ["Acme Plumbing: your visit is tomorrow.", "Your plumber is on the way."] } } }),
  "samples-fit-use": (d) => ({ draft: { ...d, campaign: { ...d.campaign, samples: [...d.campaign.samples, "Acme Plumbing: 20% off drain cleaning this week!"] } } }),
  "no-shorteners": (d) => ({ draft: { ...d, campaign: { ...d.campaign, containsLinks: true, samples: [...d.campaign.samples, "Acme Plumbing: reschedule at bit.ly/acme"] } } }),
  "links-answer-matches": (d) => ({ draft: { ...d, campaign: { ...d.campaign, samples: [...d.campaign.samples, "Acme Plumbing: see https://acmeplumbing.example/visit"] } } }),
  "phones-answer-matches": (d) => ({ draft: { ...d, campaign: { ...d.campaign, samples: [...d.campaign.samples, "Acme Plumbing: call us at (555) 010-0999"] } } }),
  "website-https-and-name": (d) => ({ draft: d, scans: { website: scan({ showsName: false }) } }),
  "privacy-no-sharing": (d) => ({ draft: { ...d, optIn: { ...d.optIn, hosted: false, privacyUrl: "https://acmeplumbing.example/privacy" } }, scans: { ...SCANS, privacy: scan({ noSharing: false }), optIn: scan() } }),
  "opt-in-box": (d) => ({ draft: { ...d, optIn: { ...d.optIn, hosted: false, pageUrl: "https://acmeplumbing.example/texts" } }, scans: { ...SCANS, privacy: scan(), optIn: scan({ checkedByDefault: true }) } }),
  "no-prohibited-content": (d) => ({ draft: d, scans: { website: scan({ prohibited: ["cbd"] }) } }),
  "required-filled": (d) => ({ draft: { ...d, campaign: { ...d.campaign, frequency: "" } } }),
  "legal-name-ein-confirmed": (d) => ({ draft: { ...d, confirmed: { legalName: true, ein: false } } }),
};

describe("the pre-submit checks", () => {
  it("pass a draft that is ready", () => {
    expect(checkDraft(good(), SCANS)).toEqual([]);
  });

  it("cover every rule in the plan's list, each with its own failing case", () => {
    expect(REGISTRATION_RULES.map((one) => one.check.id).sort()).toEqual(Object.keys(ONE_CHANGE).sort());
  });

  for (const one of REGISTRATION_RULES) {
    it(`${one.check.id}: ${one.check.says}`, () => {
      const changed = ONE_CHANGE[one.check.id]!(good());
      const problems = checkDraft(changed.draft, changed.scans ?? SCANS);
      expect(problems.map((problem) => problem.rule)).toEqual([one.check.id]);
      /* A missing field sends a person to that field's own step. */
      expect(problems[0]).toMatchObject({ step: one.check.id === "required-filled" ? "campaign" : one.step });
    });
  }

  it("names the missing fields, and sends a person to the first", () => {
    const d = good();
    const [problem] = checkDraft({ ...d, contact: { ...d.contact, email: "" }, campaign: { ...d.campaign, frequency: "" } }, SCANS);
    expect(problem).toMatchObject({ rule: "required-filled", step: "contact", field: "contactEmail" });
    expect(problem!.says).toContain("contactEmail, frequency");
  });

  it("lets a sole proprietor go without an EIN, and no one else", () => {
    const d = good();
    const { ein: _ein, ...business } = d.business;
    expect(failing({ ...d, business: { ...business, businessType: "sole_proprietor" }, confirmed: { legalName: true, ein: false } })).toEqual([]);
    expect(failing({ ...d, business: { ...business }, confirmed: { legalName: true, ein: false } })).toEqual(["required-filled", "legal-name-ein-confirmed"]);
  });

  it("allows offers under Marketing", () => {
    const changed = ONE_CHANGE["samples-fit-use"]!(good()).draft;
    expect(failing({ ...changed, campaign: { ...changed.campaign, use: "MARKETING" } })).toEqual([]);
  });
});

/** Drafts written the way real ones go wrong, and the rules each must trip. */
const REGRESSIONS: ReadonlyArray<{ readonly name: string; readonly make: (d: RegistrationDraft) => RegistrationDraft; readonly scans?: RegistrationScans; readonly trips: readonly string[] }> = [
  {
    name: "generic samples with no name, no opt-out and a shortened link",
    make: (d) => ({ ...d, campaign: { ...d.campaign, containsLinks: false, samples: ["Reminder: your appointment is tomorrow.", "Book again: bit.ly/xyz"] } }),
    trips: ["brand-in-sample", "opt-out-in-sample", "no-shorteners", "links-answer-matches"],
  },
  {
    name: "a website on http that names another business",
    make: (d) => ({ ...d, business: { ...d.business, website: "http://acmeplumbing.example" } }),
    scans: { website: scan({ https: false, showsName: false }) },
    trips: ["website-https-and-name"],
  },
  {
    name: "the business's own page: consent pre-ticked inside the terms box, no sharing clause",
    make: (d) => ({ ...d, optIn: { ...d.optIn, hosted: false, pageUrl: "https://acmeplumbing.example/signup", privacyUrl: "https://acmeplumbing.example/privacy" } }),
    scans: { website: scan(), optIn: scan({ checkedByDefault: true, consentWithTerms: true }), privacy: scan({ noSharing: false }) },
    trips: ["privacy-no-sharing", "opt-in-box"],
  },
  {
    name: "submitted before the review screen",
    make: (d) => ({ ...d, confirmed: { legalName: false, ein: false } }),
    trips: ["legal-name-ein-confirmed"],
  },
];

describe("regression scenarios", () => {
  for (const one of REGRESSIONS) {
    it(one.name, () => {
      expect(failing(one.make(good()), one.scans ?? SCANS).sort()).toEqual([...one.trips].sort());
    });
  }
});

describe("reading a business's own pages", () => {
  const page = (html: string) => async () => ({ status: 200, text: html });

  it("finds the name, the no-sharing clause and prohibited words in the visible text only", async () => {
    const found = await scanPolicy("https://acmeplumbing.example/privacy", {
      legalName: "Acme Plumbing, LLC",
      fetch: page("<html><script>var cbd = 1</script><h1>Acme Plumbing</h1><p>Mobile numbers will not be shared with third parties.</p></html>"),
    });
    expect(found).toMatchObject({ reachable: true, https: true, showsName: true, noSharing: true, prohibited: [] });
    expect((await scanPolicy("http://x.example", { legalName: "Acme", fetch: page("<p>We sell CBD gummies.</p>") })).prohibited).toEqual(["cbd"]);
  });

  it("finds an opt-in box ticked before anyone ticks it, or one box for texts and terms", async () => {
    const ticked = await scanPolicy("https://a.example/texts", { legalName: "Acme", fetch: page('<label><input type="checkbox" name="sms" checked> Text me reminders</label>') });
    expect(ticked.checkedByDefault).toBe(true);
    const combined = await scanPolicy("https://a.example/texts", { legalName: "Acme", fetch: page('<label><input type="checkbox"> I agree to the Terms and to receive text messages</label>') });
    expect(combined).toMatchObject({ checkedByDefault: false, consentWithTerms: true });
    const apart = await scanPolicy("https://a.example/texts", { legalName: "Acme", fetch: page('<label><input type="checkbox"> Text me about my booking</label><label><input type="checkbox"> I accept the terms</label>') });
    expect(apart).toMatchObject({ checkedByDefault: false, consentWithTerms: false });
  });

  it("says when a page cannot be read", async () => {
    expect(await scanPolicy("https://a.example", { legalName: "Acme", fetch: async () => ({ status: 404, text: "" }) })).toMatchObject({ reachable: false, problem: expect.stringContaining("404") });
    expect((await scanPolicy("https://a.example", { legalName: "Acme", fetch: async () => Promise.reject(new Error("blocked")) })).problem).toContain("blocked");
  });

  it("reads a legal name without its suffix", () => {
    expect(shortName("Acme Plumbing, L.L.C.")).toBe("acme plumbing");
    expect(pageWords("<p>a&nbsp;b</p><style>x{}</style>")).toBe("a b");
  });
});
