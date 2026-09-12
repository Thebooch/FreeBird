import { createHash, randomUUID } from "node:crypto";
import type { ResolvedParams, WidgetSpec, ConnectionSpec } from "@freebirdai/dash-spec";
import { fingerprintConnection, widgetSources, interpolateValue } from "@freebirdai/dash-spec";
import { executeWidget } from "@freebirdai/dash-runtime";
import { evalPath, parsePath } from "@freebirdai/dash-expr";
import type { CacheStore } from "../cache/store.js";

export type PreviewStatus = "checked" | "empty" | "partial" | "invalid" | "unchecked";
export interface PreviewCheck {
  status: PreviewStatus;
  errors: readonly string[];
  warnings: readonly string[];
}
export interface PreviewReceipt {
  as: string;
  receipt: string;
}
// Presentation-only changes and the build clock do not invalidate data evidence.
const signature = ({
  title: _title,
  producedBy: _producer,
  drilldown: _detail,
  ...widget
}: WidgetSpec) => createHash("sha256").update(JSON.stringify(widget)).digest("hex");

/** Check the exact compiled draft against responses already fetched by its preview. No upstream reads. */
export class SetupPreviews {
  matches(left: WidgetSpec, right: WidgetSpec): boolean {
    return signature(left) === signature(right);
  }
  private readonly receipts = new Map<
    string,
    {
      key: string;
      storedAt: number;
      connection: string;
      op: string;
      fingerprint: string;
      params: ResolvedParams;
      overrides: Readonly<Record<string, string | number | boolean>>;
      at: number;
    }
  >();
  private readonly checks = new Map<
    string,
    { check: PreviewCheck; receipts: readonly string[]; at: number }
  >();
  constructor(
    private readonly cache: CacheStore,
    private readonly connection: (id: string) => ConnectionSpec | null,
    private readonly now = Date.now,
  ) {}
  record(
    key: string,
    connection: ConnectionSpec,
    op: string,
    params: ResolvedParams,
    overrides: Readonly<Record<string, string | number | boolean>> = {},
  ): string {
    const id = randomUUID();
    this.receipts.set(id, {
      key,
      storedAt: this.cache.get(key)?.storedAt ?? -1,
      connection: connection.id,
      op,
      fingerprint: fingerprintConnection(connection),
      params,
      overrides,
      at: this.now(),
    });
    while (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value!);
    return id;
  }
  private read(id: string) {
    const receipt = this.receipts.get(id);
    if (!receipt || this.now() - receipt.at > 600_000) return null;
    const connection = this.connection(receipt.connection);
    if (!connection || fingerprintConnection(connection) !== receipt.fingerprint) return null;
    const entry = this.cache.get(receipt.key);
    return entry && entry.storedAt === receipt.storedAt ? { ...receipt, entry } : null;
  }
  status(widget: WidgetSpec): PreviewCheck {
    const found = this.checks.get(signature(widget));
    if (!found || this.now() - found.at > 600_000 || found.receipts.some((id) => !this.read(id)))
      return {
        status: "unchecked",
        errors: ["Wait for the current preview to be checked before adding this widget."],
        warnings: [],
      };
    return found.check;
  }
  validate(
    widget: WidgetSpec,
    receipts: readonly PreviewReceipt[],
    timeZone: string,
  ): PreviewCheck {
    const errors: string[] = [];
    const warnings: string[] = [];
    const bodies: Record<string, unknown> = {};
    let params: ResolvedParams | undefined;
    let partial = false;
    for (const source of widgetSources(widget)) {
      const entries = receipts
        .filter((item) => item.as === source.as)
        .map((item) => this.read(item.receipt));
      if (
        entries.length === 0 ||
        entries.some(
          (item) => !item || item.connection !== source.connection || item.op !== source.op,
        )
      ) {
        errors.push(`The current preview for ${source.op} is missing or expired.`);
        continue;
      }
      for (const value of entries) {
        if (!value) continue;
        const sent = { ...value.params.filters, ...value.overrides };
        for (const [name, expected] of Object.entries(source.params)) {
          const resolved = interpolateValue(expected, value.params);
          if (String(sent[name] ?? "") !== String(resolved))
            errors.push(`The preview used different inputs for ${source.op}. Refresh it.`);
        }
        params ??= value.params;
        partial ||= value.entry.meta.truncated || value.entry.meta.completeness?.status === "partial" || value.entry.meta.warnings.length > 0;
        warnings.push(...value.entry.meta.warnings);
        const existing = bodies[source.as];
        bodies[source.as] =
          existing === undefined
            ? value.entry.body
            : [
                ...(Array.isArray(existing) ? existing : [existing]),
                ...(Array.isArray(value.entry.body) ? value.entry.body : [value.entry.body]),
              ];
      }
    }
    let check: PreviewCheck;
    for (const source of widgetSources(widget)) {
      const extract = (widget.source ? widget.pipeline : source.pipeline).find(
        (step) => step.op === "extract",
      );
      if (extract?.op === "extract" && bodies[source.as] !== undefined) {
        try {
          if (evalPath(parsePath(extract.path), bodies[source.as]).length === 0)
            errors.push(`The response does not contain the declared row path ${extract.path}.`);
        } catch {
          errors.push(`The preview could not read the declared row path ${extract.path}.`);
        }
      }
    }
    if (errors.length || !params) check = { status: "unchecked", errors, warnings };
    else {
      const result = executeWidget(
        widget,
        widget.sources.length ? bodies : Object.values(bodies)[0],
        { now: this.now(), params, timeZone },
      );
      errors.push(
        ...result.errors,
        ...(result.rows.length ? (result.binding?.errors.map((entry) => entry.message) ?? []) : []),
      );
      if (result.meta?.coercionFailures)
        errors.push(`${result.meta.coercionFailures} value(s) could not be converted.`);
      warnings.push(...(result.meta?.warnings ?? []));
      partial ||= warnings.length > 0;
      check = {
        status: errors.length
          ? "invalid"
          : partial
            ? "partial"
            : result.rows.length
              ? "checked"
              : "empty",
        errors,
        warnings,
      };
    }
    this.checks.set(signature(widget), {
      check,
      receipts: receipts.map((entry) => entry.receipt),
      at: this.now(),
    });
    while (this.checks.size > 256) this.checks.delete(this.checks.keys().next().value!);
    return check;
  }
  failure(widgets: readonly WidgetSpec[]): string | null {
    for (const widget of widgets) {
      const check = this.status(widget);
      if (check.status !== "checked" && check.status !== "empty" && check.status !== "partial")
        return check.errors.join("; ") || "The preview needs checking.";
    }
    return null;
  }
}
