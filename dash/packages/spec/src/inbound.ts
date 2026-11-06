import { z } from "zod";

/**
 * The inbound screen (Dash Evals, phase 2): what stands between an email that
 * arrives and the model and workflows that read it.
 *
 * Rules decide, in front of extraction and before any workflow starts: who
 * is asking (a requester policy keyed to the sender, never an IP), whether
 * they are over their limits, and known shapes of injection, impersonation
 * and risky links. A model may add a signal later; it never releases a
 * message alone. The screen starts observe-only: it scores and logs, and
 * holds nothing but blocked senders, until a person turns holding on.
 *
 * Dash does not try to tell people from agents. A verified agent identity
 * can raise trust; its absence lowers nothing.
 */

/** How far a requester is trusted, lowest first. `blocked` is held always; `trusted` may drive Auto with what they send. */
export const REQUESTER_TRUST = ["blocked", "unknown", "known", "verified_agent", "trusted"] as const;
export type RequesterTrust = (typeof REQUESTER_TRUST)[number];

export const TRUST_WORDS: Readonly<Record<RequesterTrust, string>> = {
  blocked: "Blocked",
  unknown: "Unknown sender",
  known: "Known contact",
  verified_agent: "Verified agent",
  trusted: "Trusted",
};

/** A rule a person set for a sender address or a whole domain. The address wins over its domain. */
export const requesterRuleSchema = z.object({
  /** `address:dana@example.com` or `domain:example.com`. */
  key: z.string().regex(/^(address|domain):[^\s]+$/, "A requester is address:<email> or domain:<domain>."),
  trust: z.enum(["blocked", "trusted"]),
  by: z.string(),
  at: z.string(),
  note: z.string().max(300).optional(),
});
export type RequesterRule = z.infer<typeof requesterRuleSchema>;

/** Limits per requester, over a rolling day. */
export const requesterLimitsSchema = z.object({
  /** Messages from one sender that may reach workflows in a day. */
  messagesPerDay: z.number().int().min(1).max(10_000).default(20),
  /** Messages from every sender at one domain together: a swarm of look-alike addresses counts as one. */
  domainMessagesPerDay: z.number().int().min(1).max(100_000).default(200),
});
export type RequesterLimits = z.infer<typeof requesterLimitsSchema>;

export const inboundSettingsSchema = z.object({
  /** Score and log only: nothing is held but a blocked sender. On until a person turns holding on. */
  observeOnly: z.boolean().default(true),
  limits: requesterLimitsSchema.default({}),
});
export type InboundSettings = z.infer<typeof inboundSettingsSchema>;

export const SCREEN_SIGNAL_KINDS = ["blocked", "over_limit", "injection", "impersonation", "link", "attachment", "classifier"] as const;
export type ScreenSignalKind = (typeof SCREEN_SIGNAL_KINDS)[number];

/** One thing the screen noticed. `hold`: a rule that holds the message when holding is on. */
export const screenSignalSchema = z.object({
  kind: z.enum(SCREEN_SIGNAL_KINDS),
  /** In plain words, for the person deciding: "asks to mark invoice 1042 paid". */
  detail: z.string().max(300),
  hold: z.boolean(),
});
export type ScreenSignal = z.infer<typeof screenSignalSchema>;

export const SCREEN_STATUSES = ["passed", "held", "released", "dropped"] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];

/** One email as the screen saw it, kept: what it decided, and what a person did about it. */
export const screenRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  mailbox: z.string(),
  message: z.string(),
  /** The sender's address. The message itself stays in Communications, sealed; this names it. */
  from: z.string(),
  contact: z.string().optional(),
  requester: z.object({ key: z.string(), trust: z.enum(REQUESTER_TRUST) }),
  signals: z.array(screenSignalSchema).default([]),
  /** Whether a rule would hold it, whatever the mode. */
  wouldHold: z.boolean(),
  observeOnly: z.boolean(),
  status: z.enum(SCREEN_STATUSES),
  /** Who released or dropped it, and when. */
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
});
export type ScreenRecord = z.infer<typeof screenRecordSchema>;

/** The requester keys for a sender address: its own, then its domain's. */
export const requesterKeys = (address: string): { readonly address: string; readonly domain: string } => {
  const email = address.trim().toLowerCase();
  return { address: `address:${email}`, domain: `domain:${email.split("@")[1] ?? email}` };
};
