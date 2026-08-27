import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Part, PartKind, PartLayer, PartRef } from "./types.js";

/** In-memory layer: the shipped defaults, and every test fixture. */
export class MemoryLayer implements PartLayer {
  private readonly parts = new Map<string, Part>();

  constructor(
    readonly name: PartLayer["name"],
    seed: readonly Part[] = [],
    private readonly writable = false,
  ) {
    for (const part of seed) this.parts.set(`${part.kind}/${part.id}`, part);
  }

  get(ref: PartRef): Part | null {
    return this.parts.get(`${ref.kind}/${ref.id}`) ?? null;
  }

  list(kind: PartKind): PartRef[] {
    return [...this.parts.values()]
      .filter((part) => part.kind === kind)
      .map((part) => ({ kind: part.kind, id: part.id }));
  }

  put(part: Part): void {
    if (!this.writable) throw new Error(`the ${this.name} layer is read-only`);
    this.parts.set(`${part.kind}/${part.id}`, part);
  }

  remove(ref: PartRef): void {
    if (!this.writable) throw new Error(`the ${this.name} layer is read-only`);
    this.parts.delete(`${ref.kind}/${ref.id}`);
  }
}

/**
 * Whole parts as JSON on disk, one file each, at `<root>/<kind>/<id>.json`.
 *
 * One file per part is what makes "only store what changed" literal: the
 * directory contains exactly the customisations, so what has been overridden
 * is answerable with `ls` and reverting is deleting a file. A hosted backend
 * swaps this for a table with the same interface and the same one-row-per-part
 * shape.
 *
 * Data parts only. A code part names a module to import, and letting one be
 * written through the same channel that accepts user input is how "stored
 * config" quietly becomes "stored code".
 */
export class FileLayer implements PartLayer {
  constructor(
    readonly name: PartLayer["name"],
    private readonly root: string,
  ) {}

  private pathFor(ref: PartRef): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(ref.id)) throw new Error(`unsafe part id "${ref.id}"`);
    return join(this.root, ref.kind, `${ref.id}.json`);
  }

  get(ref: PartRef): Part | null {
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(ref), "utf8")) as Part;
      // The filename is authoritative; a mismatched body would let one part
      // masquerade as another.
      if (parsed.kind !== ref.kind || parsed.id !== ref.id) return null;
      return parsed.form === "data" ? parsed : null;
    } catch {
      return null;
    }
  }

  list(kind: PartKind): PartRef[] {
    try {
      return readdirSync(join(this.root, kind))
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({ kind, id: name.slice(0, -5) }));
    } catch {
      return [];
    }
  }

  put(part: Part): void {
    if (part.form !== "data") {
      throw new Error("only data parts can be stored; code parts are loaded from disk");
    }
    const path = this.pathFor(part);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(part, null, 2)}\n`, "utf8");
  }

  remove(ref: PartRef): void {
    rmSync(this.pathFor(ref), { force: true });
  }
}
