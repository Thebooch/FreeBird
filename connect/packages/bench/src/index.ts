/**
 * The engine's test bed: mock APIs written to the benchmark's protocol, each
 * with an answer key fixed before anything runs, the transport that serves
 * them, and the public APIs the real split reads. FreeBird Dash scores its
 * whole path against these (`dash/apps/server/src/bench`); the engine's own
 * tests drive them directly.
 */
export * from "./types.js";
export * from "./seed.js";
export * from "./transport.js";
export * from "./connectors.js";
export * from "./oauth.js";
export * from "./providers/index.js";
