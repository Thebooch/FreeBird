// ---------------------------------------------------------------------------
// Registration Manifest schema + parsing
// ---------------------------------------------------------------------------
export {
  registrationManifestSchema,
  manifestComponentSchema,
  manifestComponentKindSchema,
  manifestSourceSchema,
  manifestFieldSchema,
  manifestKnowledgeItemSchema,
  manifestKnowledgeSourceSchema,
  manifestActionSchema,
  manifestActionArgSchema,
  manifestServerBehaviorSchema,
  localDomDirectiveSchema,
  parseManifest,
  safeParseManifest,
  type RegistrationManifest,
  type ManifestComponent,
  type ManifestComponentKind,
  type ManifestSource,
  type ManifestField,
  type ManifestKnowledgeItem,
  type ManifestKnowledgeSource,
  type ManifestAction,
  type ManifestActionArg,
  type ManifestServerBehavior,
  type LocalDomDirective,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Canonical ids + drift detection
// ---------------------------------------------------------------------------
export { canonicalIds, diffIds, diffManifestIds, type IdDrift } from "./ids.js";

// ---------------------------------------------------------------------------
// Local-DOM action wire contract (shared with @freebirdai/embed)
// ---------------------------------------------------------------------------
export {
  LOCAL_ACTION_RESULT_KIND,
  localActionResultSchema,
  isLocalActionResult,
  buildLocalActionResult,
  type LocalActionResult,
} from "./local-action.js";

// ---------------------------------------------------------------------------
// Manifest merging (scanner / WP push upserts)
// ---------------------------------------------------------------------------
export { mergeManifests } from "./merge.js";

// ---------------------------------------------------------------------------
// Compiler: manifest → live server ComponentRegistry
// ---------------------------------------------------------------------------
export {
  compileServerRegistry,
  normalizeKnowledgeItem,
  DEFAULT_MANIFEST_GRID,
  hmacSha256Hex,
  type CompileManifestHooks,
  type ResolvedWebhook,
} from "./compile.js";
