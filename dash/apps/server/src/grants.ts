import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  connectionCapability,
  createGrant,
  digest,
  evaluateGrant,
  opCapability,
  type Capability,
  type Grant,
  type GrantEvaluation,
} from "@freebirdai/core";
import type { DashboardSpec, WidgetSpec } from "@freebirdai/dash-spec";

/**
 * Which saved bindings are allowed to run.
 *
 * A widget spec is authored by the agent and approved by a person, and until
 * now nothing connected the two: an approved widget stayed approved through
 * every later edit, including edits the approver never saw. That is the same
 * hole OpenClaw closes by freezing a grant to the bytes it was given for, and
 * the fix is the same — record the digest of what was approved, and refuse to
 * run anything that no longer hashes to it.
 *
 * Note what this is *not*. `POST /api/query` is the operator's own generic
 * endpoint: it names a connection and an op, carries no widget reference, and
 * anyone who can call it is already the operator. The boundary here is not
 * "who may fetch" but "which stored specs may execute" — which is exactly the
 * agent-writes/human-approves threat this is for.
 */

/** One file, a map of subject to grant: diffable and reviewable like the specs. */
export class GrantStore {
  private cache: Record<string, Grant> | null = null;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  private all(): Record<string, Grant> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Grant>;
      this.cache = raw && typeof raw === "object" ? raw : {};
    } catch {
      // Missing or malformed: an unreadable grant file must fail closed to
      // "nothing is approved", never open to "everything is".
      this.cache = {};
    }
    return this.cache;
  }

  private flush(): void {
    writeFileSync(this.file, `${JSON.stringify(this.all(), null, 2)}\n`, "utf8");
  }

  read(subject: string): Grant | null {
    return this.all()[subject] ?? null;
  }

  put(grant: Grant): void {
    this.all()[grant.subject] = grant;
    this.flush();
  }

  revoke(subject: string): void {
    delete this.all()[subject];
    this.flush();
  }

  /** Drop every grant for a board — used when the board itself is deleted. */
  revokeDashboard(dashboardId: string): void {
    const prefix = `widget:${dashboardId}/`;
    const all = this.all();
    for (const subject of Object.keys(all)) {
      if (subject.startsWith(prefix)) delete all[subject];
    }
    this.flush();
  }
}

/** Identity of one saved widget binding. */
export const widgetGrantSubject = (dashboardId: string, widgetId: string): string =>
  `widget:${dashboardId}/${widgetId}`;

/**
 * The data a widget can reach.
 *
 * Every endpoint it reads, single-source or multi. The connection is named
 * alongside each op so an approval reads as "this API, these endpoints"
 * rather than an op id whose owner has to be inferred.
 */
export const widgetDeclaration = (widget: WidgetSpec): Capability[] => {
  const sources = widget.source ? [widget.source] : widget.sources;
  const capabilities: Capability[] = [];
  for (const source of sources) {
    capabilities.push(connectionCapability(source.connection));
    capabilities.push(opCapability(source.connection, source.op));
  }
  return capabilities;
};

/**
 * What a widget hashes to.
 *
 * The whole spec, deliberately. A pipeline edit cannot reach data the source
 * does not already expose, but it can change every number on the board, and
 * "the figures moved and nobody approved it" is the failure this exists to
 * prevent — not only "it read something new".
 */
export const widgetDigest = (widget: WidgetSpec): string => digest(widget);

/** Does a live grant cover this widget as it is currently stored? */
export const evaluateWidget = (
  grants: GrantStore,
  dashboardId: string,
  widget: WidgetSpec,
): GrantEvaluation =>
  evaluateGrant({
    existing: grants.read(widgetGrantSubject(dashboardId, widget.id)),
    digest: widgetDigest(widget),
    declaration: widgetDeclaration(widget),
  });

/** Record approval of a widget exactly as it stands now. */
export const approveWidget = (
  grants: GrantStore,
  dashboardId: string,
  widget: WidgetSpec,
  grantedBy?: string,
): Grant => {
  const grant = createGrant({
    subject: widgetGrantSubject(dashboardId, widget.id),
    digest: widgetDigest(widget),
    declaration: widgetDeclaration(widget),
    ...(grantedBy === undefined ? {} : { grantedBy }),
  });
  grants.put(grant);
  return grant;
};

export interface WidgetApproval {
  readonly widget: string;
  readonly verdict: GrantEvaluation["verdict"];
  /** Capabilities the approver has not seen. Only set when widened. */
  readonly added: Capability[];
  /** What approving it now would cover, for the confirmation card. */
  readonly declaration: Capability[];
}

/**
 * Approval state for every widget on a board, in the order they appear.
 *
 * Returned alongside the board rather than baked into the widgets so the spec
 * on the wire stays exactly the spec on disk — a client that ignores this
 * field still receives a valid `DashboardSpec`.
 */
export const dashboardApprovals = (
  grants: GrantStore,
  dashboard: DashboardSpec,
): WidgetApproval[] =>
  dashboard.widgets.map((widget) => {
    const evaluation = evaluateWidget(grants, dashboard.id, widget);
    return {
      widget: widget.id,
      verdict: evaluation.verdict,
      added: evaluation.added,
      declaration: widgetDeclaration(widget),
    };
  });
