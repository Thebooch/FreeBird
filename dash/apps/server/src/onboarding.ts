import { randomUUID } from "node:crypto";
import {
  analyzeOnboarding,
  describeEntities,
  designOnboardingCategory,
  inferShape,
  onboardingFingerprint,
} from "@freebirdai/dash-agent";
import type { LlmAdapter, OnboardingMetadata } from "@freebirdai/dash-agent";
import {
  ONBOARDING_CONNECTION,
  dashboardSchema,
  deriveResourceModel,
  fingerprintConnection,
  fnv1a,
  getOp,
  missingInputs,
  onboardingChoicesSchema,
  opDefSchema,
  resolveRange,
  widgetSources,
} from "@freebirdai/dash-spec";
import type {
  ConnectionOnboarding,
  ConnectionSpec,
  DashboardSpec,
  IntegrationOnboarding,
  OnboardingChoices,
  OnboardingPreview,
  OnboardingStatus,
  OnboardingVerification,
  ResolvedParams,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { AdapterError } from "@freebirdai/dash-adapters";
import type { FetchResult } from "@freebirdai/dash-adapters";
import { compilePlan, executeWidget, runPipeline } from "@freebirdai/dash-runtime";
import type { IntegrationStore } from "./catalog.js";
import type { SpecStore } from "./store.js";

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export interface OnboardingDeps {
  store: SpecStore;
  catalog?: IntegrationStore | undefined;
  llm: () => LlmAdapter | null;
  read: (
    connection: ConnectionSpec,
    op: string,
    values: Record<string, string | number | boolean>,
    params: ResolvedParams,
  ) => Promise<FetchResult>;
}

/** Rewrite references, never arbitrary prose or user data. */
export const instantiateOnboardingWidget = (
  widget: WidgetSpec,
  connection: string,
  id: string,
): WidgetSpec => {
  const copy = structuredClone(widget);
  copy.id = id;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.connection === ONBOARDING_CONNECTION) object.connection = connection;
    Object.values(object).forEach(visit);
  };
  visit(copy);
  return copy;
};

export const assembleOnboarding = (
  template: IntegrationOnboarding,
  connection: ConnectionSpec,
  choices: OnboardingChoices,
  verified: readonly OnboardingVerification[],
  operation: string,
): DashboardSpec[] => {
  const selected = template.categories.filter((category) =>
    choices.categoryIds.includes(category.id),
  );
  const sets =
    choices.organization === "combined" ? [selected] : selected.map((category) => [category]);
  return sets.flatMap((categories, boardIndex) => {
    const widgets: WidgetSpec[] = [];
    const cells: DashboardSpec["layout"]["cells"] = [];
    let offset = 0;
    for (const category of categories) {
      const usable = category.widgets.filter((widget) =>
        verified.some(
          (one) =>
            one.categoryId === category.id && one.widgetId === widget.id && one.status === "ready",
        ),
      );
      const idMap = new Map(
        usable.map((widget, index) => [
          widget.id,
          `c${template.categories.indexOf(category)}-w${index}`,
        ]),
      );
      widgets.push(
        ...usable.map((widget) =>
          instantiateOnboardingWidget(widget, connection.id, idMap.get(widget.id)!),
        ),
      );
      const placed = category.layout.cells
        .filter((cell) => idMap.has(cell.widgetId))
        .map((cell) => ({
          ...cell,
          widgetId: idMap.get(cell.widgetId)!,
          y: cell.y + offset,
          locked: false,
        }));
      cells.push(...placed);
      offset = placed.reduce((bottom, cell) => Math.max(bottom, cell.y + cell.h + 1), offset);
    }
    if (!widgets.length) return [];
    if (cells.some((cell) => cell.y > 200))
      throw new OnboardingError(
        "These categories exceed one tab's layout capacity. Choose separate tabs.",
      );
    return [
      dashboardSchema.parse({
        id: `onboard-${operation}-${boardIndex}`,
        title:
          selected.length === 1 || choices.organization === "separate"
            ? categories[0]!.title
            : connection.title,
        description: `Starting dashboard for ${connection.title}`,
        widgets,
        layout: { gridCols: 12, cells },
      }),
    ];
  });
};

