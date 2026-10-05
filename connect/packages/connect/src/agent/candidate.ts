import type { EntityKind } from "@freebirdai/connect-spec";

/**
 * One record type as the agent's passes see it: what it is, which API it
 * came from, and the fields worth naming. Categories, rhythm and Dash's
 * widget briefs all read the same roster.
 */

/** A field worth naming in a brief. */
export interface BriefField {
  readonly path: string;
  readonly label: string;
  /**
   * `narrow` filters or groups; `total` is a number worth adding up; `when`
   * dates the record; `other` is any other plain field, named so a request
   * about it can reach it — its values are too many to list.
   */
  readonly role: "narrow" | "total" | "when" | "other";
  /**
   * The values this field holds: the API's declared set, or, where it declares
   * none, what this account's records were seen to hold.
   *
   * Carried so a narrowing phrase can be written in the data's own spelling
   * rather than the user's — "USD", not "US dollars". A total narrowed by a
   * word the records never hold counts nothing and looks right.
   */
  readonly values?: readonly string[];
  /**
   * The values are what the records were seen to hold, not a set the API
   * declares: `all` where the read saw every record, `some` where it did not —
   * a first page shows the values near the start of the list, not all of them.
   */
  readonly seen?: "all" | "some";
  /**
   * The documentation says this number is in the smallest currency unit
   * (12500 is $125.00). An amount a request names is written in that unit:
   * "more than $250" compared 250 cents, and counted the wrong payments.
   * The values are never rescaled on this claim alone.
   */
  readonly minor?: true;
  /**
   * What the documentation says the field means, in its own words and short.
   * Two fields can answer to the same word — a flag that is true only when
   * something happened in full, and an amount that says how much of it did —
   * and only the documentation tells them apart. A count of "refunded, in full
   * or in part" read the flag, and missed every part refund (2026-09-30).
   */
  readonly note?: string;
}

/** One record type the model may choose. */
export interface BriefCandidate {
  /**
   * What the model copies, and what makes it unique across every API.
   *
   * The record type's own id where that is unambiguous, qualified with the
   * connection where two APIs both have one — the same rule the chat's widget
   * and record handles follow, and for the same reason: "task" reads as a
   * thing and "task--acme" reads as configuration, so the second is worth
   * paying for only where the first would be ambiguous.
   */
  readonly entity: string;
  /** Which API this came from, and its own id there. */
  readonly connection: string;
  readonly recordType: string;
  /** That API's name, for grouping the roster where there is more than one. */
  readonly source: string;
  readonly many: string;
  readonly kind: EntityKind;
  readonly description?: string | undefined;
  /**
   * Whether somebody would start a widget from these.
   *
   * False for the kinds that only make sense under another record — a list of
   * every category on an account is a glossary, not a dashboard.
   */
  readonly starting: boolean;
  readonly fields: readonly BriefField[];
  /**
   * Every field the record type has, listed or not. What tells a name the
   * roster left out from a name no record has — only the second is sent back.
   */
  readonly paths?: readonly string[];
}
