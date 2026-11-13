import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryContactStore } from "../contacts/store.js";
import { NO_SHARING_CLAUSE, optInWording } from "../phone/pages.js";
import { scanPolicy } from "../phone/policy-scan.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";

/*
 * The opt-in form, privacy section and messaging terms Dash hosts for text
 * registration, and the same form as a script for the business's own site.
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-texts-public-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const serve = (name: string) => {
  const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 8)), join(dir, name, "vault.json"));
  const contacts = new MemoryContactStore();
  const app = buildServer({ store, keys, llm: null, contacts, brand: async () => ({ name: "Acme Plumbing" }), publicOrigin: "https://dash.example", pagesOrigin: "https://pages.example" });
  return { app, contacts };
};

describe("the hosted text pages", () => {
  it("give the consent words, a privacy section with the no-sharing clause, and the messaging terms", async () => {
    const { app } = serve("words");
    try {
      const page = (await app.inject({ method: "GET", url: "/api/public/local/texts" })).json() as { wording: string; privacy: { text: string }[]; terms: { heading: string; text: string }[] };
      expect(page.wording).toBe(optInWording("Acme Plumbing"));
      expect(page.privacy.map((one) => one.text).join(" ")).toContain(NO_SHARING_CLAUSE);
      expect(page.terms.map((one) => one.heading)).toEqual(["What you get", "How often", "Cost", "Stop and help", "Carriers", "Privacy"]);
      expect((await app.inject({ method: "GET", url: "/api/public/other/texts" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keep a tick on the form as consent with the exact words, and refuse without the tick", async () => {
    const { app, contacts } = serve("opt-in");
    try {
      const url = "/api/public/local/texts/opt-in";
      expect((await app.inject({ method: "POST", url, payload: { phone: "512-555-0101" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, payload: { phone: "512-555-0101", consent: true, website: "http://spam" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, payload: { phone: "nope", consent: true } })).statusCode).toBe(400);
      const signed = await app.inject({ method: "POST", url, payload: { name: "Dana", phone: "512-555-0101", consent: true }, headers: { origin: "https://acmeplumbing.example" } });
      expect(signed.statusCode).toBe(200);
      expect(signed.headers["access-control-allow-origin"]).toBe("*");
      expect((await contacts.byKey("phone:+15125550101"))?.textConsent).toMatchObject({ status: "given", source: "opt_in_form", wording: optInWording("Acme Plumbing"), phone: "+15125550101" });
      expect((await app.inject({ method: "OPTIONS", url })).statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("serve the form as a script for the business's own site, pointed at this server and these pages", async () => {
    const { app } = serve("script");
    try {
      const script = await app.inject({ method: "GET", url: "/api/public/local/texts/opt-in.js" });
      expect(script.headers["content-type"]).toContain("text/javascript");
      expect(script.body).toContain('"https://dash.example/api/public/local/texts/opt-in"');
      expect(script.body).toContain('"https://pages.example/p/local/texts/privacy"');
      expect(script.body).toContain(JSON.stringify(optInWording("Acme Plumbing")));
      expect(script.body).not.toMatch(/checked\s*[:=]\s*true/);
    } finally {
      await app.close();
    }
  });

  it("pass Dash's own registration scan, as a business's own copy of them would", async () => {
    const html = `<h1>Acme Plumbing</h1><label><input type="checkbox" name="consent"> ${optInWording("Acme Plumbing")}</label><p>${NO_SHARING_CLAUSE}</p>`;
    expect(await scanPolicy("https://acmeplumbing.example/texts", { legalName: "Acme Plumbing LLC", fetch: async () => ({ status: 200, text: html }) })).toMatchObject({ showsName: true, noSharing: true, checkedByDefault: false, consentWithTerms: false, prohibited: [] });
  });
});
