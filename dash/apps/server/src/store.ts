import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityReport, ConnectionSpec, DashboardSpec } from "@freebirdai/dash-spec";
import { capabilityReportSchema, connectionSchema, dashboardSchema } from "@freebirdai/dash-spec";

/**
 * Specs live as files on disk: git-friendly, diffable, reviewable in a pull
 * request. Nothing to install, and a self-hoster owns their data outright.
 *
 * Secrets never appear here — a connection carries only a `keyRef` naming an
 * entry in the encrypted vault.
 */
export class SpecStore {
  constructor(
    private readonly dashboardsDir: string,
    private readonly connectionsDir: string,
    /**
     * Capability reports. Optional so existing callers (and tests) that only
     * care about specs keep working; when absent, report reads return null and
     * writes are dropped rather than throwing.
     */
    private readonly reportsDir?: string,
  ) {
    mkdirSync(dashboardsDir, { recursive: true });
    mkdirSync(connectionsDir, { recursive: true });
    if (reportsDir) mkdirSync(reportsDir, { recursive: true });
  }

  private read<T>(dir: string, id: string): unknown | null {
    try {
      return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  private list(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5));
    } catch {
      return [];
    }
  }

  listDashboards(): DashboardSpec[] {
    return this.list(this.dashboardsDir)
      .map((id) => dashboardSchema.safeParse(this.read(this.dashboardsDir, id)))
      .flatMap((result) => (result.success ? [result.data] : []));
  }

  getDashboard(id: string): DashboardSpec | null {
    const parsed = dashboardSchema.safeParse(this.read(this.dashboardsDir, id));
    return parsed.success ? parsed.data : null;
  }

  putDashboard(spec: DashboardSpec): void {
    writeFileSync(
      join(this.dashboardsDir, `${spec.id}.json`),
      `${JSON.stringify({ ...spec, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  deleteDashboard(id: string): void {
    try {
      unlinkSync(join(this.dashboardsDir, `${id}.json`));
    } catch {
      /* already gone */
    }
  }

  listConnections(): ConnectionSpec[] {
    return this.list(this.connectionsDir)
      .map((id) => connectionSchema.safeParse(this.read(this.connectionsDir, id)))
      .flatMap((result) => (result.success ? [result.data] : []));
  }

  getConnection(id: string): ConnectionSpec | null {
    const parsed = connectionSchema.safeParse(this.read(this.connectionsDir, id));
    return parsed.success ? parsed.data : null;
  }

  putConnection(spec: ConnectionSpec): void {
    writeFileSync(
      join(this.connectionsDir, `${spec.id}.json`),
      `${JSON.stringify({ ...spec, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }

  deleteConnection(id: string): void {
    try {
      unlinkSync(join(this.connectionsDir, `${id}.json`));
    } catch {
      /* already gone */
    }
  }

  /* ── capability reports ────────────────────────────────────────────── */

  listReports(): CapabilityReport[] {
    if (!this.reportsDir) return [];
    const dir = this.reportsDir;
    return this.list(dir)
      .map((id) => capabilityReportSchema.safeParse(this.read(dir, id)))
      .flatMap((result) => (result.success ? [result.data] : []));
  }

  getReport(connectionId: string): CapabilityReport | null {
    if (!this.reportsDir) return null;
    const parsed = capabilityReportSchema.safeParse(this.read(this.reportsDir, connectionId));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Write a report, bumping its revision past whatever is already on disk.
   *
   * The caller does not have to know the current revision — reading it here
   * means two writers cannot both think they are revision 4.
   */
  putReport(report: CapabilityReport): CapabilityReport {
    if (!this.reportsDir) return report;
    const previous = this.getReport(report.connection);
    const next: CapabilityReport = {
      ...report,
      revision: (previous?.revision ?? 0) + 1,
    };
    writeFileSync(
      join(this.reportsDir, `${report.connection}.json`),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    return next;
  }

  deleteReport(connectionId: string): void {
    if (!this.reportsDir) return;
    try {
      unlinkSync(join(this.reportsDir, `${connectionId}.json`));
    } catch {
      /* already gone */
    }
  }
}
