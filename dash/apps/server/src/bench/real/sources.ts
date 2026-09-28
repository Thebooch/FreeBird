/**
 * The real, public APIs in the benchmark: where each one's full data is read
 * from, by reference code, to fix its answer keys.
 *
 * Only public APIs that need no account and no key (the owner's decision at
 * checkpoint 1). The reference read is deliberately simple — one documented
 * request that returns everything — and shares nothing with Dash's pipeline,
 * so an answer key never comes from what is being measured.
 */

export interface RealSource {
  readonly id: string;
  /** One request that returns the whole collection. */
  readonly url: string;
  /** The records in its answer. */
  readonly records: (body: unknown) => readonly Record<string, unknown>[];
  /** The fields an answer key reads, and the only ones kept in a snapshot. */
  readonly fields: readonly string[];
}

const at = (key: string) => (body: unknown): readonly Record<string, unknown>[] => {
  const list = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};

export const REAL_SOURCES: readonly RealSource[] = [
  {
    id: "dummyjson-products",
    url: "https://dummyjson.com/products?limit=0&select=category,stock,price",
    records: at("products"),
    fields: ["id", "category", "stock", "price"],
  },
  {
    id: "dummyjson-carts",
    url: "https://dummyjson.com/carts?limit=0",
    records: at("carts"),
    fields: ["id", "discountedTotal"],
  },
  {
    id: "jsonplaceholder-todos",
    url: "https://jsonplaceholder.typicode.com/todos",
    records: (body) => (Array.isArray(body) ? (body as Record<string, unknown>[]) : []),
    fields: ["id", "completed"],
  },
];

/** A snapshot's records: only the fields an answer reads, in id order, so two reads compare as equal. */
export const minimal = (source: RealSource, body: unknown): Record<string, unknown>[] =>
  source
    .records(body)
    .map((record) => Object.fromEntries(source.fields.map((field) => [field, record[field] ?? null])))
    .sort((a, b) => Number(a.id) - Number(b.id));
