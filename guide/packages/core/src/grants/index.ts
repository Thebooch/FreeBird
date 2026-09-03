export { canonicalize, digest } from "./digest.js";
export { sha256Hex } from "./sha256.js";
export {
  normalizeDeclaration,
  actionCapability,
  connectionCapability,
  opCapability,
  type Capability,
  type Declaration,
} from "./declaration.js";
export { widens, addedCapabilities } from "./widen.js";
export {
  createGrant,
  evaluateGrant,
  isGranted,
  type EvaluateGrantInput,
  type Grant,
  type GrantEvaluation,
  type GrantVerdict,
} from "./grant.js";
