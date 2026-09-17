import type { Completeness, EntityRef, IntegrationEntity } from "./integration.js";

/** Consumer presentation contract shared by pages, search and relationship lists.
 * Retrieval plans and evidence remain in the inspector's describe contract.
 */
export interface RecordFieldView {
  id: string;
  label: string;
  description?: string;
  format?: IntegrationEntity["fields"][number]["format"];
  value: unknown;
  advanced: boolean;
  reference?: EntityRef;
}
export interface RecordSummary {
  ref: EntityRef | null;
  title: string;
  fields: RecordFieldView[];
}
/** Controls apply to loaded records; they do not imply an upstream filter contract. */
export interface RecordFilterView {
  field: string;
  label: string;
  description?: string;
}
export interface RecordRelationshipView {
  relationship: string;
  direction: "forward" | "reverse";
  title: string;
  description?: string;
  cardinality: "one" | "many";
  available: boolean;
  preferred: boolean;
}
export interface RelatedRecordViews {
  status:
    | "ok"
    | "absent"
    | "missing"
    | "denied"
    | "unsupported"
    | "ambiguous"
    | "limit"
    | "invalid"
    | "unavailable";
  records: RecordSummary[];
  filters?: RecordFilterView[];
  completeness?: Completeness;
  message?: string;
}
export interface RecordPageData extends RecordSummary {
  version: string;
  entityTitle: string;
  description?: string;
  relationships: RecordRelationshipView[];
  references: { relationship: string; result: RelatedRecordViews }[];
}
export interface EntityCollectionView {
  entity: string;
  title: string;
  description?: string;
  version: string;
  records: RecordSummary[];
  filters: RecordFilterView[];
  completeness: Completeness;
}
export interface EntityCatalogEntry {
  id: string;
  title: string;
  description?: string;
  browsable: boolean;
}
