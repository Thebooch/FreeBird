import type { CapabilityReport, ConnectionSpec } from "@freebirdai/connect-spec";

/**
 * Where saved connections and their capability reports live.
 *
 * The half of Dash's spec store the engine reads. Dash's `SpecRepository`
 * extends it with boards.
 */
export interface ConnectionRepository {
  listConnections(): ConnectionSpec[];
  getConnection(id: string): ConnectionSpec | null;
  putConnection(spec: ConnectionSpec): void;
  deleteConnection(id: string): void;
  listReports(): CapabilityReport[];
  getReport(connectionId: string): CapabilityReport | null;
  putReport(report: CapabilityReport): CapabilityReport;
  deleteReport(connectionId: string): void;
}
