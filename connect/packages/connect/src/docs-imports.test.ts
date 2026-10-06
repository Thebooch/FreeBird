import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every import a Connect guide tells somebody to write resolves.
 *
 * An integration guide is followed to the letter, often by an AI assistant,
 * so a path the package does not export is a broken integration on the first
 * try. This reads every README and AGENTS.md under `connect/packages`, and the
 * docs site's Connect pages, and checks each `@freebirdai/connect…` specifier
 * against the `exports` of the package it names.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");
const repo = join(packages, "..", "..");

const exportsOf = new Map<string, Set<string>>();
for (const dir of readdirSync(packages)) {
  const manifest = join(packages, dir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; exports?: Record<string, unknown> };
  exportsOf.set(pkg.name, new Set(Object.keys(pkg.exports ?? { ".": {} })));
}

const docs = [
  ...readdirSync(packages).flatMap((dir) =>
    ["README.md", "AGENTS.md"].map((file) => join(packages, dir, file)).filter((path) => existsSync(path)),
  ),
  ...["overview.md"].map((file) => join(repo, "docs", "docs", "connect", file)).filter((path) => existsSync(path)),
];

/** `@freebirdai/connect-server/express` → the package and the subpath it asks for. */
const split = (specifier: string): { name: string; subpath: string } => {
  const [scope, name, ...rest] = specifier.split("/");
  return { name: `${scope}/${name}`, subpath: rest.length > 0 ? `./${rest.join("/")}` : "." };
};

describe("the Connect guides' imports", () => {
  it("are found in some guide", () => {
    expect(docs.length).toBeGreaterThan(5);
  });

  for (const path of docs) {
    it(`resolve: ${path.slice(repo.length + 1)}`, () => {
      const text = readFileSync(path, "utf8");
      const specifiers = [...text.matchAll(/@freebirdai\/connect(?:-[a-z]+)?(?:\/[a-z][a-z0-9-]*)*/g)].map((m) => m[0]);
      const broken = specifiers.filter((specifier) => {
        const { name, subpath } = split(specifier);
        const exported = exportsOf.get(name);
        return exported !== undefined && !exported.has(subpath) && ![...exported].some((key) => key.endsWith("/*") && subpath.startsWith(key.slice(0, -1)));
      });
      expect(broken).toEqual([]);
    });
  }
});
