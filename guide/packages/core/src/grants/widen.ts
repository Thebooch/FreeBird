import type { Capability, Declaration } from "./declaration.js";

/**
 * Did the declaration grow?
 *
 * Growing is the only direction that matters. Reaching for something the
 * operator never approved has to stop and ask; reaching for less than they
 * approved is always safe, so dropping a capability is not a widening and must
 * not trigger re-approval on its own.
 *
 * Note that this is *not* the whole check — a shrunk declaration over changed
 * content still needs a fresh decision. That rule lives in `evaluateGrant`,
 * which tests the digest first for exactly this reason.
 */
export const widens = (previous: Declaration, next: Declaration): boolean => {
  const approved = new Set<Capability>(previous);
  return next.some((capability) => !approved.has(capability));
};

/** The capabilities in `next` that `previous` never approved. */
export const addedCapabilities = (previous: Declaration, next: Declaration): Capability[] => {
  const approved = new Set<Capability>(previous);
  return next.filter((capability) => !approved.has(capability));
};
