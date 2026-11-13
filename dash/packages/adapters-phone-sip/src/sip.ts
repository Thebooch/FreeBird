import { createHash } from "node:crypto";
import { e164Schema, type AccountInfo, type OwnedNumber, type TrunkInfo } from "@freebirdai/dash-spec";
import { PhoneKeysError, type OpenPhoneProvider, type PhoneKeys, type PhoneProvider } from "@freebirdai/phone";

/**
 * Any carrier's calls, for Dash Phone: a SIP trunk the business already has
 * (or sets up at its carrier), with no text API and no registration. Voice
 * only, through the same media layer and voice worker as Twilio's and
 * Telnyx's calls.
 *
 * Nothing here talks to the carrier: Dash cannot point a carrier it has no API
 * for. The person pastes what the carrier's portal shows (the numbers on the
 * trunk, its termination address, and the credential the media layer dials
 * out with), and points the trunk's inbound calls at Dash's SIP address
 * themselves; Dash shows that address on the line. `connectTrunk` hands the
 * pasted credential to the media layer; `disconnectTrunk` has nothing at the
 * carrier to undo.
 */

export const SIP_PROVIDER_ID = "sip";

/** The numbers on the trunk, from what was pasted: E.164, separated by commas, spaces or new lines. */
export const sipNumbersOf = (raw: string | undefined): string[] => {
  const numbers = (raw ?? "")
    .replace(/[()\-.]/g, "")
    .split(/[,;\n]+/)
    .map((one) => one.replace(/\s+/g, ""))
    .filter(Boolean);
  const out: string[] = [];
  for (const one of numbers) {
    const parsed = e164Schema.safeParse(one);
    if (!parsed.success) throw new PhoneKeysError(`"${one}" is not a number in international form, like +15551234567.`);
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  if (out.length === 0) throw new PhoneKeysError("Give the numbers on the trunk, like +15551234567.");
  if (out.length > 50) throw new PhoneKeysError("Give at most 50 numbers for one trunk.");
  return out;
};

/** A carrier's SIP host, with an optional port: `sip.carrier.example` or `sip.carrier.example:5060`. */
export const sipAddressOf = (raw: string | undefined): string => {
  const address = (raw ?? "").trim().replace(/^sips?:/i, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?$/i.test(address)) throw new PhoneKeysError("The termination address is the carrier's SIP host, like sip.carrier.example.");
  return address.toLowerCase();
};

const checked = (keys: PhoneKeys) => {
  const numbers = sipNumbersOf(keys["numbers"]);
  const address = sipAddressOf(keys["address"]);
  const username = keys["username"]?.trim() ?? "";
  const password = keys["password"] ?? "";
  if (!username || !password) throw new PhoneKeysError("Give the trunk's username and password, from the carrier's portal.");
  return { numbers, address, username, password };
};

const NOT_HERE = "A SIP trunk's numbers come from your carrier: add or remove them in its portal, then paste the list here again.";

export const createSipProvider =
  (): OpenPhoneProvider =>
  (keys: PhoneKeys): PhoneProvider => ({
    id: SIP_PROVIDER_ID,
    title: "Another carrier (SIP)",
    credentials: [
      { key: "numbers", label: "Numbers on the trunk", secret: false, help: "The numbers your carrier sends over this trunk, in international form, separated by commas." },
      { key: "address", label: "Termination address", secret: false, help: "The carrier's SIP host for outbound calls, from its portal (for example sip.carrier.example)." },
      { key: "username", label: "Username", secret: false, help: "The trunk's SIP username for outbound calls." },
      { key: "password", label: "Password", secret: true, help: "The trunk's SIP password. Dash keeps it in its vault and never shows it again." },
    ],
    capabilities: { text: false, voice: "sip", registration: "none" },
    verify: async (given): Promise<AccountInfo> => {
      const trunk = checked(given);
      return { name: `SIP trunk at ${trunk.address}`, trial: false };
    },
    numbers: {
      search: async () => {
        throw new Error(NOT_HERE);
      },
      buy: async () => {
        throw new Error(NOT_HERE);
      },
      list: async (): Promise<OwnedNumber[]> => {
        const trunk = checked(keys);
        return trunk.numbers.map((number) => ({ number, providerId: `sip-${number.slice(1)}`, capabilities: { text: false, voice: true } }));
      },
      route: async (_number, to) => {
        if (to.textWebhook) throw new Error("A SIP trunk carries calls only, so there are no texts to route.");
        /* Calls are pointed at the media layer at the carrier, by the person. */
      },
      release: async () => {
        throw new Error(NOT_HERE);
      },
    },
    voice: {
      connectTrunk: async (t): Promise<TrunkInfo> => {
        const trunk = checked(keys);
        const missing = t.numbers.filter((one) => !trunk.numbers.includes(one));
        if (missing.length > 0) throw new Error(`${missing.join(", ")} is not on this trunk.`);
        const id = `sip-${createHash("sha1").update(`${trunk.address}:${t.numbers.join(",")}`).digest("hex").slice(0, 12)}`;
        return { id, sipUri: t.sipUri, numbers: [...t.numbers], termination: { address: trunk.address, username: trunk.username, password: trunk.password } };
      },
      disconnectTrunk: async () => undefined,
    },
  });
