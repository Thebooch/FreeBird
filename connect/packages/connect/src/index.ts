/**
 * FreeBird Connect: the integration engine.
 *
 * Phase 2 of the split moved the code here as it was; the engine's own
 * `createConnect` API arrives in phase 4. Until then the source adapters and
 * the mapping agent are exported here, and everything else is reached by
 * path (`@freebirdai/connect/discovery/index`, `.../writes/service`, …).
 */
export * from "./adapters/index.js";
export * from "./agent/index.js";
