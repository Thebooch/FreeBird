export { generateIntegration } from "./generate.js";
export { buildIntegrationSteps } from "./steps.js";
export { checkDrift, type DriftReport } from "./check.js";
export {
  DASH_SPEC_MIGRATIONS,
  DOCUMENT_KINDS,
  MANIFEST_MIGRATIONS,
  applyMigrations,
  assertLadderComplete,
  backupPathFor,
  diagnose,
  manifestVersion,
  runDoctor,
  specVersion,
  type Diagnosis,
  type DiagnosisStatus,
  type DoctorOptions,
  type DoctorResult,
  type DocumentKind,
  type Migration,
} from "./doctor.js";
export { relativeImport, identFor } from "./emit.js";
export type {
  Framework,
  CodegenOptions,
  CodegenResult,
  GeneratedFile,
  IntegrationStep,
} from "./types.js";

// Re-export the drift primitives so consumers get one import surface.
export { canonicalIds, diffIds, diffManifestIds, type IdDrift } from "@freebirdai/manifest";
