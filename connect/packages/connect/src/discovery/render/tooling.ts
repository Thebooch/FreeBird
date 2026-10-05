import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Playwright's own Chromium, for reading documentation drawn by scripts:
 * where it is, whether it may be fetched, and fetching it.
 *
 * One engine everywhere — the version Playwright pins — never a machine's own
 * Edge or Chrome, so a page reads the same hosted, open-source and in the
 * benchmark, whatever is installed or however a machine's browser is managed.
 *
 * - **Hosted** (`DASH_RENDERER=hosted`): the server image installs it at build
 *   time (`npx playwright install --with-deps chromium`). Nobody waits, and
 *   nobody is asked.
 * - **Open source** (the default, `ask`): nothing is downloaded until a page
 *   needs it, and then only once the person agrees — about 150 MB, once. The
 *   answer is kept, so it is never asked again. A copy Playwright already
 *   keeps on this machine, for this version, is used as it is.
 * - **Off** (`DASH_RENDERER=off`): such a page is said to be unreadable.
 *
 * Where it cannot be installed — a blocked download, Linux without the
 * libraries Chromium needs — it says so in plain words, with the one command
 * that fixes it.
 */

export type RendererMode = "ask" | "hosted" | "off";

/** Whether a page drawn by scripts can be read now. */
export type RendererReadiness = "ready" | "needs-install" | "unavailable";

export interface RendererStatus {
  readonly state: "ready" | "missing" | "installing" | "failed" | "off";
  /** How far the file being downloaded has got, 0–100, while installing. */
  readonly progress?: number;
  /** Which file of the download that is: Chromium comes in more than one. */
  readonly part?: number;
  /** What stopped it, in words, with what fixes it. */
  readonly error?: string;
  /** Whether the person has agreed to the download: kept, so it is asked once. */
  readonly consented: boolean;
  /** About how much is downloaded, for the question. */
  readonly downloadMb: number;
}

/** What is downloaded, roughly: Chromium for Playwright, once. */
export const RENDERER_DOWNLOAD_MB = 150;

const INSTALL_COMMAND = "npx playwright install chromium";
const DEPS_COMMAND = "npx playwright install-deps chromium";

/** Where Playwright keeps its browsers by default, as Playwright itself decides it. */
export const playwrightCache = (): string => {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set && set !== "0") return set;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
};

/**
 * The Chromium build this version of Playwright launches headless: the folder
 * it installs it under. Its headless shell where it has one — what a headless
 * launch starts — else Chromium itself.
 */
const pinnedFolder = (packageDir: string): string | null => {
  try {
    const { browsers } = JSON.parse(readFileSync(join(packageDir, "browsers.json"), "utf8")) as {
      browsers: Array<{ name: string; revision: string }>;
    };
    const build = browsers.find((one) => one.name === "chromium-headless-shell") ?? browsers.find((one) => one.name === "chromium");
    return build ? `${build.name.replace(/-/g, "_")}-${build.revision}` : null;
  } catch {
    return null;
  }
};

/** The parts of `playwright-core` used here. */
export interface PlaywrightLike {
  readonly chromium: {
    launch(options: { headless: boolean; timeout?: number }): Promise<import("playwright-core").Browser>;
  };
}

export interface RendererToolingOptions {
  /** Where a download goes when Playwright keeps none for this version: `.dash/tooling`. */
  readonly dir: string;
  readonly mode: RendererMode;
  /** Where Playwright keeps its browsers on this machine. Playwright's own place unless a test says. */
  readonly cache?: string;
  /** Loads Playwright. The package itself unless a test supplies one. */
  readonly load?: () => Promise<PlaywrightLike | null>;
  /** Runs Playwright's installer. Its own command line unless a test supplies one. */
  readonly install?: (env: NodeJS.ProcessEnv, onProgress: (percent: number) => void) => Promise<void>;
  readonly log?: (line: string) => void;
}

const require = createRequire(import.meta.url);

/** Where `playwright-core` is, or null when it is not installed with the server. */
const packageDirOf = (): string | null => {
  try {
    return dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
};

/** Playwright's own installer, for Chromium only, into wherever `PLAYWRIGHT_BROWSERS_PATH` says. */
const runInstaller = (env: NodeJS.ProcessEnv, onProgress: (percent: number) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const packageDir = packageDirOf();
    if (!packageDir) return reject(new Error("Playwright is not installed with this server."));
    const child = spawn(process.execPath, [join(packageDir, "cli.js"), "install", "chromium"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      said = (said + text).slice(-2_000);
      for (const match of text.matchAll(/(\d{1,3})% of/g)) onProgress(Math.min(100, Number(match[1])));
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(said.trim().split("\n").slice(-3).join(" ") || `the installer stopped (${code})`))));
  });

export class RendererTooling {
  private installing: Promise<void> | null = null;
  private progress = 0;
  private part = 1;
  private failure: string | null = null;
  private playwright: Promise<PlaywrightLike | null> | null = null;

