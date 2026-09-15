import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing a user reads may name somebody else's business.
 *
 * The product is one dashboard over any API, and *which* API is data — a
 * catalog entry headed for a shared database, never a word in the code. There
 * is already a guard like this over the prompts, and it was not enough:
 * prompts are not the only thing a person reads. A screen explaining what a
 * filter strip does very nearly shipped saying "what makes a vendor on a job
 * open the vendor", which is true of exactly one API and nonsense on the rest.
 *
 * Deliberately narrow about what counts. Only what is rendered — string
 * literals and the text between tags — is checked, because comments are where
 * a concrete example earns its keep: "a task's vendor's phone number" explains
 * a mechanism in one line and nobody reads it in the app.
 */

const BANNED = [
  "buildium",
  "stripe",
  "github",
  "lease",
  "tenant",
  "landlord",
  "invoice",
  "applicant",
  "property",
  "listing",
  "vendor",
  "customer",
];

/** Comments stripped, since a concrete example in one is the point of it. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

const STRINGS = /"([^"\n]{2,})"|'([^'\n]{2,})'|`([^`]{2,})`/g;
/** JSX text: what sits between a closing bracket and the next opening tag. */
const JSX_TEXT = />([^<>{}]{3,})</g;

/**
 * What a person could actually end up reading.
 *
 * An identifier is not user-facing — a variable named `property` is ordinary
 * English about objects — and flagging one would push the next person to
 * rename around the check rather than fix anything real.
 */
const readableText = (source: string): string[] => {
  const clean = withoutComments(source);
  const found: string[] = [];
  for (const match of clean.matchAll(STRINGS)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of clean.matchAll(JSX_TEXT)) found.push(match[1] ?? "");
  return found;
};

const sourcesIn = (dir: string): Array<{ file: string; text: string[] }> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ file: entry.name, text: readableText(readFileSync(path, "utf8")) }];
  });

describe("nothing a user reads names one particular API", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = sourcesIn(here);

  it("has something to check", () => {
    // A guard that silently scans nothing passes forever.
    expect(files.length).toBeGreaterThan(5);
  });

  for (const word of BANNED) {
    it(`never says "${word}"`, () => {
      const pattern = new RegExp(`\\b${word}s?\\b`, "i");
      const offenders = files.flatMap(({ file, text }) =>
        text.filter((line) => pattern.test(line)).map((line) => `${file}: ${line.trim().slice(0, 90)}`),
      );
      expect(offenders).toEqual([]);
    });
  }
});
