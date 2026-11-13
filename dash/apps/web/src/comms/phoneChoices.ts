import type { PhoneAccount, PhoneLineOffer } from "../api.js";

/**
 * The cards on Add a phone line, in order. A line the server's host provides
 * is a card only when the host offers one (`offers` from `GET
 * /api/comms/lines`); with none, the screen is connecting your own provider
 * only: Twilio as the default, then "Use another provider".
 */
export type SetupCard =
  | { readonly kind: "offer"; readonly id: string; readonly offer: PhoneLineOffer; readonly title: string; readonly description: string }
  | { readonly kind: "provider"; readonly id: string; readonly account: PhoneAccount; readonly title: string; readonly description: string; readonly isDefault: boolean; readonly firstOther: boolean };

/** What a provider offers, in a line. */
export const providerOffers = (account: Pick<PhoneAccount, "capabilities">): string => {
  const can = account.capabilities;
  if (!can) return "Texts and calls";
  if (!can.text) return can.voice === "sip" ? "Calls only, over a SIP trunk you set up at your carrier" : "Numbers only";
  return can.voice === "sip" ? `Texts${can.registration === "10dlc" ? " with registration" : ""} and calls` : "Texts";
};

export const OFFER_PREFIX = "offer:";

export const setupCards = (accounts: readonly PhoneAccount[], offers: readonly PhoneLineOffer[] = []): SetupCard[] => {
  const cards: SetupCard[] = offers.map((offer) => ({ kind: "offer", id: `${OFFER_PREFIX}${offer.id}`, offer, title: offer.title, description: offer.description }));
  const twilio = accounts.filter((one) => one.id === "twilio");
  const others = accounts.filter((one) => one.id !== "twilio");
  for (const account of [...twilio, ...others]) {
    const isDefault = account.id === "twilio";
    cards.push({
      kind: "provider",
      id: account.id,
      account,
      title: account.title,
      description: account.connected ? `Connected · ${providerOffers(account)}` : isDefault ? "The default: paste two keys, pick a number" : providerOffers(account),
      isDefault,
      firstOther: !isDefault && account === others[0] && twilio.length > 0,
    });
  }
  return cards;
};
