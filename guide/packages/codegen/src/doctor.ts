/**
 * Repairing configuration a schema change left behind.
 *
 * The rule this exists to make keepable, borrowed from OpenClaw: **a change
 * that invalidates existing user config ships its migration in the same
 * change.** Without somewhere for that migration to live, the alternative is
 * either never bumping a schema or bumping it and breaking every install that
 * already has files on disk — and a repo whose README says "APIs may move
 * before 1.0" will do the second one by accident.
 *
 * `freebird check` already detects id drift. It cannot repair anything, and it
 * knows nothing about versions. This is the other half: read the version a
 * document declares, walk it up the ladder one rung at a time, and write the
 * result — after backing up what was there.
 *
 * Deliberately pure of I/O below {@link runDoctor}: the ladder is a list of
 * total functions from one shape to the next, which is what makes it testable
 * without a filesystem and reviewable as a diff.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One rung. `from` and `to` are always adjacent — no rung may skip. */
export interface Migration {
  readonly from: number;
  readonly to: number;
  /** What this rung would change, for `--dry-run`. One line, no side effects. */
  readonly describe: (doc: unknown) => string;
  readonly migrate: (doc: unknown) => unknown;
}

/**
 * A kind of document the doctor knows how to find and repair.
 *
 * Adding a kind is adding an entry here; nothing in `runDoctor` names any of
 * them, so a new document type does not touch the walk.
 */
export interface DocumentKind {
  readonly id: string;
  /** Human label for reports. */
  readonly label: string;
  /** Absolute paths of every document of this kind under `cwd`. */
  readonly locate: (cwd: string) => string[];
  /** The version a document declares, or null when it declares none. */
  readonly versionOf: (doc: unknown) => number | null;
  /** The version this build writes. */
  readonly current: number;
  readonly migrations: readonly Migration[];
}

// ---------------------------------------------------------------------------
// Ladders
// ---------------------------------------------------------------------------

/*
 * Both are empty, and that is the correct state today: `manifestSchema` and
 * every Dash spec are still at version 1, so there is nothing to migrate from.
 *
 * They are not placeholders. `assertLadderComplete` runs over them in the test
 * suite, so the first person to bump a schema past 1 without adding a rung
 * here gets a failing build rather than a support thread.
 */
export const MANIFEST_MIGRATIONS: readonly Migration[] = [];

export const DASH_SPEC_MIGRATIONS: readonly Migration[] = [];

// ---------------------------------------------------------------------------
// The ladder itself
// ---------------------------------------------------------------------------

const readNumber = (doc: unknown, key: string): number | null => {
  if (!doc || typeof doc !== "object") return null;
  const value = (doc as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

export const manifestVersion = (doc: unknown): number | null => readNumber(doc, "version");
export const specVersion = (doc: unknown): number | null => readNumber(doc, "specVersion");

const jsonFilesIn = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
};

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  {
    id: "manifest",
    label: "Registration manifest",
    locate: (cwd) => {
      const path = join(cwd, "freebird.manifest.json");
      return existsSync(path) ? [path] : [];
    },
    versionOf: manifestVersion,
    current: 1,
    migrations: MANIFEST_MIGRATIONS,
  },
  {
    id: "dashboard",
    label: "Dash dashboard",
    locate: (cwd) => jsonFilesIn(join(cwd, "dashboards")),
    versionOf: specVersion,
    current: 1,
    migrations: DASH_SPEC_MIGRATIONS,
  },
  {
    id: "connection",
    label: "Dash connection",
    locate: (cwd) => jsonFilesIn(join(cwd, "connections")),
    versionOf: specVersion,
    current: 1,
    migrations: DASH_SPEC_MIGRATIONS,
  },
  {
    id: "catalog",
    label: "Dash catalog overlay",
    locate: (cwd) => jsonFilesIn(join(cwd, ".dash", "catalog")),
    versionOf: specVersion,
    current: 1,
    migrations: DASH_SPEC_MIGRATIONS,
  },
];

/**
 * Every version from 1 to `current` must be reachable by adjacent rungs.
 *
 * Throws rather than returning a report: this is a build-time invariant about
 * the code, not a finding about a user's files.
 */
export const assertLadderComplete = (kind: DocumentKind): void => {
  const byFrom = new Map(kind.migrations.map((m) => [m.from, m]));
  for (const migration of kind.migrations) {
    if (migration.to !== migration.from + 1) {
      throw new Error(
        `${kind.id}: migration ${migration.from}→${migration.to} skips a version; rungs must be adjacent`,
      );
    }
  }
  for (let version = 1; version < kind.current; version += 1) {
    if (!byFrom.has(version)) {
      throw new Error(
        `${kind.id}: schema is at version ${kind.current} but nothing migrates ${version}→${version + 1}. A version bump must ship its migration.`,
      );
    }
  }
};

export type DiagnosisStatus =
  /** Already at the current version. */
  | "current"
  /** Older, and every rung needed exists. */
  | "migratable"
  /** Older, and a rung is missing — a bug in this build, not the user's file. */
  | "unreachable"
  /** Newer than this build understands. */
  | "future"
  /** Not JSON, or declares no version at all. */
  | "unreadable";

