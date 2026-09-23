import { z } from "zod";
import { idSchema } from "./primitives.js";

/**
 * How often each endpoint is worth asking again.
 *
 * The keeper refreshes on a cadence, and one cadence for everything is wrong
 * in both directions: new applications, charges and work orders arrive all
 * day, while vendors, users, properties and bank accounts change a few times
 * a year. Pulling the second group every ten minutes spends somebody's rate
 * limit on answers that never move; pulling the first group daily means a
 * board that is quietly a day behind.
 *
 * **The decision is per endpoint**, because that is the unit of a request.
 * The *model* is asked about record types, which is the vocabulary it can
 * actually reason in ("do new applications appear constantly?"), and the
 * answer is projected onto the endpoints that list them.
 *
 * Split across two homes, on the same line onboarding already draws:
 *
 * - **Shared, on the catalog entry.** "New applications arrive constantly" is
 *   a fact about Buildium, true for everybody who connects it, and it is what
 *   one model call per API buys. See `apiRhythmSchema`.
 * - **Personal, per connection.** The cadences, and anything this particular
 *   user moved. Somebody who does not care whether vendors are current is not
 *   wrong, and their choice must not travel to anybody else. See
 *   `connectionRhythmSchema`.
 *
 * Nothing here assumes two tiers. They ship as data from the first commit so a
 * UI later only writes JSON, and a deployment that wants an hourly tier adds
 * one without touching code.
 */

export const RHYTHM_VERSION = 1;

/**
 * How often rows *arrive* — not how often a field is edited.
 *
 * The distinction the whole classification rests on. Nearly every endpoint on
 * a well-built API accepts a `lastupdated` filter, and it says nothing: what
 * matters is whether new records appear, because that is what makes a board
 * out of date.
 */
export const VOLATILITIES = ["constant", "daily", "rare"] as const;
export const volatilitySchema = z.enum(VOLATILITIES);
export type Volatility = (typeof VOLATILITIES)[number];

export const tierSchema = z.object({
  id: idSchema,
  /** What this cadence is called, in a reader's words. */
  title: z.string().min(1).max(80),
  /** How often an endpoint in this tier is asked again. */
  everyMs: z
    .number()
    .int()
    /*
     * A floor rather than a preference. Anything faster than a minute is not
     * a refresh policy, it is a denial of service with a nice name on it —
     * and the gate's pacing would queue it into one anyway.
     */
    .min(60_000)
    .max(7 * 24 * 60 * 60_000),
  /** Which volatilities land here when nobody has said otherwise. */
  covers: z.array(volatilitySchema).default([]),
});

export type TierSpec = z.infer<typeof tierSchema>;

/**
 * The two cadences that ship.
 *
 * `rare` deliberately shares the daily tier rather than getting a weekly one
 * of its own: it is a different *reading* of an endpoint, not yet a different
 * schedule, and a tier nobody can tell apart from its neighbour is a setting
 * that only looks like a choice. Adding one is a data change.
 */
export const DEFAULT_TIERS: readonly TierSpec[] = [
  {
    id: "live",
    title: "Changes all day",
    everyMs: 10 * 60_000,
    covers: ["constant"],
  },
  {
    id: "daily",
    title: "Changes rarely",
    everyMs: 24 * 60 * 60_000,
    covers: ["daily", "rare"],
  },
];

/**
 * Where an unclassified endpoint starts.
 *
 * The fast tier, deliberately. A wrong "slow" shows day-old numbers with
 * total confidence; a wrong "fast" costs a handful of paced requests. With a
 * working set of about a dozen queries that trade is not close.
 */
export const DEFAULT_TIER_ID = "live";

/* ── the shared half ──────────────────────────────────────────────────── */

