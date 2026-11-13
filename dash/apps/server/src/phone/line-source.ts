import type { RegistrationAdapter, PhoneKeys } from "@freebirdai/phone";

/**
 * Lines a host provides: the seam a server's host fills to offer a phone
 * line it supplies itself, beside "connect your own provider". The local
 * default offers nothing, so a server that sets no source shows only
 * bring-your-own.
 *
 * A host implements `PhoneLineSource`:
 *
 * - `offers(workspace)`: what it offers this workspace, for the setup screen
 *   (none: the card is not shown).
 * - `provision(...)`: a number on the host's own account for one of its
 *   offers, and which registered provider adapter the line uses.
 * - `keys(...)`: the keys for one use of a line it provided, in that
 *   adapter's `CredentialField` keys. Called for every use, like a vault
 *   read; Dash never stores them, and no adapter holds them past the call.
 * - `registration?(...)`: a registration adapter for the line, when the host
 *   registers its lines differently from the provider's own adapter.
 * - `suspended?(...)`: whether the host has suspended the line, read before
 *   every send and call.
 * - `release(...)`: gives the number back when the line is removed.
 *
 * Usage is reported through `PhoneUsage` (`usage-events.ts`), for a host that
 * meters it.
 */

/** One thing a host offers on the setup screen. */
export interface PhoneLineOffer {
  /** The host's id for the offer. */
  readonly id: string;
  /** The card's title, e.g. "Use a number we provide". */
  readonly title: string;
  /** One or two sentences under it: what it is, what it costs, in the host's words. */
  readonly description: string;
  /** Whether the person picks an area code. */
  readonly areaCode: boolean;
}

/** A line the host made: the number, the adapter that runs it, and the host's own id for it. */
export interface ProvidedLine {
  /** A provider registered on the server (`BuildServerOptions.phoneProviders`): the adapter the line uses. */
  readonly provider: string;
  readonly number: string;
  /** The host's id for this line: handed back to `keys`, `registration`, `suspended` and `release`. Kept on the line, never shown. */
  readonly ref: string;
}

/** Which provided line a call is about. */
export interface ProvidedLineRef {
  readonly workspace: string;
  /** Dash's line id. */
  readonly line: string;
  /** The host's `ProvidedLine.ref`. */
  readonly ref: string;
}

export interface PhoneLineSource {
  offers(workspace: string): Promise<readonly PhoneLineOffer[]>;
  provision(input: { readonly workspace: string; readonly offer: string; readonly areaCode?: string }): Promise<ProvidedLine>;
  keys(line: ProvidedLineRef): PhoneKeys;
  registration?(line: ProvidedLineRef, keys: PhoneKeys): RegistrationAdapter | undefined;
  suspended?(line: ProvidedLineRef): Promise<{ readonly reason?: string } | null>;
  release(line: ProvidedLineRef): Promise<void>;
}

/** The local default: nothing offered, so only "connect your own provider" exists. */
export const NO_LINE_SOURCE: PhoneLineSource = {
  offers: async () => [],
  provision: async () => {
    throw new Error("This server provides no phone lines: connect your own provider.");
  },
  keys: () => ({}),
  release: async () => undefined,
};
