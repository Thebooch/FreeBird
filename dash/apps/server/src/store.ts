import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityReport, ConnectionSpec, DashboardSpec } from "@freebirdai/dash-spec";
import { capabilityReportSchema, connectionSchema, dashboardSchema } from "@freebirdai/dash-spec";
import type { z } from "zod";
import { writeJsonAtomic } from "@freebirdai/connect/host";
import type { ConnectionRepository } from "@freebirdai/connect/host";

/**
 * Specs live as files on disk: git-friendly, diffable, reviewable in a pull
 * request. Nothing to install, and a self-hoster owns their data outright.
 *
 * Secrets never appear here — a connection carries only a `keyRef` naming an
 * entry in the encrypted vault.
 */
/**
 * Where boards, connections and their capability reports are kept. The
 * server depends on this, not on the file store below, so a
 * hosted build can keep the same shapes in its own database.
 */
export interface SpecRepository extends ConnectionRepository {
  listDashboards(): DashboardSpec[];
  getDashboard(id: string): DashboardSpec | null;
  putDashboard(spec: DashboardSpec): void;
  deleteDashboard(id: string): void;
}

/**
 * Frozen all the way down, so a spec handed to several readers cannot be
 * changed under any of them. A caller that needs a different spec builds a
 * new object and saves it; one that edits in place fails here, loudly.
 */
export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
};

interface Held {
  readonly mtimeMs: number;
  readonly size: number;
  /** The parsed spec, or null for a file that does not hold one. */
  readonly value: unknown | null;
}

export class SpecStore implements SpecRepository {
  /**
   * What each file held when it was last read, by path.
   *
   * A connection's file runs to a megabyte, and reading, parsing and checking
   * it took about 20 ms, with every other request waiting — on every widget
   * query, and several hundred times for one chat turn. A file is read again
   * only when its modified time or size says it changed, so an edit by hand
   * or by another process is still seen on the next read. The same object is
   * handed to every reader until then, which is why it is frozen.
   */
  private readonly held = new Map<string, Held>();

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

  private read<S extends z.ZodTypeAny>(dir: string, id: string, schema: S): z.output<S> | null {
    const path = join(dir, `${id}.json`);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(path);
    } catch {
      this.held.delete(path);
      return null;
    }
    const held = this.held.get(path);
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.value as z.output<S> | null;
    let value: z.output<S> | null = null;
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) value = deepFreeze(parsed.data as z.output<S>);
    } catch {
      /* Not readable, or not JSON: no spec. */
    }
    this.held.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  /** Forget what a file held: it is about to change, or has gone. */
  private forget(dir: string, id: string): void {
    this.held.delete(join(dir, `${id}.json`));
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
    return this.list(this.dashboardsDir).flatMap((id) => {
      const spec = this.read(this.dashboardsDir, id, dashboardSchema);
      return spec ? [spec] : [];
    });
  }

  getDashboard(id: string): DashboardSpec | null {
    return this.read(this.dashboardsDir, id, dashboardSchema);
  }

  putDashboard(spec: DashboardSpec): void {
    this.forget(this.dashboardsDir, spec.id);
    writeJsonAtomic(join(this.dashboardsDir, `${spec.id}.json`), {
      ...spec,
      updatedAt: new Date().toISOString(),
    });
  }

  deleteDashboard(id: string): void {
    this.forget(this.dashboardsDir, id);
    try {
      unlinkSync(join(this.dashboardsDir, `${id}.json`));
    } catch {
      /* already gone */
    }
  }

  listConnections(): ConnectionSpec[] {
    return this.list(this.connectionsDir).flatMap((id) => {
      const spec = this.read(this.connectionsDir, id, connectionSchema);
      return spec ? [spec] : [];
    });
  }

  getConnection(id: string): ConnectionSpec | null {
    return this.read(this.connectionsDir, id, connectionSchema);
  }

  putConnection(spec: ConnectionSpec): void {
    this.forget(this.connectionsDir, spec.id);
    writeJsonAtomic(join(this.connectionsDir, `${spec.id}.json`), {
      ...spec,
      updatedAt: new Date().toISOString(),
    });
  }

  deleteConnection(id: string): void {
    this.forget(this.connectionsDir, id);
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
    return this.list(dir).flatMap((id) => {
      const report = this.read(dir, id, capabilityReportSchema);
      return report ? [report] : [];
    });
  }

  getReport(connectionId: string): CapabilityReport | null {
    if (!this.reportsDir) return null;
    return this.read(this.reportsDir, connectionId, capabilityReportSchema);
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
    this.forget(this.reportsDir, report.connection);
    writeJsonAtomic(join(this.reportsDir, `${report.connection}.json`), next);
    return next;
  }

  deleteReport(connectionId: string): void {
    if (!this.reportsDir) return;
    this.forget(this.reportsDir, connectionId);
    try {
      unlinkSync(join(this.reportsDir, `${connectionId}.json`));
    } catch {
      /* already gone */
    }
  }
}
