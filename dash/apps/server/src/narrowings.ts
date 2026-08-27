import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Narrowing } from "@freebirdai/dash-spec";
import { narrowingFileSchema } from "@freebirdai/dash-spec";

/**
 * What a person has confirmed a phrase means, per connection.
 *
 * Kept beside the capability report rather than in the catalog, and the split
 * is deliberate. The catalog is the shareable artifact — map an API once,
 * everyone downloads it — and these are not shareable: "Maintenance",
 * "Turnover", "General Inquiry" are words whoever set *this* account up chose,
 * and they mean nothing on somebody else's. The half that does travel is which
 * *field* carries the distinction, which the map records as a facet.
 *
 * Small enough to hold whole. A connection accumulates a handful of these over
 * its life, not thousands, and reading the file per lookup keeps the on-disk
 * copy the only truth — which matters because a person editing one by hand is
 * a supported way to fix a wrong answer.
 */
export class NarrowingStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(connection: string): string {
    return join(this.dir, `${connection}.json`);
  }

  /** Everything confirmed for one connection. Empty when nothing has been. */
  list(connection: string): Narrowing[] {
    const file = this.path(connection);
    if (!existsSync(file)) return [];
    try {
      const parsed = narrowingFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? [...parsed.data.narrowings] : [];
    } catch {
      /*
       * A damaged file costs the saved answers and nothing else — the
       * questions get asked again, which is the behaviour before any of this
       * existed. Refusing to start over a file of cached confirmations would
       * be a far worse trade.
       */
      return [];
    }
  }

  /**
   * Record a confirmation, replacing any earlier one for the same phrase.
   *
   * Replacing rather than appending is what lets a person correct themselves.
   * An answer that could only ever be added to would make the first attempt
   * permanent, and the first attempt is exactly the one most likely to be
   * wrong — it is the one made before seeing any records.
   */
  put(connection: string, narrowing: Narrowing): Narrowing[] {
    const existing = this.list(connection).filter(
      (entry) =>
        !(
          entry.op === narrowing.op &&
          entry.phrase.trim().toLowerCase() === narrowing.phrase.trim().toLowerCase()
        ),
    );
    const next = [...existing, narrowing];
    const file = narrowingFileSchema.parse({ connection, narrowings: next });
    writeFileSync(this.path(connection), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return next;
  }

  /** Forget one, by endpoint and phrase. Returns whether anything went. */
  remove(connection: string, input: { op: string; phrase: string }): boolean {
    const before = this.list(connection);
    const after = before.filter(
      (entry) =>
        !(
          entry.op === input.op &&
          entry.phrase.trim().toLowerCase() === input.phrase.trim().toLowerCase()
        ),
    );
    if (after.length === before.length) return false;
    const file = narrowingFileSchema.parse({ connection, narrowings: after });
    writeFileSync(this.path(connection), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return true;
  }
}
