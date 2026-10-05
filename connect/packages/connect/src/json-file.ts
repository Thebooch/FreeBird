import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Replace a whole JSON document, or leave the old one exactly as it was.
 *
 * Written to a sibling file and renamed over the original, so a process that
 * dies mid-write leaves the previous version readable rather than half of the
 * new one. It matters most for the catalog entries onboarding checkpoints
 * after every step: a truncated entry fails to parse on the next boot and
 * takes the whole API's description with it.
 */
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* The rename consumed it, or the write never started. */
    }
  }
};
