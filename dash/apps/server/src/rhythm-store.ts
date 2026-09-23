import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionRhythm } from "@freebirdai/dash-spec";
import { DEFAULT_TIERS, connectionRhythmSchema } from "@freebirdai/dash-spec";
import { writeJsonAtomic } from "./json-file.js";

/**
 * How often *this* account wants each endpoint asked again.
 *
 * Kept beside the narrowings rather than in the catalog, and the split is the
 * same one those draw. The catalog says "new applications arrive all day",
 * which is true of Buildium for everybody who connects it. This says "and I
 * want them every ten minutes, but I do not care when the vendor list was last
 * read" — which is true of one person, and would be wrong to hand to the next.
 *
 * Not on the `ConnectionSpec` either, though it is per connection: the spec is
 * a git-friendly file somebody reviews, and this changes whenever a person
 * ticks a box. Mixing the two would make a reviewable artifact noisy with
 * preferences.
 *
 * Small enough to hold whole — one file per connection, a handful of
 * overrides each — and read per lookup, so a person editing one by hand is a
 * supported way to fix a wrong answer.
 */
export class RhythmStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(connection: string): string {
    return join(this.dir, `${connection}.json`);
  }

  /**
   * What this connection has been set to, or the shipped default.
   *
   * Never null: a connection nobody has answered for still has cadences, and
   * making every caller handle "no rhythm yet" would spread that default
   * across the codebase instead of keeping it in one place.
   */
  get(connection: string): ConnectionRhythm {
    const file = this.path(connection);
    if (!existsSync(file)) return connectionRhythmSchema.parse({ tiers: [...DEFAULT_TIERS] });
    try {
      const parsed = connectionRhythmSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success
        ? parsed.data
        : connectionRhythmSchema.parse({ tiers: [...DEFAULT_TIERS] });
    } catch {
      /*
       * A damaged file costs the overrides and nothing else — everything
       * falls back to the classification and the shipped cadences, which is
       * the behaviour before anybody answered. Refusing to start over a file
       * of preferences would be a far worse trade.
       */
      return connectionRhythmSchema.parse({ tiers: [...DEFAULT_TIERS] });
    }
  }

  put(connection: string, rhythm: ConnectionRhythm): ConnectionRhythm {
    const stored = connectionRhythmSchema.parse({
      ...rhythm,
      at: new Date().toISOString(),
    });
    writeJsonAtomic(this.path(connection), stored);
    return stored;
  }

  /** Move one endpoint, leaving everything else as it was. */
  override(connection: string, op: string, tier: string | null): ConnectionRhythm {
    const current = this.get(connection);
    const overrides = { ...current.overrides };
    /*
     * Null removes rather than storing a tier that happens to match the
     * classification today. An override is a statement that this person
     * disagrees; recording agreement would freeze a reading that a better
     * pass should be free to improve.
     */
    if (tier === null) delete overrides[op];
    else overrides[op] = tier;
    return this.put(connection, { ...current, overrides });
  }
}
