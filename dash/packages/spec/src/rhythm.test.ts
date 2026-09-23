import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERS,
  connectionRhythmSchema,
  tierFor,
  tierSchema,
  type TierSpec,
} from "./rhythm.js";
import { catalogEntrySchema } from "./dialect.js";

/**
 * Which cadence an endpoint is asked on, and who decided.
 *
 * The precedence is the whole design: a person's choice outranks what we
 * measured, which outranks what a model guessed, which outranks the default.
 * Everything else here guards the two directions that cost something — an
 * unclassified endpoint must not go quiet, and one somebody moved must never
 * be moved back by a better reading.
 */

const tiers = [...DEFAULT_TIERS];
const live = tiers.find((tier) => tier.id === "live")!;
const daily = tiers.find((tier) => tier.id === "daily")!;

describe("tierFor", () => {
  /* Stale-but-confident is a worse failure than a few paced requests. */
  it("puts an endpoint nobody has classified on the quick tier", () => {
    const decision = tierFor({ op: "vendors", tiers });
    expect(decision).toMatchObject({ tier: "live", source: "default", everyMs: live.everyMs });
  });

  it("follows the model where it has an opinion", () => {
    expect(tierFor({ op: "vendors", tiers, model: "rare" })).toMatchObject({
      tier: "daily",
      source: "model",
      volatility: "rare",
    });
    expect(tierFor({ op: "charges", tiers, model: "constant" })).toMatchObject({
      tier: "live",
      source: "model",
    });
  });

  /* The only signal that knows whether *these* vendors change. It costs
   * nothing, because the pulls happen anyway. */
  it("prefers what was measured over what was guessed", () => {
    expect(
      tierFor({ op: "vendors", tiers, model: "constant", measured: "rare" }),
    ).toMatchObject({ tier: "daily", source: "measured" });
  });

  it("lets the person outrank both", () => {
    expect(
      tierFor({
        op: "vendors",
        tiers,
        model: "constant",
        measured: "constant",
        overrides: { vendors: "daily" },
      }),
    ).toMatchObject({ tier: "daily", source: "override" });
  });

  it("carries the reason only for the model's own reading", () => {
    const fromModel = tierFor({
      op: "applicants",
      tiers,
      model: "constant",
      because: "new applications arrive all day",
    });
    expect(fromModel.because).toBe("new applications arrive all day");
    /* A choice does not need justifying to the person who made it. */
    expect(
      tierFor({ op: "applicants", tiers, model: "constant", because: "x", overrides: { applicants: "daily" } })
        .because,
    ).toBeUndefined();
  });

  it("ignores an override naming a cadence that no longer exists", () => {
    expect(tierFor({ op: "vendors", tiers, overrides: { vendors: "hourly" } })).toMatchObject({
      source: "default",
    });
  });

  /* Tiers are data. A deployment that wants an hourly one adds it, and
   * nothing in the resolution assumes there are two. */
  it("works with cadences nobody shipped", () => {
    const custom: TierSpec[] = [
      tierSchema.parse({ id: "hourly", title: "Hourly", everyMs: 3_600_000, covers: ["daily"] }),
      tierSchema.parse({ id: "weekly", title: "Weekly", everyMs: 604_800_000, covers: ["rare"] }),
    ];
    expect(tierFor({ op: "x", tiers: custom, model: "rare" })).toMatchObject({
      tier: "weekly",
      everyMs: 604_800_000,
    });
    /* No tier covers "constant" here, so it falls through to the default —
     * which is also absent, so the first tier stands in rather than nothing. */
    expect(tierFor({ op: "y", tiers: custom, model: "constant" }).source).toBe("default");
  });

  it("refuses a cadence faster than a minute", () => {
    expect(
      tierSchema.safeParse({ id: "spam", title: "Constantly", everyMs: 1_000 }).success,
    ).toBe(false);
  });
});

describe("what is stored", () => {
  it("gives a connection nobody has answered for the shipped cadences", () => {
    const parsed = connectionRhythmSchema.parse({});
    expect(parsed.tiers.map((tier) => tier.id)).toEqual(["live", "daily"]);
    expect(parsed.overrides).toEqual({});
  });

  it("keeps overrides and cadences apart from the shared reading", () => {
    const parsed = connectionRhythmSchema.parse({
      overrides: { vendors: "daily" },
      at: "2026-09-22T00:00:00.000Z",
    });
    expect(parsed.overrides).toEqual({ vendors: "daily" });
    /* The classification itself is not here: it is a fact about the API. */
    expect(parsed).not.toHaveProperty("ops");
  });

  it("carries the API's reading on the catalog entry, keyed by record type", () => {
    const entry = catalogEntrySchema.parse({
      id: "acme",
      title: "Acme",
      baseUrl: "https://api.example.com",
      dialect: {},
      rhythm: {
        recordTypes: { applicant: "constant", vendor: "rare" },
        because: { applicant: "new applications arrive all day" },
        at: "2026-09-22T00:00:00.000Z",
      },
    });
    expect(entry.rhythm?.recordTypes).toEqual({ applicant: "constant", vendor: "rare" });
  });

  /* The first version stored this as `ops`; nothing classified then should
   * have to be paid for again. */
  it("reads a reading stored under its first name", () => {
    const entry = catalogEntrySchema.parse({
      id: "acme",
      title: "Acme",
      baseUrl: "https://api.example.com",
      dialect: {},
      rhythm: { ops: { applicant: "constant" } },
    });
    expect(entry.rhythm?.recordTypes).toEqual({ applicant: "constant" });
  });

  it("parses an entry nobody has read for rhythm", () => {
    const entry = catalogEntrySchema.parse({
      id: "acme",
      title: "Acme",
      baseUrl: "https://api.example.com",
      dialect: {},
    });
    expect(entry.rhythm).toBeUndefined();
  });

  it("keeps the two shipped cadences a day and ten minutes apart", () => {
    expect(live.everyMs).toBe(10 * 60_000);
    expect(daily.everyMs).toBe(24 * 60 * 60_000);
  });
});
