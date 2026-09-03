import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_KINDS,
  applyMigrations,
  assertLadderComplete,
  backupPathFor,
  diagnose,
  runDoctor,
  specVersion,
  type DocumentKind,
  type Migration,
} from "./doctor.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "freebird-doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The invariant this whole file exists to protect
// ---------------------------------------------------------------------------

describe("the ladder is complete", () => {
  it("every shipped document kind can be migrated to its current version", () => {
    // The rule: a schema bump ships its migration in the same change. This is
    // what turns that from a convention into a failing build.
    for (const kind of DOCUMENT_KINDS) {
      expect(() => assertLadderComplete(kind), kind.id).not.toThrow();
    }
  });

  it("catches a version bumped without a migration", () => {
    const orphan: DocumentKind = {
      ...DOCUMENT_KINDS[0]!,
      id: "orphan",
      current: 2,
      migrations: [],
    };
    expect(() => assertLadderComplete(orphan)).toThrow(/must ship its migration/);
  });

  it("catches a rung that skips a version", () => {
    const skipping: DocumentKind = {
      ...DOCUMENT_KINDS[0]!,
      id: "skipping",
      current: 3,
      migrations: [
        { from: 1, to: 3, describe: () => "leap", migrate: (d) => d },
      ],
    };
    expect(() => assertLadderComplete(skipping)).toThrow(/skips a version/);
  });
});

// ---------------------------------------------------------------------------
// Walking the ladder
// ---------------------------------------------------------------------------

/** A two-rung kind, so the walk is exercised even while the real ones are flat. */
const renameThing: Migration = {
  from: 1,
  to: 2,
  describe: () => "rename `thing` to `widget`",
  migrate: (doc) => {
    const { thing, ...rest } = doc as Record<string, unknown>;
    return { ...rest, widget: thing, specVersion: 2 };
  },
};

const addDefault: Migration = {
  from: 2,
  to: 3,
  describe: () => "add `mode: \"auto\"`",
  migrate: (doc) => ({ ...(doc as Record<string, unknown>), mode: "auto", specVersion: 3 }),
};

const testKind = (cwd: string): DocumentKind => ({
  id: "test",
  label: "Test document",
  locate: () => {
    const path = join(cwd, "thing.json");
    return existsSync(path) ? [path] : [];
  },
  versionOf: specVersion,
  current: 3,
  migrations: [renameThing, addDefault],
});

describe("diagnose", () => {
  const kind = () => testKind(dir);

  it("says current when the version already matches", () => {
    const result = diagnose(kind(), "/x.json", { specVersion: 3 });
    expect(result.status).toBe("current");
    expect(result.steps).toEqual([]);
  });

  it("lists every rung it would climb, in order", () => {
    const result = diagnose(kind(), "/x.json", { specVersion: 1, thing: "a" });
    expect(result.status).toBe("migratable");
    expect(result.steps).toEqual([
      "1 → 2: rename `thing` to `widget`",
      '2 → 3: add `mode: "auto"`',
    ]);
  });

  it("refuses to touch a document from a newer build", () => {
    const result = diagnose(kind(), "/x.json", { specVersion: 9 });
    expect(result.status).toBe("future");
    // Downgrading would silently drop whatever version 9 added.
    expect(result.message).toContain("Upgrade FreeBird");
  });

  it("reports a missing rung as FreeBird's gap, not the user's", () => {
    const gapped: DocumentKind = { ...kind(), current: 3, migrations: [renameThing] };
    const result = diagnose(gapped, "/x.json", { specVersion: 1, thing: "a" });
    expect(result.status).toBe("unreachable");
    expect(result.message).toContain("not in your file");
  });

  it("reports a document that declares no version", () => {
    expect(diagnose(kind(), "/x.json", { hello: 1 }).status).toBe("unreadable");
  });
});

describe("applyMigrations", () => {
  it("produces the shape the last rung leaves behind", () => {
    expect(applyMigrations(testKind(dir), { specVersion: 1, thing: "a" })).toEqual({
      specVersion: 3,
      widget: "a",
      mode: "auto",
    });
  });
});

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

const writeThing = (doc: unknown) =>
  writeFileSync(join(dir, "thing.json"), JSON.stringify(doc, null, 2), "utf8");

