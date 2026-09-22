import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Replace a complete document: an interrupted write leaves the previous checkpoint readable. */
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* rename consumed it, or the write never started */
    }
  }
};
