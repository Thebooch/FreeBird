import type { Framework } from "@freebirdai/codegen";

/**
 * Detect the integration target from a project's package.json contents plus a
 * flag for whether a bare index.html exists. Kept pure so it's unit-testable
 * without touching the filesystem.
 */
export const detectFramework = (
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null,
  hasIndexHtml: boolean,
): Framework => {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  if (deps["next"]) return "next";
  if (deps["vue"]) return "vue";
  if (deps["react"]) return "react";
  if (hasIndexHtml) return "static";
  // No obvious framework and no HTML entry — default to static embed, the
  // lowest-assumption target.
  return "static";
};

/**
 * Extract the component ids a generated registry file references via
 * `FREEBIRD_IDS.<name>`. Used by `freebird check` to detect drift between the
 * client registry, server registry, and the canonical id list without
 * executing any project code.
 */
export const idsReferencedIn = (source: string): string[] => {
  const ids = new Set<string>();
  const re = /FREEBIRD_IDS\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) ids.add(m[1]!);
  return [...ids].sort();
};

/**
 * Extract the id *keys* declared in a generated `ids.ts` file's FREEBIRD_IDS
 * map (the identifier keys, which mirror the component ids for valid ids).
 */
export const idsDeclaredIn = (idsFileSource: string): string[] => {
  const body = idsFileSource.match(/FREEBIRD_IDS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!body) return [];
  const ids = new Set<string>();
  const re = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body[1]!)) !== null) ids.add(m[1]!);
  return [...ids].sort();
};