export const apiRhythmSchema = z.preprocess(
  /*
   * The first version called this `ops` and documented it as keyed by
   * endpoint, while every writer keyed it by record type and every reader
   * looked it up as a resource. Read under the old name so nothing already
   * classified has to be paid for again.
   */
  (value) =>
    value && typeof value === "object" && !("recordTypes" in value) && "ops" in value
      ? { ...(value as Record<string, unknown>), recordTypes: (value as { ops: unknown }).ops }
      : value,
  z.object({
    /**
     * Record type id → how often new ones appear.
     *
     * By record type because that is the only thing anybody can reason about
     * — "applications arrive all day" — and projected onto the endpoints
     * that read each one when a cadence is decided. See `keeper/rhythm.ts`.
     */
    recordTypes: z.record(idSchema, volatilitySchema).default({}),
    /**
     * Why each one was read that way, in a sentence.
     *
     * Carried because this is shown to somebody who is being asked to confirm
     * it, and "Vendors: daily" with no reason is a setting to shrug at rather
     * than a claim to check. Keyed like `recordTypes`, and optional: a
     * classification with no reason is still usable.
     */
    because: z.record(idSchema, z.string().max(200)).default({}),
    /**
     * Which reading of the API this was made against — the same fingerprint
     * the categories carry — so a re-described API is read again.
     */
    fingerprint: z.string().optional(),
    at: z.string().optional(),
    version: z.number().int().min(1).optional(),
  }),
);

export type ApiRhythm = z.infer<typeof apiRhythmSchema>;

/* ── the personal half ────────────────────────────────────────────────── */

export const connectionRhythmSchema = z.object({
  version: z.literal(RHYTHM_VERSION).default(RHYTHM_VERSION),
  /** The cadences on offer. Editable; the shipped two are only a default. */
  tiers: z.array(tierSchema).min(1).max(8).default([...DEFAULT_TIERS]),
  /**
   * Endpoints this user moved, by tier id.
   *
   * Overrides only — never the whole assignment. Storing every endpoint here
   * would freeze today's classification into one person's file, so a better
   * reading of the API later would reach everybody except the people who had
   * already confirmed it once.
   */
  overrides: z.record(idSchema, idSchema).default({}),
  /** When the questions were last answered, so they are not asked again. */
  at: z.string().optional(),
});

export type ConnectionRhythm = z.infer<typeof connectionRhythmSchema>;

/** Where one endpoint lands, and why — the whole decision in one place. */
export interface TierDecision {
  readonly op: string;
  readonly tier: string;
  readonly everyMs: number;
  /** `override` beats `measured` beats `model` beats `default`. */
  readonly source: "override" | "measured" | "model" | "default";
  readonly volatility?: Volatility | undefined;
  readonly because?: string | undefined;
}

export const tierById = (
  tiers: readonly TierSpec[],
  id: string | undefined,
): TierSpec | undefined => tiers.find((tier) => tier.id === id);

/**
 * The tier one endpoint belongs to, and what decided it.
 *
 * Four layers, each outranking the one before, and the order is the design:
 *
 * 1. **default** — the fast tier, because unclassified must not mean stale.
 * 2. **model** — one call per API, shared with everybody who connects it.
 * 3. **measured** — what this account's own pulls showed. The only signal
 *    that knows whether *these* vendors change, and it costs nothing because
 *    the pulls happen anyway.
 * 4. **override** — what the person said. Never recomputed, never outranked.
 *
 * Pure, so the precedence can be read and tested without a store, a clock or
 * a model anywhere near it.
 */
export const tierFor = (input: {
  readonly op: string;
  readonly tiers: readonly TierSpec[];
  readonly overrides?: Readonly<Record<string, string>> | undefined;
  readonly measured?: Volatility | undefined;
  readonly model?: Volatility | undefined;
  readonly because?: string | undefined;
  readonly defaultTier?: string | undefined;
}): TierDecision => {
  const { op, tiers } = input;
  const fallback =
    tierById(tiers, input.defaultTier ?? DEFAULT_TIER_ID) ?? tiers[0]!;

  const chosen = input.overrides?.[op];
  const override = tierById(tiers, chosen);
  if (override) {
    return { op, tier: override.id, everyMs: override.everyMs, source: "override" };
  }

  const covering = (volatility: Volatility): TierSpec | undefined =>
    tiers.find((tier) => tier.covers.includes(volatility));

  for (const [source, volatility] of [
    ["measured", input.measured],
    ["model", input.model],
  ] as const) {
    if (!volatility) continue;
    const tier = covering(volatility);
    if (!tier) continue;
    return {
      op,
      tier: tier.id,
      everyMs: tier.everyMs,
      source,
      volatility,
      ...(source === "model" && input.because ? { because: input.because } : {}),
    };
  }

  return { op, tier: fallback.id, everyMs: fallback.everyMs, source: "default" };
};
