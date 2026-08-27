import {
  LAYER_ORDER,
  type LayerName,
  type Part,
  type PartKind,
  type PartLayer,
  type PartRef,
  type Resolution,
  type SkippedLayer,
  refKey,
} from "./types.js";

export interface RegistryOptions {
  /**
   * Whether code parts may be supplied.
   *
   * False for a hosted service: executing another tenant's JavaScript needs a
   * sandbox designed for it. A blocked part does not blank the feature — the
   * next layer down answers, which is almost always the shipped default — and
   * the block is reported so the interface can say the customisation is not
   * available here rather than pretending it was applied.
   */
  readonly allowCode?: boolean;
}

export interface ListedPart {
  readonly ref: PartRef;
  readonly layer: LayerName;
  /** True when something above `builtin` is supplying it. */
  readonly customised: boolean;
}

/**
 * Resolves a part through its layers: user, then project, then builtin.
 *
 * The defaults live in exactly one place. Anything not overridden falls
 * through to them, so storage only ever holds what somebody deliberately
 * changed, and "revert to default" is a delete.
 */
export class PartRegistry {
  private readonly byName = new Map<LayerName, PartLayer>();

  constructor(
    layers: readonly PartLayer[],
    private readonly options: RegistryOptions = {},
  ) {
    for (const layer of layers) this.byName.set(layer.name, layer);
  }

  private get allowCode(): boolean {
    return this.options.allowCode ?? false;
  }

  /** The full picture: what answered, from where, and what was passed over. */
  resolve<T = unknown>(ref: PartRef): Resolution<T> {
    const skipped: SkippedLayer[] = [];

    for (const name of LAYER_ORDER) {
      const part = this.byName.get(name)?.get(ref) ?? null;
      if (!part) continue;
      if (part.form === "code" && !this.allowCode) {
        skipped.push({ layer: name, reason: "code-not-allowed" });
        continue;
      }
      return { part: part as Part<T>, layer: name, skipped };
    }
    return { part: null, layer: null, skipped };
  }

  /** Just the part, for the common case. */
  get<T = unknown>(ref: PartRef): Part<T> | null {
    return this.resolve<T>(ref).part;
  }

  /** The `data` of a data part, or null. Code parts never yield data. */
  data<T>(ref: PartRef): T | null {
    const part = this.get<T>(ref);
    return part && part.form === "data" ? part.data : null;
  }

  layerOf(ref: PartRef): LayerName | null {
    return this.resolve(ref).layer;
  }

  /** Whether something other than the shipped default is in effect. */
  isCustomised(ref: PartRef): boolean {
    const layer = this.layerOf(ref);
    return layer !== null && layer !== "builtin";
  }

  /** Every part of a kind, deduplicated across layers, with its origin. */
  list(kind: PartKind): ListedPart[] {
    const seen = new Map<string, ListedPart>();
    for (const name of LAYER_ORDER) {
      for (const ref of this.byName.get(name)?.list(kind) ?? []) {
        const key = refKey(ref);
        if (seen.has(key)) continue;
        const resolved = this.resolve(ref);
        if (!resolved.layer) continue;
        seen.set(key, {
          ref,
          layer: resolved.layer,
          customised: resolved.layer !== "builtin",
        });
      }
    }
    return [...seen.values()];
  }

  /** Store a whole part in the highest writable layer. */
  put(part: Part, layer: LayerName = "user"): void {
    const target = this.byName.get(layer);
    if (!target?.put) throw new Error(`the ${layer} layer cannot be written to`);
    target.put(part);
  }

  /**
   * Drop the override so the layer below answers again.
   *
   * Possible only because an override is a whole part: there is no patch to
   * unwind, just a record to delete.
   */
  revert(ref: PartRef, layer: LayerName = "user"): void {
    this.byName.get(layer)?.remove?.(ref);
  }
}
