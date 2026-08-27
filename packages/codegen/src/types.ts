import type { RegistrationManifest } from "@freebirdai/manifest";

/**
 * Codegen turns a {@link RegistrationManifest} into the files and wiring a
 * FreeBird integration needs. It is deterministic and side-effect free — it
 * returns strings; the caller (the `freebird` CLI, or FreeBird Studio driving
 * an edit engine) decides how to write them.
 *
 * The single most important thing it generates is `freebird/ids.ts`: one
 * canonical id map imported by both the client and server registries. That
 * kills the "component ids hand-duplicated across three files" drift that
 * plagues hand-maintained integrations.
 */

/** Supported integration targets. `static` emits no code — embed-only wiring. */
export type Framework = "next" | "react" | "vue" | "static";

export interface CodegenOptions {
  framework: Framework;
  /**
   * Directory (repo-relative, POSIX) the generated `freebird/*` files live in.
   * Import paths to component sources are computed relative to this. Default
   * `"src/freebird"`.
   */
  outDir?: string;
  /**
   * Base URL the client transport points at. Default `"/freebird"`.
   */
  transportBaseUrl?: string;
}

export interface GeneratedFile {
  /** Repo-relative POSIX path. */
  path: string;
  contents: string;
}

/**
 * A wiring step that touches *existing* app files (not something codegen can
 * write deterministically). The CLI prints these; FreeBird Studio feeds them
 * to the edit engine to apply via AI. `automatable` marks append-only steps a
 * tool can safely perform without human judgement.
 */
export interface IntegrationStep {
  id: string;
  title: string;
  detail: string;
  /** True if a tool can apply this mechanically (append import, etc.). */
  automatable: boolean;
  /** Hint at the file(s) this step touches, when known. */
  targetHint?: string;
}

export interface CodegenResult {
  files: GeneratedFile[];
  steps: IntegrationStep[];
  /** Canonical, sorted component ids (matches `freebird/ids.ts`). */
  ids: string[];
  /** Non-fatal notes (e.g. dom-region entries skipped for a framework target). */
  warnings: string[];
}

export type { RegistrationManifest };
