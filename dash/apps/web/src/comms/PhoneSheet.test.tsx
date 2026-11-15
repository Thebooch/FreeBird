// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneAccount } from "../api.js";
import { click, fakeServer, mount, settle, shown, type, unmountAll, type FakeServer } from "../testing/screen.js";
import { AddPhoneLineSheet } from "./PhoneSheet.jsx";

/**
 * Adding a phone line: a provider's keys go in once, and the last button
 * buys or wires a number on somebody's account.
 *
 * These hold the sheet to the order that keeps that safe: nothing is set up
 * until the account is connected, the server can be reached from outside,
 * and a number was picked; keys are sent once, to the one place they belong.
 */

const twilio: PhoneAccount = {
  id: "twilio",
  title: "Twilio",
  connected: false,
  credentials: [
    { key: "accountSid", label: "Account SID", secret: false },
    { key: "authToken", label: "Auth token", secret: true },
  ] as unknown as PhoneAccount["credentials"],
  capabilities: { text: true, voice: "sip", registration: "10dlc" },
};

const LINES = "/api/comms/lines";
let server: FakeServer;
let onAdded: ReturnType<typeof vi.fn>;
const open = async (routes: Parameters<typeof fakeServer>[0]) => {
  server = fakeServer(routes);
  onAdded = vi.fn();
  mount(createElement(AddPhoneLineSheet, { agents: [], onClose: () => {}, onAdded }));
  await settle();
  return document.body;
};
const by = <T extends HTMLElement>(page: ParentNode, id: string): T => {
  const found = page.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`nothing on screen with test id ${id}`);
  return found;
};
const has = (page: ParentNode, id: string) => page.querySelector(`[data-testid="${id}"]`) !== null;
const writes = () => server.calls.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.url}`);
const save = async (page: ParentNode) => {
  await click(by(page, "setup-save"));
  await settle();
};

afterEach(() => {
  unmountAll();
  server?.restore();
  document.body.innerHTML = "";
});

describe("adding a phone line", () => {
  it("asks for the provider's keys first, and sets nothing up without them", async () => {
    const page = await open({ [`GET ${LINES}`]: { lines: [], accounts: [twilio] } });
    expect(by(page, "phone-provider-twilio").getAttribute("aria-checked")).toBe("true");
    expect(by<HTMLInputElement>(page, "phone-key-authToken").type).toBe("password");
    /* No numbers to pick, and no reach check, before an account is connected. */
    expect(has(page, "phone-search")).toBe(false);
    expect(writes()).toEqual([]);

    await save(page);
    expect(shown(page)).toContain("Connect the provider's account first.");
    expect(writes()).toEqual([]);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("sends the keys once, to that provider's account, and shows a refusal in the provider's words", async () => {
    const page = await open({
      [`GET ${LINES}`]: { lines: [], accounts: [twilio] },
      [`POST ${LINES}/accounts/twilio`]: { status: 400, body: { error: "Twilio refused these keys." } },
    });
    await type(by<HTMLInputElement>(page, "phone-key-accountSid"), "AC123");
    await type(by<HTMLInputElement>(page, "phone-key-authToken"), "secret-token");
    await click(by(page, "phone-connect"));
    await settle();
    expect(server.sent(`POST ${LINES}/accounts/twilio`).map((one) => one.body)).toEqual([{ keys: { accountSid: "AC123", authToken: "secret-token" } }]);
    expect(shown(page)).toContain("Twilio refused these keys.");
    expect(has(page, "phone-connected")).toBe(false);
    /* Still nothing else asked of the provider. */
    expect(writes()).toEqual([`POST ${LINES}/accounts/twilio`]);
    /* The token is never drawn as text. */
    expect(shown(page)).not.toContain("secret-token");
  });

  it("will not set a line up while the server cannot be reached from outside", async () => {
    const page = await open({
      [`GET ${LINES}`]: { lines: [], accounts: [{ ...twilio, connected: true }] },
      [`POST ${LINES}/address-check`]: { ok: false, problem: "This address is only reachable on your network.", fixes: [] },
    });
    expect(shown(by(page, "phone-address-problem"))).toContain("This address is only reachable on your network.");
    await save(page);
    expect(shown(page)).toContain("This server can't be reached from the internet yet: fix the address first.");
    expect(server.sent(`POST ${LINES}/setup`)).toHaveLength(0);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("will not set a line up until a number is picked, then sets up exactly that one", async () => {
    const page = await open({
      [`GET ${LINES}`]: { lines: [], accounts: [{ ...twilio, connected: true }] },
      [`POST ${LINES}/address-check`]: { ok: true, origin: "https://dash.example.test" },
      [`GET ${LINES}/accounts/twilio/numbers`]: { numbers: [{ number: "+15125550111", locality: "Austin", region: "TX" }, { number: "+15125550122" }] },
      [`POST ${LINES}/setup`]: { line: { id: "line-9", title: "Main", number: "+15125550122", text: "needs_registration" } },
      [`GET ${LINES}/line-9/threads`]: { threads: [] },
    });
    await save(page);
    expect(shown(page)).toContain("Search, then pick a number.");
    expect(server.sent(`POST ${LINES}/setup`)).toHaveLength(0);

    await type(by<HTMLInputElement>(page, "phone-area-code"), "512");
    await click(by(page, "phone-search"));
    await settle();
    expect(server.calls.some((one) => one.url === `${LINES}/accounts/twilio/numbers?areaCode=512`)).toBe(true);
    expect(shown(by(page, "phone-number-+15125550111"))).toContain("Austin, TX");
    /* Searching buys nothing. */
    expect(server.sent(`POST ${LINES}/setup`)).toHaveLength(0);

    await click(by(page, "phone-number-+15125550122").querySelector<HTMLInputElement>("input")!);
    await save(page);
    expect(server.sent(`POST ${LINES}/setup`).map((one) => one.body)).toEqual([{ provider: "twilio", choice: "new", number: "+15125550122", owner: { kind: "team" } }]);
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(has(page, "phone-line-made")).toBe(true);
  });

  it("says what went wrong when the provider refuses the number, and adds no line", async () => {
    const page = await open({
      [`GET ${LINES}`]: { lines: [], accounts: [{ ...twilio, connected: true }] },
      [`POST ${LINES}/address-check`]: { ok: true },
      [`GET ${LINES}/accounts/twilio/numbers`]: { numbers: [{ number: "+15125550111" }] },
      [`POST ${LINES}/setup`]: { status: 502, body: { error: "That number was just taken by somebody else." } },
    });
    await click(by(page, "phone-search"));
    await settle();
    await click(by(page, "phone-number-+15125550111").querySelector<HTMLInputElement>("input")!);
    await save(page);
    expect(server.sent(`POST ${LINES}/setup`)).toHaveLength(1);
    expect(shown(page)).toContain("That number was just taken by somebody else.");
    expect(onAdded).not.toHaveBeenCalled();
    expect(has(page, "phone-line-made")).toBe(false);
  });

  it("shows no card for a provided line unless the server's host offers one", async () => {
    const without = await open({ [`GET ${LINES}`]: { lines: [], accounts: [twilio] } });
    expect(without.querySelector('[data-testid^="phone-offer-"]')).toBeNull();
    unmountAll();
    server.restore();
    document.body.innerHTML = "";

    const withOffer = await open({ [`GET ${LINES}`]: { lines: [], accounts: [twilio], offers: [{ id: "starter", title: "A number from us", description: "Ready in a minute.", areaCode: true }] } });
    expect(shown(by(withOffer, "phone-offer-starter"))).toContain("A number from us");
    /* The provider is still there to pick instead (`phoneChoices.test.ts` holds the order and the wording). */
    expect(has(withOffer, "phone-provider-twilio")).toBe(true);
    expect(writes()).toEqual([]);
  });
});
