/**
 * The real, public APIs in the benchmark: where each one's full data is read
 * from, by reference code, to fix its answer keys.
 *
 * Only public APIs that need no account and no key (the owner's decision at
 * checkpoint 1). The reference read is deliberately simple — one documented
 * request that returns everything, or two where the first says how many there
 * are — and shares nothing with Dash's pipeline, so an answer key never comes
 * from what is being measured.
 */

export interface RealSource {
  readonly id: string;
  /** One request that returns the whole collection — or, with `whole`, the first page. */
  readonly url: string;
  /**
   * The documented request for everything, worked out from the first answer:
   * Rick and Morty answers every id at once, and its first page says how many
   * there are. Paging through all 42 met its rate limit at page 31, and a
   * freshness check that did would spend the budget the read being measured needs.
   */
  readonly whole?: (first: unknown) => string;
  /** The records in its answer. */
  readonly records: (body: unknown) => readonly Record<string, unknown>[];
  /** The fields an answer key reads, and the only ones kept in a snapshot. */
  readonly fields: readonly string[];
}

/** One answer, as both the snapshot script and the freshness check read it. */
export type RealGet = (url: string) => Promise<{ readonly status: number; readonly text: string }>;

const at = (key: string) => (body: unknown): readonly Record<string, unknown>[] => {
  const list = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};

const field = (body: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), body);

/** Every id from 1 to the count the first page states: `…/character/1,2,3`. */
const everyId = (base: string) => (first: unknown): string => {
  const count = Number(field(first, "info", "count"));
  return `${base}/${Array.from({ length: count }, (_, index) => index + 1).join(",")}`;
};

const listOr = (key: string) => (body: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(body) ? (body as Record<string, unknown>[]) : at(key)(body);

/** An API's own counts, by what each counts: `{ id: "state:Oregon", count: 295 }`, and `{ id: "total" }`. */
const counts = (body: unknown): readonly Record<string, unknown>[] => [
  { id: "total", count: field(body, "total") },
  ...["by_state", "by_type"].flatMap((group) =>
    Object.entries((field(body, group) ?? {}) as Record<string, unknown>).map(([name, count]) => ({
      id: `${group.slice(3)}:${name}`,
      count,
    })),
  ),
];

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
  {
    id: "rickandmorty-characters",
    url: "https://rickandmortyapi.com/api/character",
    whole: everyId("https://rickandmortyapi.com/api/character"),
    records: listOr("results"),
    fields: ["id", "status"],
  },
  {
    id: "rickandmorty-episodes",
    url: "https://rickandmortyapi.com/api/episode",
    whole: everyId("https://rickandmortyapi.com/api/episode"),
    records: listOr("results"),
    fields: ["id", "air_date"],
  },
  {
    id: "pokeapi-pokemon",
    url: "https://pokeapi.co/api/v2/pokemon?limit=100000",
    /* A list entry is a name and an address; the id is the address's last part. */
    records: (body) =>
      at("results")(body).map((one) => ({ id: Number(/\/(\d+)\/?$/.exec(String(one.url))?.[1]), name: one.name })),
    fields: ["id", "name"],
  },
  {
    /* The API's own counts: the reference read of eleven thousand records is one request to what it already totals. */
    id: "openbrewerydb-counts",
    url: "https://api.openbrewerydb.org/v1/breweries/meta",
    records: counts,
    fields: ["id", "count"],
  },
  {
    id: "catfact-breeds",
    url: "https://catfact.ninja/breeds?limit=1000",
    records: (body) => at("data")(body).map((one, index) => ({ id: index + 1, ...one })),
    fields: ["id", "breed", "country"],
  },
  {
    id: "catfact-facts",
    url: "https://catfact.ninja/facts?limit=1000",
    records: (body) => at("data")(body).map((one, index) => ({ id: index + 1, ...one })),
    fields: ["id", "length"],
  },
];

/** Numbers in order, anything else by its text. */
const byId = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  typeof a.id === "number" && typeof b.id === "number" ? a.id - b.id : String(a.id).localeCompare(String(b.id));

/** A snapshot's records: only the fields an answer reads, in id order, so two reads compare as equal. */
export const minimal = (source: RealSource, body: unknown): Record<string, unknown>[] =>
  source
    .records(body)
    .map((record) => Object.fromEntries(source.fields.map((name) => [name, record[name] ?? null])))
    .sort(byId);

/** Every record: one request, or two where the first says how many there are. */
export const readSource = async (source: RealSource, get: RealGet): Promise<Record<string, unknown>[]> => {
  const read = async (url: string): Promise<unknown> => {
    const answer = await get(url);
    if (answer.status !== 200) throw new Error(`${source.id}: ${url.slice(0, 120)} answered ${answer.status}`);
    return JSON.parse(answer.text);
  };
  const first = await read(source.url);
  return minimal(source, source.whole ? await read(source.whole(first)) : first);
};
