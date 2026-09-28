import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpFetch } from "@freebirdai/dash-adapters";
import { REAL_SOURCES, minimal } from "../real/sources.js";
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
      const url = new URL(source.url);
      const answer = await http(source.url, { headers: { accept: "application/json" } }, url.hostname);
      if (answer.status !== 200) return `the reference read of ${id} answered ${answer.status}`;
      const live = minimal(source, JSON.parse(answer.text));
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