describe("runDoctor", () => {
  it("reports without writing when --fix is absent", () => {
    writeThing({ specVersion: 1, thing: "a" });
    const result = runDoctor({ cwd: dir, kinds: [testKind(dir)] });

    expect(result.ok).toBe(false);
    expect(result.repaired).toEqual([]);
    expect(result.messages.join(" ")).toContain("would migrate");
    // Untouched on disk.
    expect(JSON.parse(readFileSync(join(dir, "thing.json"), "utf8"))).toEqual({
      specVersion: 1,
      thing: "a",
    });
    expect(existsSync(backupPathFor(join(dir, "thing.json"), 1))).toBe(false);
  });

  it("migrates and backs up with --fix", () => {
    writeThing({ specVersion: 1, thing: "a" });
    const result = runDoctor({ cwd: dir, fix: true, kinds: [testKind(dir)] });

    expect(result.ok).toBe(true);
    expect(result.repaired).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "thing.json"), "utf8"))).toEqual({
      specVersion: 3,
      widget: "a",
      mode: "auto",
    });
    // The backup holds the original, and names the version it holds.
    const backup = backupPathFor(join(dir, "thing.json"), 1);
    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual({ specVersion: 1, thing: "a" });
  });

  it("is idempotent, and a second run does not clobber the first backup", () => {
    writeThing({ specVersion: 1, thing: "a" });
    runDoctor({ cwd: dir, fix: true, kinds: [testKind(dir)] });
    const afterFirst = readFileSync(join(dir, "thing.json"), "utf8");

    const second = runDoctor({ cwd: dir, fix: true, kinds: [testKind(dir)] });
    expect(second.ok).toBe(true);
    expect(second.repaired).toEqual([]);
    expect(readFileSync(join(dir, "thing.json"), "utf8")).toBe(afterFirst);
    // Still the original, not the migrated copy.
    expect(JSON.parse(readFileSync(backupPathFor(join(dir, "thing.json"), 1), "utf8"))).toEqual({
      specVersion: 1,
      thing: "a",
    });
  });

  it("passes a document that is already current", () => {
    writeThing({ specVersion: 3, widget: "a", mode: "auto" });
    const result = runDoctor({ cwd: dir, kinds: [testKind(dir)] });
    expect(result.ok).toBe(true);
    expect(result.messages.join(" ")).toContain("up to date");
  });

  it("does not repair a future document even with --fix", () => {
    writeThing({ specVersion: 9 });
    const result = runDoctor({ cwd: dir, fix: true, kinds: [testKind(dir)] });
    expect(result.ok).toBe(false);
    expect(result.repaired).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "thing.json"), "utf8"))).toEqual({ specVersion: 9 });
  });

  it("reports malformed JSON without crashing", () => {
    writeFileSync(join(dir, "thing.json"), "{ not json", "utf8");
    const result = runDoctor({ cwd: dir, kinds: [testKind(dir)] });
    expect(result.ok).toBe(false);
    expect(result.diagnoses[0]?.status).toBe("unreadable");
  });

  it("says so plainly when there is nothing to look at", () => {
    const result = runDoctor({ cwd: dir, kinds: [testKind(dir)] });
    expect(result.ok).toBe(true);
    expect(result.messages.join(" ")).toContain("No FreeBird documents");
  });

  it("finds the real document kinds where they actually live", () => {
    // Guards the locators against a directory rename going unnoticed.
    writeFileSync(
      join(dir, "freebird.manifest.json"),
      JSON.stringify({ version: 1, components: [] }),
      "utf8",
    );
    mkdirSync(join(dir, "dashboards"), { recursive: true });
    writeFileSync(join(dir, "dashboards", "ops.json"), JSON.stringify({ specVersion: 1 }), "utf8");
    mkdirSync(join(dir, "connections"), { recursive: true });
    writeFileSync(join(dir, "connections", "api.json"), JSON.stringify({ specVersion: 1 }), "utf8");

    const result = runDoctor({ cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.diagnoses.map((d) => d.kind).sort()).toEqual([
      "connection",
      "dashboard",
      "manifest",
    ]);
    expect(result.diagnoses.every((d) => d.status === "current")).toBe(true);
  });
});