const reasonOf = (error: unknown): Pick<OnboardingVerification, "status" | "message"> => {
  if (error instanceof AdapterError)
    return {
      status:
        error.status === 401
          ? "credentials"
          : error.status === 403
            ? "denied"
            : error.status === 404
              ? "unavailable"
              : "transient",
      // Do not persist upstream response bodies, URLs, or customer records.
      message:
        error.status === 401
          ? "Reconnect this account to verify access."
          : error.status === 403
            ? "This account cannot access a required endpoint."
            : error.status === 404
              ? "A required endpoint is unavailable."
              : "The API could not be checked. Retry when it is available.",
    };
  return { status: "schema", message: "The returned data could not be validated for this widget." };
};

export class OnboardingService {
  private readonly locks = new Set<string>();
  constructor(private readonly deps: OnboardingDeps) {}

  private connection(id: string): ConnectionSpec {
    const connection = this.deps.store.getConnection(id);
    if (!connection) throw new OnboardingError("No such connection.", 404);
    return connection;
  }
  private metadata(connection: ConnectionSpec): OnboardingMetadata {
    const entry = connection.catalog ? this.deps.catalog?.get(connection.catalog) : null;
    return {
      title: entry?.title ?? connection.title,
      ops: entry ? entry.ops.map((op) => opDefSchema.parse(op)) : connection.ops,
      resources: entry?.resources ?? connection.resources,
      entities: entry?.entities ?? connection.onboarding?.localEntities ?? [],
    };
  }
  private template(connection: ConnectionSpec): IntegrationOnboarding | undefined {
    return (
      (connection.catalog ? this.deps.catalog?.get(connection.catalog)?.onboarding : undefined) ??
      connection.onboarding?.template
    );
  }
  private save(id: string, patch: Partial<ConnectionOnboarding>): void {
    const current = this.connection(id);
    this.deps.store.putConnection({
      ...current,
      onboarding: { status: "pending", dashboardIds: [], ...current.onboarding, ...patch },
    });
  }
  private saveTemplate(id: string, template: IntegrationOnboarding): void {
    const connection = this.connection(id);
    const entry = connection.catalog ? this.deps.catalog?.get(connection.catalog) : null;
    if (entry && this.deps.catalog) this.deps.catalog.put({ ...entry, onboarding: template });
    else this.save(id, { template });
  }
  private fingerprint(connection: ConnectionSpec, template: IntegrationOnboarding): string {
    return fnv1a(
      JSON.stringify({
        connection: fingerprintConnection(connection),
        credentials: connection.credentialsRevision ?? 0,
        template,
        metadata: onboardingFingerprint(this.metadata(connection)),
        choices: connection.onboarding?.choices,
      }),
    );
  }
  private async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.locks.has(key))
      throw new OnboardingError("Setup is already running. Check its progress shortly.");
    this.locks.add(key);
    try {
      return await run();
    } finally {
      this.locks.delete(key);
    }
  }
  status(id: string): OnboardingStatus {
    const connection = this.connection(id),
      metadata = this.metadata(connection),
      template = this.template(connection);
    const ready =
      metadata.ops.length > 0 && metadata.resources.length > 0 && metadata.entities.length > 0;
    return {
      template: template ?? null,
      state: connection.onboarding ?? null,
      stale: Boolean(template && template.fingerprint !== onboardingFingerprint(metadata)),
      canPrepare: Boolean(this.deps.llm()) && (ready || !connection.catalog),
      ...(!ready
        ? {
            reason:
              "Finish mapping endpoints and describing record types before preparing dashboards.",
          }
        : !this.deps.llm()
          ? { reason: "Add an AI key to prepare missing dashboard templates." }
          : {}),
    };
  }
  async prepare(id: string): Promise<OnboardingStatus> {
    const initial = this.connection(id);
    return this.locked(`integration:${initial.catalog ?? id}`, async () => {
      let connection = this.connection(id),
        metadata = this.metadata(connection);
      const existing = this.template(connection);
      if (
        existing?.fingerprint === onboardingFingerprint(metadata) &&
        existing.categories.every((category) => category.status === "ready")
      )
        return this.status(id);
      const llm = this.deps.llm();
      if (!llm) throw new OnboardingError("Add an AI key to prepare dashboard templates.");
      if (!connection.catalog && !metadata.entities.length) {
        const resources = metadata.resources.length
          ? [...metadata.resources]
          : deriveResourceModel(connection.ops);
        const result = await describeEntities(llm, {
          apiTitle: connection.title,
          ops: connection.ops,
          resources,
        });
        this.deps.store.putConnection({ ...connection, resources });
        this.save(id, { localEntities: [...result.entities] });
        connection = this.connection(id);
        metadata = this.metadata(connection);
      }
      if (!metadata.entities.length || !metadata.resources.length)
        throw new OnboardingError("Finish describing this integration's record types first.");
      let template =
        existing?.fingerprint === onboardingFingerprint(metadata)
          ? existing
          : await analyzeOnboarding(llm, metadata);
      this.saveTemplate(id, template);
      this.save(id, { status: "choosing", templateRevision: template.revision });
      // One category per request: durable checkpoints also bound each request's model budget.
      const category =
        template.categories.find((one) => one.status === "pending") ??
        template.categories.find((one) => one.status === "failed");
      if (category) {
        try {
          const next = await designOnboardingCategory(llm, metadata, category);
          template = {
            ...template,
            categories: template.categories.map((one) => (one.id === category.id ? next : one)),
          };
        } catch {
          template = {
            ...template,
            categories: template.categories.map((one) =>
              one.id === category.id
                ? {
                    ...one,
                    status: "failed" as const,
                    error: "This category could not be prepared. Retry to continue.",
                  }
                : one,
            ),
          };
        }
        // Never publish templates prepared against an integration changed during the call.
        if (onboardingFingerprint(this.metadata(this.connection(id))) !== template.fingerprint)
          throw new OnboardingError("Integration changed during preparation. Retry setup.");
        this.saveTemplate(id, template);
      }
      return this.status(id);
    });
  }
  choose(id: string, value: unknown): OnboardingStatus {
    const connection = this.connection(id),
      template = this.template(connection);
    if (["creating", "complete"].includes(connection.onboarding?.status ?? ""))
      throw new OnboardingError("Open the created dashboards or explicitly start another set.");
    const choices = onboardingChoicesSchema.parse(value);
    if (!template || this.status(id).stale)
      throw new OnboardingError("Prepare the current integration first.");
    if (
      new Set(choices.categoryIds).size !== choices.categoryIds.length ||
      choices.categoryIds.some(
        (key) =>
          !template.categories.some(
            (category) => category.id === key && category.status === "ready",
          ),
      )
    )
      throw new OnboardingError("Choose prepared categories.");
    this.save(id, {
      status: "choosing",
      choices,
      templateRevision: template.revision,
      preview: undefined,
    });
    return this.status(id);
  }
  skip(id: string): OnboardingStatus {
    const state = this.connection(id).onboarding;
    if (state?.status !== "creating" && state?.status !== "complete")
      this.save(id, { status: "skipped" });
    return this.status(id);
  }
  restart(id: string): OnboardingStatus {
    // Explicitly starting another set also recovers an interrupted creation
    // whose credentials or integration changed. Already saved tabs are retained.
    this.save(id, { status: "choosing", preview: undefined, dashboardIds: [] });
    return this.status(id);
  }
  async preview(id: string): Promise<OnboardingPreview> {
    return this.locked(`connection:${id}`, async () => {
      const connection = this.connection(id),
        template = this.template(connection),
        choices = connection.onboarding?.choices;
      if (!template || !choices || this.status(id).stale)
        throw new OnboardingError("Choose categories from the current integration first.");
      if (["creating", "complete"].includes(connection.onboarding!.status))
        throw new OnboardingError("Open the created dashboards or explicitly start another set.");
      const fingerprint = this.fingerprint(connection, template);
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const params: ResolvedParams = { range: resolveRange({ preset: "30d", now }), filters: {} };
      const fetched = new Map<string, Promise<FetchResult>>();
      let spent = 0;
      const read = (op: string, values: Record<string, string | number | boolean>) => {
        const key = JSON.stringify([op, values]);
        let result = fetched.get(key);
        if (!result) {
          if (++spent > 40)
            throw new AdapterError("Verification budget reached", {
              status: 429,
              userMessage: "Retry to check remaining widgets.",
            });
          result = this.deps.read(connection, op, values, params);
          fetched.set(key, result);
        }
        return result;
      };
      const verification: OnboardingVerification[] = [];
      for (const category of template.categories.filter((one) =>
        choices.categoryIds.includes(one.id),
      )) {
        for (const original of category.widgets) {
          const widget = instantiateOnboardingWidget(original, id, original.id);
          let result: Pick<OnboardingVerification, "status" | "message"> = {
            status: "ready",
            message: "Access verified.",
          };
          try {
            const bodies: Record<string, unknown> = {};
            const plan = compilePlan(widget);
            if (!plan.ok) throw new Error("The widget pipeline no longer compiles.");
            const sources = widgetSources(widget);
            for (const source of sources) {
              const op = getOp(connection, source.op);
              if (source.connection !== id || !op) {
                result = {
                  status: "unavailable",
                  message: "A required endpoint is not enabled for this connection.",
                };
                break;
              }
              if (!source.fanOut && missingInputs(op, source.params).length) {
                result = {
                  status: "missingInput",
                  message: "This widget needs an input that setup cannot supply.",
                };
                break;
              }
            }
            if (result.status === "ready") {
              for (const source of sources.filter((one) => !one.fanOut))
                bodies[source.as] = (await read(source.op, source.params)).body;
              for (const source of sources.filter((one) => one.fanOut)) {
                const fan = source.fanOut!;
                const driver = plan.plan.sources.find((one) => one.as === fan.from);
                if (!driver || !(fan.from in bodies))
                  throw new Error("Unsupported fan-out dependency.");
                const rows = runPipeline(driver.compiled, bodies[fan.from], { now, params }).rows;
                const value = rows
                  .map((row) => row[fan.field])
                  .find((one) => typeof one === "string" || typeof one === "number");
                if (value === undefined) {
                  result = {
                    status: "missingInput",
                    message: "No parent record is available to verify a dependent endpoint.",
                  };
                  break;
                }
                const values = {
                  [fan.as ?? fan.field]: value as string | number,
                  ...source.params,
                };
                if (missingInputs(getOp(connection, source.op)!, values).length) {
                  result = {
                    status: "missingInput",
                    message: "A dependent endpoint needs more inputs.",
                  };
                  break;
                }
                bodies[source.as] = (await read(source.op, values)).body;
              }
              if (result.status === "ready") {
                for (const source of sources) {
                  const body = bodies[source.as];
                  if (!Array.isArray(body) || !body.length) continue;
                  const shape = inferShape(body, { rowsPath: "$" });
                  const pipeline = widget.source ? widget.pipeline : source.pipeline;
                  const fields = pipeline.flatMap((step) =>
                    step.op === "derive" ? Object.values(step.fields) : [],
                  );
                  // Compiler-produced derives name source fields directly. A field absent
                  // throughout a nonempty response must not silently become a blank column.
                  const paths = fields.filter((field) => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field));
                  if (paths.some((path) => !shape.fields.some((field) => field.name === path)))
                    throw new Error("Required fields are missing");
                }
                const executed = executeWidget(widget, widget.source ? bodies.main : bodies, {
                  now,
                  params,
                });
                // Empty successful collections prove access without claiming fields were observed.
                const nonempty = Object.values(bodies).some((body) =>
                  Array.isArray(body) ? body.length > 0 : body != null,
                );
                if (nonempty && !executed.ok)
                  result = {
                    status: "schema",
                    message: "The returned fields do not support this widget.",
                  };
              }
            }
          } catch (error) {
            result = reasonOf(error);
          }
          verification.push({
            categoryId: category.id,
            widgetId: original.id,
            title: original.title ?? original.id,
            ...result,
          });
        }
      }
      const current = this.connection(id),
        currentTemplate = this.template(current);
      if (!currentTemplate || fingerprint !== this.fingerprint(current, currentTemplate))
        throw new OnboardingError("Connection changed while verifying. Rebuild the preview.");
      const operation = randomUUID();
      const preview = {
        id: operation,
        fingerprint,
        verification,
        dashboards: assembleOnboarding(template, connection, choices, verification, operation),
      };
      this.save(id, { status: "preview", preview });
      return preview;
    });
  }
  async commit(id: string, previewId: string): Promise<string[]> {
    return this.locked(`connection:${id}`, async () => {
      const connection = this.connection(id),
        state = connection.onboarding,
        template = this.template(connection);
      if (!state?.preview || state.preview.id !== previewId)
        throw new OnboardingError("Rebuild the dashboard preview before creating it.");
      if (state.status === "complete") return state.dashboardIds;
      if (
        !template ||
        this.status(id).stale ||
        state.preview.fingerprint !== this.fingerprint(connection, template)
      )
        throw new OnboardingError("This preview is outdated. Verify the selected widgets again.");
      if (!state.preview.dashboards.length)
        throw new OnboardingError("No verified widgets are available yet.");
      const ids = state.preview.dashboards.map((board) => board.id);
      // Save the reservation first. A restart can finish these exact IDs.
      this.save(id, { status: "creating", dashboardIds: ids });
      for (const board of state.preview.dashboards) {
        if (!this.deps.store.getDashboard(board.id))
          this.deps.store.putDashboard(dashboardSchema.parse(board));
      }
      this.save(id, { status: "complete", dashboardIds: ids });
      return ids;
    });
  }
}