export interface Diagnosis {
  readonly kind: string;
  readonly path: string;
  readonly status: DiagnosisStatus;
  readonly from: number | null;
  readonly to: number;
  /** One line per rung that would run, in order. */
  readonly steps: string[];
  readonly message: string;
}

/** Walk one document up the ladder without touching the filesystem. */
export const diagnose = (kind: DocumentKind, path: string, doc: unknown): Diagnosis => {
  const from = kind.versionOf(doc);
  const base = { kind: kind.id, path, from, to: kind.current };

  if (from === null) {
    return {
      ...base,
      status: "unreadable",
      steps: [],
      message: `${kind.label} declares no version — it may be corrupt or hand-edited.`,
    };
  }
  if (from === kind.current) {
    return { ...base, status: "current", steps: [], message: `${kind.label} is up to date.` };
  }
  if (from > kind.current) {
    return {
      ...base,
      status: "future",
      steps: [],
      // Never "repaired" by downgrading: writing an older shape over a newer
      // one loses whatever the newer version added.
      message: `${kind.label} is version ${from}, newer than this build understands (${kind.current}). Upgrade FreeBird rather than editing the file.`,
    };
  }

  const byFrom = new Map(kind.migrations.map((m) => [m.from, m]));
  const steps: string[] = [];
  let cursor = from;
  let working = doc;
  while (cursor < kind.current) {
    const rung = byFrom.get(cursor);
    if (!rung) {
      return {
        ...base,
        status: "unreachable",
        steps,
        message: `${kind.label} is version ${cursor} and nothing migrates it to ${cursor + 1}. This is a gap in FreeBird, not in your file — please report it.`,
      };
    }
    steps.push(`${rung.from} → ${rung.to}: ${rung.describe(working)}`);
    working = rung.migrate(working);
    cursor = rung.to;
  }
  return {
    ...base,
    status: "migratable",
    steps,
    message: `${kind.label} can be migrated from version ${from} to ${kind.current}.`,
  };
};

/** Apply the ladder. Separate from {@link diagnose} so dry-run shares its walk. */
export const applyMigrations = (kind: DocumentKind, doc: unknown): unknown => {
  const byFrom = new Map(kind.migrations.map((m) => [m.from, m]));
  let cursor = kind.versionOf(doc);
  let working = doc;
  while (cursor !== null && cursor < kind.current) {
    const rung = byFrom.get(cursor);
    if (!rung) break;
    working = rung.migrate(working);
    cursor = rung.to;
  }
  return working;
};

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  readonly cwd: string;
  /** Write repairs. Without it nothing is written, whatever else is set. */
  readonly fix?: boolean;
  /** Kinds to consider. Defaults to all of them. */
  readonly kinds?: readonly DocumentKind[];
}

export interface DoctorResult {
  /** True when nothing needs attention. */
  readonly ok: boolean;
  readonly diagnoses: Diagnosis[];
  /** Paths written, and the backup each one produced. */
  readonly repaired: { path: string; backup: string }[];
  readonly messages: string[];
}

/** `<file>.bak-<version>` — names the version it holds, not the time it was taken. */
export const backupPathFor = (path: string, version: number): string =>
  `${path}.bak-${version}`;

export const runDoctor = (options: DoctorOptions): DoctorResult => {
  const kinds = options.kinds ?? DOCUMENT_KINDS;
  const diagnoses: Diagnosis[] = [];
  const repaired: { path: string; backup: string }[] = [];
  const messages: string[] = [];

  for (const kind of kinds) {
    for (const path of kind.locate(options.cwd)) {
      let raw: string;
      let doc: unknown;
      try {
        raw = readFileSync(path, "utf8");
        doc = JSON.parse(raw);
      } catch {
        diagnoses.push({
          kind: kind.id,
          path,
          status: "unreadable",
          from: null,
          to: kind.current,
          steps: [],
          message: `${kind.label} is not valid JSON.`,
        });
        continue;
      }

      const diagnosis = diagnose(kind, path, doc);
      diagnoses.push(diagnosis);
      if (diagnosis.status !== "migratable") continue;
      if (!options.fix) {
        messages.push(`would migrate ${path}: ${diagnosis.steps.join("; ")}`);
        continue;
      }

      // Back up before writing, always, and never over an existing backup —
      // running the doctor twice must not destroy the original.
      const backup = backupPathFor(path, diagnosis.from ?? 0);
      if (!existsSync(backup)) writeFileSync(backup, raw, "utf8");
      writeFileSync(
        path,
        `${JSON.stringify(applyMigrations(kind, doc), null, 2)}\n`,
        "utf8",
      );
      repaired.push({ path, backup });
      messages.push(`migrated ${path} (backup: ${backup})`);
    }
  }

  const problems = diagnoses.filter((d) => d.status !== "current");
  const unresolved = options.fix
    ? problems.filter((d) => d.status !== "migratable")
    : problems;

  if (diagnoses.length === 0) messages.push("No FreeBird documents found here.");
  else if (unresolved.length === 0 && repaired.length === 0) {
    messages.push(`✓ ${diagnoses.length} document(s) up to date.`);
  }

  return { ok: unresolved.length === 0, diagnoses, repaired, messages };
};
