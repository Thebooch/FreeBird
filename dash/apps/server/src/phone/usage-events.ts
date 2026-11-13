/**
 * What a workspace's phone lines used, as events: the seam a host fills to
 * meter phone use. Emitted where Dash already counts a line's ceilings, once
 * the use happened; the default ignores them, and an event that fails to
 * record never stops a send.
 *
 * Each event carries an idempotency `key`, the same for the same use however
 * often it is reported (a retried webhook, a status update after the voice
 * worker's own count): a meter keeps the first event per key and so never
 * counts twice.
 */

export const PHONE_USAGE_KINDS = ["text_sent", "text_received", "call_minutes", "number_held", "number_released", "registration_submitted"] as const;
export type PhoneUsageKind = (typeof PHONE_USAGE_KINDS)[number];

export interface PhoneUsageEvent {
  readonly workspace: string;
  readonly line: string;
  /** The line's provider id ("twilio", "telnyx", …). */
  readonly provider: string;
  readonly kind: PhoneUsageKind;
  /** Texts (1 each), minutes, numbers (1), submissions (1). */
  readonly quantity: number;
  /** When it was used, ISO. */
  readonly at: string;
  /** The same for the same use, every time it is reported. */
  readonly key: string;
  /** Whether the line was provided by the host's line source (`PhoneLineSource`) or brought by the workspace. */
  readonly provided: boolean;
}

export interface PhoneUsage {
  record(event: PhoneUsageEvent): void | Promise<void>;
}

/** The local default: use is counted for the ceilings, and not reported anywhere. */
export const IGNORE_PHONE_USAGE: PhoneUsage = { record: () => undefined };

/** What a phone module reports; the server adds the workspace. */
export type PhoneUse = Omit<PhoneUsageEvent, "workspace">;

/** Reports one use without ever failing the caller. */
export const reportUse = (sink: ((event: PhoneUse) => void | Promise<void>) | undefined, event: PhoneUse): void => {
  if (!sink) return;
  try {
    void Promise.resolve(sink(event)).catch(() => undefined);
  } catch {
    /* A meter that throws does not stop a send. */
  }
};
