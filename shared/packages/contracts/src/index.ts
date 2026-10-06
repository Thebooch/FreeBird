/**
 * The contracts FreeBird's products share: how a model is plugged in, and the
 * digest an approval is checked against. guide's `@freebirdai/core`, Connect
 * and Dash all build on these, so none of them has to depend on another to
 * agree on them.
 */
export * from "./llm.js";
export { canonicalize, digest } from "./digest.js";
export { sha256Hex } from "./sha256.js";
