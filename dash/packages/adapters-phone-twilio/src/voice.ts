import { randomBytes } from "node:crypto";
import type { TrunkInfo } from "@freebirdai/dash-spec";
import type { VoiceAdapter } from "@freebirdai/phone";

/**
 * Twilio's calls, as Dash Phone's `VoiceAdapter`, over Elastic SIP Trunking
 * (https://www.twilio.com/docs/sip-trunking/api):
 *
 * - **In:** a trunk whose origination URL is the media layer's SIP address
 *   (LiveKit's), with the line's numbers on it, so a call to the number goes
 *   straight to the media layer. Nothing is typed into Twilio by hand.
 * - **Out:** the same trunk's termination domain, with a credential list the
 *   media layer signs in with to dial through Twilio. The password is made
 *   here and handed back once, for the server to keep in its vault.
 *
 * `disconnectTrunk` deletes the trunk: the numbers go back to plain numbers
 * and their credential list stays for the account to remove.
 */

export const TRUNKING = "https://trunking.twilio.com/v1";

type Call = (method: string, path: string, form?: Record<string, string> | ReadonlyArray<readonly [string, string]>) => Promise<Record<string, unknown>>;

export interface TwilioVoiceDeps {
  readonly call: Call;
  readonly accountBase: () => string;
  readonly numberSid: (number: string) => Promise<string>;
  readonly trunking?: string;
  /** Random hex, for the trunk's name and the termination credential. */
  readonly random?: (bytes: number) => string;
}

const sidOf = (answer: Record<string, unknown>, what: string): string => {
  const sid = answer["sid"];
  if (typeof sid !== "string" || !sid) throw new Error(`Twilio did not say which ${what} it made.`);
  return sid;
};

export const twilioVoice = (deps: TwilioVoiceDeps): VoiceAdapter => {
  const trunking = deps.trunking ?? TRUNKING;
  const random = deps.random ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const { call } = deps;
  return {
    connectTrunk: async (t): Promise<TrunkInfo> => {
      const name = `dash-${random(4)}`;
      const trunk = sidOf(await call("POST", `${trunking}/Trunks`, { FriendlyName: `Dash calls (${name})`, DomainName: `${name}.pstn.twilio.com` }), "trunk");
      await call("POST", `${trunking}/Trunks/${trunk}/OriginationUrls`, { FriendlyName: "Dash media layer", SipUrl: t.sipUri, Priority: "10", Weight: "10", Enabled: "true" });
      for (const number of t.numbers) await call("POST", `${trunking}/Trunks/${trunk}/PhoneNumbers`, { PhoneNumberSid: await deps.numberSid(number) });
      /* Outbound: a credential list on the trunk, which the media layer signs in with. */
      const username = `dash${random(4)}`;
      const password = `${random(12)}Aa1`;
      const list = sidOf(await call("POST", `${deps.accountBase()}/SIP/CredentialLists.json`, { FriendlyName: `Dash calls (${name})` }), "credential list");
      await call("POST", `${deps.accountBase()}/SIP/CredentialLists/${list}/Credentials.json`, { Username: username, Password: password });
      await call("POST", `${trunking}/Trunks/${trunk}/CredentialLists`, { CredentialListSid: list });
      return { id: trunk, sipUri: t.sipUri, numbers: [...t.numbers], termination: { address: `${name}.pstn.twilio.com`, username, password } };
    },
    disconnectTrunk: async (id) => {
      await call("DELETE", `${trunking}/Trunks/${id}`);
    },
  };
};
