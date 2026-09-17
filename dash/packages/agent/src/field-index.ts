import { fnv1a, type MappedField } from "@freebirdai/dash-spec";

export interface IndexedField {
  readonly endpoint: string;
  readonly field: MappedField;
}
export interface FieldPage {
  readonly key: string;
  readonly fields: readonly IndexedField[];
}

/** A complete index of declared fields. Paging limits prompt size, not what
 * the integration can discover. No record values or model calls belong here.
 */
export class SchemaFieldIndex {
  readonly fingerprint: string;
  private readonly entries: readonly IndexedField[];
  constructor(ops: readonly { readonly id: string; readonly fields?: readonly MappedField[] }[]) {
    if (new Set(ops.map((op) => op.id)).size !== ops.length)
      throw new Error("Schema endpoint ids must be unique.");
    this.entries = ops
      .flatMap((op) => {
        const names = new Set<string>();
        return (op.fields ?? []).map((field) => {
          if (names.has(field.name))
            throw new Error(`Duplicate schema field ${op.id}.${field.name}.`);
          names.add(field.name);
          return { endpoint: op.id, field: structuredClone(field) };
        });
      })
      .sort(
        (a, b) => a.endpoint.localeCompare(b.endpoint) || a.field.name.localeCompare(b.field.name),
      );
    this.fingerprint = fnv1a(JSON.stringify(this.entries));
  }

  search(input: { endpoint?: string; query?: string; offset?: number; limit?: number } = {}) {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid schema page bounds.");
    const query = input.query?.trim().toLocaleLowerCase();
    const matches = this.entries.filter(
      (entry) =>
        (!input.endpoint || entry.endpoint === input.endpoint) &&
        (!query ||
          [entry.field.name, entry.field.label, entry.field.description].some((value) =>
            value?.toLocaleLowerCase().includes(query),
          )),
    );
    const fields = structuredClone(matches.slice(offset, offset + limit));
    return {
      fields,
      total: matches.length,
      nextOffset: offset + fields.length < matches.length ? offset + fields.length : null,
      fingerprint: this.fingerprint,
    };
  }

  /** Every entry appears in exactly one page. Oversized declarations fail
   * explicitly rather than making the tail of a schema disappear.
   */
  pages(endpoints: readonly string[], maxFields = 160, maxCharacters = 24000): FieldPage[] {
    if (
      !Number.isSafeInteger(maxFields) ||
      maxFields < 1 ||
      !Number.isSafeInteger(maxCharacters) ||
      maxCharacters < 100
    )
      throw new Error("Invalid schema page budget.");
    const wanted = new Set(endpoints);
    const pages: FieldPage[] = [];
    let fields: IndexedField[] = [];
    let characters = 0;
    const flush = () => {
      if (fields.length) pages.push({ key: fnv1a(JSON.stringify(fields)), fields });
      fields = [];
      characters = 0;
    };
    for (const entry of this.entries) {
      if (!wanted.has(entry.endpoint)) continue;
      const size = JSON.stringify(entry).length;
      if (size > maxCharacters)
        throw new Error(
          `Schema field ${entry.endpoint}.${entry.field.name} exceeds the preparation page budget.`,
        );
      if (fields.length >= maxFields || characters + size > maxCharacters) flush();
      fields.push(structuredClone(entry));
      characters += size;
    }
    flush();
    return pages.length ? pages : [{ key: fnv1a("empty"), fields: [] }];
  }
}
