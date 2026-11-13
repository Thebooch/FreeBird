import { describe, expect, it } from "vitest";
import type { PhoneAccount } from "../api.js";
import { setupCards } from "./phoneChoices.js";

const account = (id: string, title: string, capabilities?: PhoneAccount["capabilities"]): PhoneAccount => ({ id, title, connected: false, credentials: [], ...(capabilities ? { capabilities } : {}) });
const ACCOUNTS = [account("telnyx", "Telnyx", { text: true, voice: "sip", registration: "10dlc" }), account("twilio", "Twilio", { text: true, voice: "sip", registration: "10dlc" }), account("sip", "Another carrier (SIP)", { text: false, voice: "sip", registration: "none" })];

describe("Add a phone line: the cards", () => {
  it("is bring-your-own only when the server's host offers no line: no provided-number card at all", () => {
    for (const offers of [undefined, []]) {
      const cards = setupCards(ACCOUNTS, offers);
      expect(cards.every((card) => card.kind === "provider")).toBe(true);
      expect(cards.map((card) => card.id)).toEqual(["twilio", "telnyx", "sip"]);
      expect(cards.filter((card) => card.kind === "provider" && card.firstOther).map((card) => card.id)).toEqual(["telnyx"]);
    }
  });

  it("puts the host's offer first, in its own words, only when it offers one", () => {
    const cards = setupCards(ACCOUNTS, [{ id: "provided", title: "Use a number we provide", description: "We buy and register it for you.", areaCode: true }]);
    expect(cards[0]).toMatchObject({ kind: "offer", id: "offer:provided", title: "Use a number we provide", description: "We buy and register it for you." });
    expect(cards.slice(1).map((card) => card.id)).toEqual(["twilio", "telnyx", "sip"]);
  });

  it("says what each provider offers", () => {
    const cards = setupCards(ACCOUNTS);
    expect(cards.map((card) => card.description)).toEqual(["The default: paste two keys, pick a number", "Texts with registration and calls", "Calls only, over a SIP trunk you set up at your carrier"]);
  });
});
