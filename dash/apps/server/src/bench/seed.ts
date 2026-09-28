import type { BenchRequest, BenchResponse } from "./types.js";

/**
 * Deterministic data for the benchmark's providers.
 *
 * mulberry32: small, fast, and the same sequence on every machine, so an
 * answer key computed today is the answer tomorrow.
 */
export const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const pick = <T>(next: () => number, items: readonly T[]): T =>
  items[Math.floor(next() * items.length)]!;

/** Money in cents, as an integer, so reference sums are exact. */
export const cents = (next: () => number, min: number, max: number): number =>
  Math.round((min + next() * (max - min)) * 100);

/** A date within the year before `end`, as an ISO string. */
export const isoWithin = (next: () => number, end: number, days: number): string =>
  new Date(end - Math.floor(next() * days * 86_400_000)).toISOString();

export const BENCH_NOW = Date.UTC(2026, 8, 1);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): BenchResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body,
});

export const html = (body: string): BenchResponse => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body,
});

export const notFound = (): BenchResponse => json({ error: "not found" }, 404);

export const bearerOf = (request: BenchRequest): string | null => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

export const intParam = (request: BenchRequest, name: string, fallback: number): number => {
  const raw = request.url.searchParams.get(name);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Sum of cents, back in major units, rounded to the cent. */
export const major = (centsTotal: number): number => Math.round(centsTotal) / 100;
