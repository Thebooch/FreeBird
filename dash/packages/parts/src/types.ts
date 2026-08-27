/**
 * A part is any unit of the product that can be swapped out: a renderer, a
 * theme, a resource definition, a catalog entry.
 *
 * The shipped defaults live in one place and are used whenever nobody has
 * replaced them. A customisation is stored as a **whole part**, not as a diff
 * against the default — so storage holds only the parts someone actually
 * changed, and reverting is deleting one record rather than reconstructing an
 * original from a patch.
 */

export type PartKind =
  | "component"
  /** How a component looks: slots, density, tokens. Pure data, never code. */
  | "presentation"
  | "theme"
  | "formatter"
  | "resource"
  | "catalog"
  | "dialect";

/** Highest wins. `builtin` ships with the product and is never written to. */
export type LayerName = "builtin" | "project" | "user";

export const LAYER_ORDER: readonly LayerName[] = ["user", "project", "builtin"];

export interface PartRef {
  readonly kind: PartKind;
  readonly id: string;
}

interface PartBase {
  readonly kind: PartKind;
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  /** Bumped by whoever edits it; shown so a stale override is visible. */
  readonly updatedAt?: string;
}

/**
 * Configuration. Safe to store and load anywhere, including a hosted service
 * serving many tenants, because nothing here executes.
 */
export interface DataPart<T = unknown> extends PartBase {
  readonly form: "data";
  readonly data: T;
}

/**
 * Code. Loaded from disk by a self-hoster who is running their own machine.
 *
 * Deliberately a module *specifier*, never a source string: this type cannot
 * express "evaluate this text", so no amount of downstream carelessness can
 * turn a stored part into `eval`. A managed registry refuses these outright —
 * running another tenant's JavaScript is a decision that needs a sandbox
 * designed for it, not a permissive default.
 */
export interface CodePart extends PartBase {
  readonly form: "code";
  readonly module: string;
}

export type Part<T = unknown> = DataPart<T> | CodePart;

export const isDataPart = <T>(part: Part<T>): part is DataPart<T> => part.form === "data";
export const isCodePart = (part: Part): part is CodePart => part.form === "code";

/** One place parts can come from. Omitting `put` marks the layer read-only. */
export interface PartLayer {
  readonly name: LayerName;
  get(ref: PartRef): Part | null;
  list(kind: PartKind): PartRef[];
  put?(part: Part): void;
  remove?(ref: PartRef): void;
}

/** Why a layer that had a part was passed over. */
export interface SkippedLayer {
  readonly layer: LayerName;
  readonly reason: "code-not-allowed";
}

export interface Resolution<T = unknown> {
  readonly part: Part<T> | null;
  readonly layer: LayerName | null;
  /** Layers that held a part but could not supply it here. */
  readonly skipped: readonly SkippedLayer[];
}

export const refKey = (ref: PartRef): string => `${ref.kind}/${ref.id}`;
