/**
 * Telling the team about bookings: the seam Comms fills.
 *
 * Until email is connected every notice is `not_sent`, and nothing is lost by
 * it: each approval still waits in Waiting for you, where a member can also
 * copy the approval link to answer from the approval page.
 */

export const TEAM_NOTICE_KINDS = ["approval_request", "approval_reminder", "decision_recorded", "booking_changed"] as const;
export type TeamNoticeKind = (typeof TEAM_NOTICE_KINDS)[number];

export interface TeamNotice {
  readonly kind: TeamNoticeKind;
  readonly member: { readonly id: string; readonly email: string; readonly name: string };
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** At most once, like `OutreachSender`: the same key is never sent twice. */
  readonly key: string;
}

export interface TeamNotifier {
  notify(message: TeamNotice): Promise<{ readonly status: "sent" | "queued" | "not_sent"; readonly detail?: string }>;
}

export const notConnectedNotifier: TeamNotifier = {
  notify: async () => ({ status: "not_sent", detail: "Email is not connected yet; the request is in Waiting for you." }),
};

/** How the workspace looks on its public pages and in its messages. */
export interface Brand {
  readonly name: string;
  /** A six-digit hex color, like #2f5bea. */
  readonly accent: string;
}

export const DEFAULT_BRAND: Brand = { name: "Bookings", accent: "#2f5bea" };

/** A brand with anything unusable replaced by the default: the accent goes into inline styles. */
export const brandOf = (brand: Partial<Brand> | undefined): Brand => ({
  name: brand?.name?.trim().slice(0, 80) || DEFAULT_BRAND.name,
  accent: brand?.accent && /^#[0-9a-fA-F]{6}$/.test(brand.accent) ? brand.accent : DEFAULT_BRAND.accent,
});