  constructor(private readonly options: RendererToolingOptions) {}

  private get consentFile(): string {
    return join(this.options.dir, "renderer.json");
  }

  /** Whether the person agreed to the download, once and for all. */
  consented(): boolean {
    if (this.options.mode === "hosted") return true;
    try {
      return (JSON.parse(readFileSync(this.consentFile, "utf8")) as { download?: string }).download === "yes";
    } catch {
      return false;
    }
  }

  /**
   * Where Chromium is, or will be: Playwright's own cache when it already
   * keeps this version's build there, else `.dash/tooling`. Decided before
   * Playwright is loaded, which reads it once.
   */
  private browsersPath(): string | null {
    const packageDir = packageDirOf();
    if (!packageDir) return null;
    const folder = pinnedFolder(packageDir);
    const cache = this.options.cache ?? playwrightCache();
    if (this.options.mode === "hosted" || (folder !== null && existsSync(join(cache, folder)))) return cache;
    return this.options.dir;
  }

  private installed(): boolean {
    const packageDir = packageDirOf();
    const path = this.browsersPath();
    const folder = packageDir ? pinnedFolder(packageDir) : null;
    return path !== null && folder !== null && existsSync(join(path, folder));
  }

  private async load(): Promise<PlaywrightLike | null> {
    if (this.options.load) return this.options.load();
    this.playwright ??= (async () => {
      const path = this.browsersPath();
      if (!path) return null;
      process.env.PLAYWRIGHT_BROWSERS_PATH = path;
      try {
        return (await import("playwright-core")) as unknown as PlaywrightLike;
      } catch {
        return null;
      }
    })();
    return this.playwright;
  }

  status(): RendererStatus {
    const base = { consented: this.consented(), downloadMb: RENDERER_DOWNLOAD_MB };
    if (this.options.mode === "off") return { ...base, state: "off" };
    if (this.installing) return { ...base, state: "installing", progress: this.progress, part: this.part };
    if (this.failure) return { ...base, state: "failed", error: this.failure };
    return { ...base, state: this.options.load || this.installed() ? "ready" : "missing" };
  }

  /**
   * Whether a page drawn by scripts can be read now. Once the person has
   * agreed, a missing browser — a new Playwright, say — is fetched again
   * without asking.
   */
  async readiness(): Promise<RendererReadiness> {
    const status = this.status();
    if (status.state === "off" || status.state === "failed") return "unavailable";
    if (status.state === "ready") return "ready";
    if (status.state === "installing") return "needs-install";
    if (this.options.mode === "hosted") {
      this.failure = `Chromium is not installed on this server. Run \`${INSTALL_COMMAND}\` when the server image is built.`;
      return "unavailable";
    }
    if (status.consented) this.install();
    return "needs-install";
  }

  /** The download, agreed to: started once, its progress kept for whoever asks. */
  install(): RendererStatus {
    if (this.options.mode === "off" || this.installing) return this.status();
    mkdirSync(this.options.dir, { recursive: true });
    writeFileSync(this.consentFile, JSON.stringify({ download: "yes", at: new Date().toISOString() }));
    if (this.installed()) return this.status();
    this.failure = null;
    this.progress = 0;
    this.part = 1;
    const path = this.browsersPath() ?? this.options.dir;
    const run = this.options.install ?? runInstaller;
    this.options.log?.(`downloading Chromium for reading documentation into ${path}`);
    this.installing = run({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: path }, (percent) => {
      /* A fall in the percentage is the next file starting, not the first going backwards. */
      if (percent + 5 < this.progress) this.part += 1;
      this.progress = percent;
    })
      .then(() => {
        this.progress = 100;
        this.options.log?.("Chromium is ready for reading documentation");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.failure = `The download did not finish (${message.slice(0, 200)}). Run \`${INSTALL_COMMAND}\` in the server's folder, or link an OpenAPI spec instead.`;
        this.options.log?.(`Chromium could not be downloaded: ${message}`);
      })
      .finally(() => {
        this.installing = null;
      });
    return this.status();
  }

  /** Playwright's Chromium, launched headless; null when it is not here yet, or cannot start. */
  async launch(): Promise<import("playwright-core").Browser | null> {
    if (this.options.mode === "off") return null;
    if (!this.options.load && !this.installed()) return null;
    const playwright = await this.load();
    if (!playwright) return null;
    try {
      return await playwright.chromium.launch({ headless: true, timeout: 30_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failure = /missing dependencies|install-deps|shared libraries/i.test(message)
        ? `Chromium cannot start on this machine: it is missing system libraries. Run \`${DEPS_COMMAND}\` once, as an administrator.`
        : `Chromium could not start (${message.split("\n")[0]?.slice(0, 200)}).`;
      this.options.log?.(this.failure);
      return null;
    }
  }
}
