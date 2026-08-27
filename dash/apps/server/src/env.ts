import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A `.env` loader in thirty lines, so an OSS self-hoster does not inherit a
 * dependency just to read a file of `KEY=value`.
 *
 * Two behaviours are load-bearing:
 *
 * 1. **A real environment variable always wins.** The file is a development
 *    convenience; a value exported by CI, a container, or the shell is a
 *    deliberate act and must never be silently overwritten by a stale file
 *    someone forgot was on disk.
 *
 * 2. **It searches upward.** `pnpm --filter @freebirdai/dash-server dev` runs with the
 *    working directory set to `apps/server`, but the obvious place to put a
 *    `.env` is the repo root. Walking up means both work and nobody has to
 *    know which one the process actually chose.
 */

export interface EnvFileResult {
  /** Absolute path of the file that was read, or null when none was found. */
  readonly path: string | null;
  /** Names only — values are secrets and never leave this module. */
  readonly applied: readonly string[];
  /** Present in the file but already set in the environment, so left alone. */
  readonly skipped: readonly string[];
}

/**
 * Parse `KEY=value` lines. Tolerates `export ` prefixes, `#` comments, blank
 * lines, and single or double quotes. A malformed line is skipped rather than
 * thrown on — one typo should not stop the server from booting.
 */
export const parseEnvFile = (contents: string): Record<string, string> => {
  const values: Record<string, string> = {};

  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rest] = match;
    if (!key || rest === undefined) continue;

    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      // Only double quotes get escape handling, matching shell semantics.
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // Unquoted: an inline comment ends the value.
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    values[key] = value;
  }

  return values;
};

/** Walk up from `startDir` looking for `.env`, stopping at the filesystem root. */
const findEnvFile = (startDir: string, fileName: string): string | null => {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, fileName);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
};

/**
 * Load a `.env` into `process.env` without clobbering anything already set.
 *
 * Call this before any module reads configuration — in practice, the first
 * import in the server entrypoint.
 */
export const loadEnvFile = (
  options: { startDir?: string; fileName?: string; env?: NodeJS.ProcessEnv } = {},
): EnvFileResult => {
  const fileName = options.fileName ?? ".env";
  const env = options.env ?? process.env;
  const path = findEnvFile(options.startDir ?? process.cwd(), fileName);
  if (!path) return { path: null, applied: [], skipped: [] };

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    // An empty exported var is still deliberate — treat only "unset" as free.
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { path, applied, skipped };
};
