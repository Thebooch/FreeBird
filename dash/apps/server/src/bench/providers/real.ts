import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { REAL_SOURCES, readSource } from "../real/sources.js";
import type { MockProvider } from "../types.js";

/**
 * Real, public APIs: the benchmark's third source (see PROTOCOL.md).
 *
 * Reached over the network, through the same SSRF guard the server uses,
 * restricted to each provider's own hosts. Their answer keys are computed here
 * from a snapshot of the full data (`real/snapshots/`, taken by
 * `real/snapshot.mts` with one simple documented request each), and before a
 * provider is scored the snapshot is compared with the live API: if the data
 * has changed, the scenario is reported as a stale key rather than scored.
 *
 * No account, no key — the owner's choice at checkpoint 1. Run by hand
 * (`pnpm bench --split real --live`), never in CI.
 */

const here = dirname(fileURLToPath(import.meta.url));

const snapshot = (id: string): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(join(here, "..", "real", "snapshots", `${id}.json`), "utf8")) as { records: Record<string, unknown>[] })
    .records;

const sourceOf = (id: string) => REAL_SOURCES.find((one) => one.id === id)!;

/** Whether the live API still holds what the snapshot says: null when it does, the reason when not. */
const freshnessOf =
  (ids: readonly string[]) =>
  async (http: HttpFetch): Promise<string | null> => {
    for (const id of ids) {
      const source = sourceOf(id);
      let live: Record<string, unknown>[];
      /* A short rate limit is waited out, as a board's read does: a stale key must mean changed data, not a busy API. */
      const get = async (url: string) => {
        for (let waits = 0; ; waits++) {
          const answer = await http(url, { headers: { accept: "application/json" } }, new URL(url).hostname);
          const wait = Number(answer.header("retry-after") ?? 5);
          if (answer.status !== 429 || waits >= 3 || !(wait <= 30)) return answer;
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        }
      };
      try {
        live = await readSource(source, get);
      } catch (error) {
        return `the reference read of ${id} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (JSON.stringify(live) !== JSON.stringify(snapshot(id)))
        return `${id} has changed since its snapshot was taken (${live.length} record(s) now); retake it with real/snapshot.mts`;
    }
    return null;
  };

const unreachable = (): never => {
  throw new Error("a real provider is reached over the network, not in-process");
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const products = snapshot("dummyjson-products");
const carts = snapshot("dummyjson-carts");
const todos = snapshot("jsonplaceholder-todos");

export const dummyjsonProducts: MockProvider = {
  id: "dummyjson-products",
  split: "real",
  pattern: "Real API, documented in HTML only: a product catalogue wrapped under a key, paged by limit and skip, with a total",
  hosts: ["dummyjson.com"],
  live: true,
  freshness: freshnessOf(["dummyjson-products"]),
  docsUrl: "https://dummyjson.com/docs/products",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "smartphones",
      request: "How many smartphones do we sell?",
      answer: products.filter((one) => one.category === "smartphones").length,
      tolerance: 0,
      records: products.length,
      scripted: { path: "/products", measure: { agg: "count", where: 'category == "smartphones"' } },
    },
    {
      id: "stock",
      request: "How many units do we have in stock across every product?",
      answer: products.reduce((sum, one) => sum + Number(one.stock ?? 0), 0),
      tolerance: 0,
      records: products.length,
      scripted: { path: "/products", measure: { agg: "sum", field: "stock" } },
    },
    {
      /* A comparison with a number, which a brief has no way to say yet. */
      id: "over-100",
      request: "How many of our products cost more than $100?",
      answer: products.filter((one) => Number(one.price) > 100).length,
      tolerance: 0,
      records: products.length,
      scripted: { path: "/products", measure: { agg: "count", where: "price > 100" } },
    },
  ],
};

export const dummyjsonCarts: MockProvider = {
  id: "dummyjson-carts",
  split: "real",
  pattern: "Real API, documented in HTML only: carts wrapped under a key, paged by limit and skip, money as decimals",
  hosts: ["dummyjson.com"],
  live: true,
  freshness: freshnessOf(["dummyjson-carts"]),
  docsUrl: "https://dummyjson.com/docs/carts",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "discounted-value",
      request: "What are all the carts worth after discounts?",
      answer: round2(carts.reduce((sum, one) => sum + Number(one.discountedTotal ?? 0), 0)),
      tolerance: 0.05,
      records: carts.length,
      scripted: { path: "/carts", measure: { agg: "sum", field: "discountedTotal" } },
    },
  ],
};

export const jsonplaceholderTodos: MockProvider = {
  id: "jsonplaceholder-todos",
  split: "real",
  pattern: "Real API, documented in prose on its home page: a bare list, no paging, a true/false flag",
  hosts: ["jsonplaceholder.typicode.com"],
  live: true,
  freshness: freshnessOf(["jsonplaceholder-todos"]),
  docsUrl: "https://jsonplaceholder.typicode.com/",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "done",
      request: "How many to-dos are finished?",
      answer: todos.filter((one) => one.completed === true).length,
      tolerance: 0,
      records: todos.length,
      scripted: { path: "/todos", measure: { agg: "count", where: "completed == true" } },
    },
  ],
};

/*
 * Added 2026-09-29, after every dev and real scenario passed: five more public
 * APIs, their answer keys fixed from snapshots before any integrator ran
 * against them (PROTOCOL.md). Chosen for what they differ in, not for being
 * easy: prose documentation spread over a large page, a list read in
 * forty-odd pages behind a rate limit, dates written as words, a collection of
 * eleven thousand records the API itself can filter, and an OpenAPI document.
 */

const characters = snapshot("rickandmorty-characters");
const episodes = snapshot("rickandmorty-episodes");
const pokemon = snapshot("pokeapi-pokemon");
const breweryCounts = snapshot("openbrewerydb-counts");
const breeds = snapshot("catfact-breeds");
const facts = snapshot("catfact-facts");

const countOf = (id: string): number => Number(breweryCounts.find((one) => one.id === id)?.count ?? Number.NaN);

export const rickandmortyCharacters: MockProvider = {
  id: "rickandmorty-characters",
  split: "real",
  pattern:
    "Real API, documented in HTML: 826 characters in pages of 20 found by following the answer's own next link, under a rate limit",
  hosts: ["rickandmortyapi.com"],
  live: true,
  freshness: freshnessOf(["rickandmorty-characters"]),
  docsUrl: "https://rickandmortyapi.com/documentation",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "dead",
      request: "How many characters are dead?",
      answer: characters.filter((one) => one.status === "Dead").length,
      tolerance: 0,
      records: characters.length,
      scripted: { path: "/api/character", measure: { agg: "count", where: 'status == "Dead"' } },
    },
  ],
};

export const rickandmortyEpisodes: MockProvider = {
  id: "rickandmorty-episodes",
  split: "real",
  pattern: "Real API, documented in HTML: episodes dated in words (\"December 2, 2013\"), in pages of 20",
  hosts: ["rickandmortyapi.com"],
  live: true,
  freshness: freshnessOf(["rickandmorty-episodes"]),
  docsUrl: "https://rickandmortyapi.com/documentation",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "aired-2017",
      request: "How many episodes aired in 2017?",
      answer: episodes.filter((one) => String(one.air_date).endsWith("2017")).length,
      tolerance: 0,
      records: episodes.length,
      scripted: { path: "/api/episode", measure: { agg: "count", where: 'endsWith(air_date, "2017")' } },
    },
  ],
};

export const pokeapiPokemon: MockProvider = {
  id: "pokeapi-pokemon",
  split: "real",
  pattern:
    "Real API, documented in one large HTML page: 1,351 entries of a name and an address, in pages of 20 by offset and limit, with a count",
  hosts: ["pokeapi.co"],
  live: true,
  freshness: freshnessOf(["pokeapi-pokemon"]),
  docsUrl: "https://pokeapi.co/docs/v2",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "count",
      request: "How many Pokémon are there?",
      answer: pokemon.length,
      tolerance: 0,
      records: pokemon.length,
      scripted: { path: "/api/v2/pokemon", measure: { agg: "count" } },
    },
  ],
};

export const openbrewerydb: MockProvider = {
  id: "openbrewerydb",
  split: "real",
  pattern:
    "Real API, documented in HTML on a separate host: 11,848 breweries in pages of at most 200, which the API can filter by state and type itself",
  hosts: ["api.openbrewerydb.org", "www.openbrewerydb.org"],
  live: true,
  /* The API's own counts are the key: a reference read of eleven thousand records would be one request to what it already totals. */
  freshness: freshnessOf(["openbrewerydb-counts"]),
  docsUrl: "https://www.openbrewerydb.org/documentation",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "oregon",
      request: "How many breweries are listed in Oregon?",
      answer: countOf("state:Oregon"),
      tolerance: 0,
      records: countOf("total"),
      scripted: { path: "/v1/breweries", measure: { agg: "count", where: 'state == "Oregon"' } },
    },
    {
      id: "brewpubs",
      request: "How many brewpubs are listed?",
      answer: countOf("type:brewpub"),
      tolerance: 0,
      records: countOf("total"),
      scripted: { path: "/v1/breweries", measure: { agg: "count", where: 'brewery_type == "brewpub"' } },
    },
  ],
};

export const catfact: MockProvider = {
  id: "catfact",
  split: "real",
  pattern: "Real API, documented by an OpenAPI document: breeds and facts in pages, Laravel style (current_page, next_page_url)",
  hosts: ["catfact.ninja"],
  live: true,
  freshness: freshnessOf(["catfact-breeds", "catfact-facts"]),
  docsUrl: "https://catfact.ninja/docs",
  credentials: [],
  handle: unreachable,
  objectives: [
    {
      id: "us-breeds",
      request: "How many cat breeds come from the United States?",
      answer: breeds.filter((one) => one.country === "United States").length,
      tolerance: 0,
      records: breeds.length,
      scripted: { path: "/breeds", measure: { agg: "count", where: 'country == "United States"' } },
    },
    {
      id: "long-facts",
      request: "How many cat facts are longer than 200 characters?",
      answer: facts.filter((one) => Number(one.length) > 200).length,
      tolerance: 0,
      records: facts.length,
      scripted: { path: "/facts", measure: { agg: "count", where: "length > 200" } },
    },
  ],
};
