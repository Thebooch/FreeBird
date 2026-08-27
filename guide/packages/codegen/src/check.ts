import { canonicalIds, diffIds, type IdDrift } from "@freebirdai/manifest";
import type { RegistrationManifest } from "@freebirdai/manifest";

export interface DriftReport {
  ok: boolean;
  /** Per-source drift keyed by a label ("client", "server", ...). */
  bySource: Record<string, IdDrift>;
  /** Human-readable summary lines. */
  messages: string[];
}

/**
 * Validate one or more registries' registered ids against the manifest's
 * canonical id list. This is what `freebird check` runs — it catches drift
 * between the manifest's canonical ids and what each runtime registry
 * actually registered.
 */
export const checkDrift = (
  manifest: RegistrationManifest,
  registered: Record<string, readonly string[]>,
): DriftReport => {
  const expected = canonicalIds(manifest);
  const bySource: Record<string, IdDrift> = {};
  const messages: string[] = [];
  let ok = true;
  for (const [label, ids] of Object.entries(registered)) {
    const drift = diffIds(expected, ids);
    bySource[label] = drift;
    if (drift.missing.length || drift.extra.length) {
      ok = false;
      if (drift.missing.length) {
        messages.push(`${label}: missing ${drift.missing.join(", ")}`);
      }
      if (drift.extra.length) {
        messages.push(`${label}: unexpected ${drift.extra.join(", ")}`);
      }
    }
  }
  if (ok) messages.push(`All ${expected.length} ids in sync.`);
  return { ok, bySource, messages };
};
