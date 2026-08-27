import type { RegistrationManifest } from "./schema.js";

/**
 * The canonical, sorted component-id list for a manifest. This is the single
 * source of truth registries are validated against — the manifest-era
 * replacement for hand-maintained `FREEBIRD_COMPONENT_IDS` arrays.
 */
export const canonicalIds = (manifest: RegistrationManifest): string[] =>
  [...new Set(manifest.components.map((c) => c.id))].sort();

export interface IdDrift {
  /** Ids expected by the manifest but absent from the registry. */
  missing: string[];
  /** Ids present in the registry but unknown to the manifest. */
  extra: string[];
}

/** Compare an expected id list against what actually got registered. */
export const diffIds = (
  expected: readonly string[],
  actual: readonly string[],
): IdDrift => {
  const want = new Set(expected);
  const have = new Set(actual);
  return {
    missing: [...want].filter((id) => !have.has(id)).sort(),
    extra: [...have].filter((id) => !want.has(id)).sort(),
  };
};

/** Convenience: drift between a manifest and a registry's registered ids. */
export const diffManifestIds = (
  manifest: RegistrationManifest,
  registeredIds: readonly string[],
): IdDrift => diffIds(canonicalIds(manifest), registeredIds);
