/**
 * FreeBird Connect: the integration engine.
 *
 * `createConnect` is the way in: add an API, give it a key, read its records,
 * keep them fresh, and make reviewed changes. `createEngine` is the same
 * machinery for a host that serves it itself, as Dash does; what such a host
 * reaches for beyond it is in `@freebirdai/connect/host`.
 */
export * from "./adapters/index.js";
export * from "./agent/index.js";
export * from "./platform/stores.js";
export * from "./connect.js";
export { createEngine, nodeHttp, type Engine, type EngineOptions } from "./engine.js";
export type { WriteIntent, WriteReview } from "./writes/pending.js";
export type { WriteActor, WritePermission, WritePolicy, WriteScope } from "./writes/policy.js";
export type { CommitResult } from "./writes/service.js";
