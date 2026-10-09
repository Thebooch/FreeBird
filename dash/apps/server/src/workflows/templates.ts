import {
  TRIGGER_NODE,
  actionVariant,
  firstNode,
  workflowTemplateSchema,
  type WorkflowEdge,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowSpec,
  type WorkflowTemplate,
} from "@freebirdai/dash-spec";
import type { TemplateStore, WorkflowStore } from "./store.js";

/**
 * Templates: one step, a piece of a graph with one way in, or a whole
 * workflow, saved for reuse.
 *
 * - **Blanks.** `{{ blank.<name> }}` in any setting is asked for each time the
 *   template is inserted, with the default it was saved with.
 * - **Copies, not links.** Inserting copies the template's steps with fresh
 *   ids. Saving a template again makes a new version; workflows made from an
 *   older one are told a newer one exists, and nothing changes behind them.
 */

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const BLANK = /\{\{\s*blank\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every blank a set of steps uses, by name. */
export const blanksIn = (nodes: readonly WorkflowNode[]): string[] => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") for (const match of value.matchAll(BLANK)) found.add(match[1]!);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  nodes.forEach((node) => visit(node.settings));
  return [...found];
};

const fill = (value: unknown, values: Readonly<Record<string, string>>): unknown => {
  if (typeof value === "string") {
    const whole = /^\s*\{\{\s*blank\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}\s*$/.exec(value);
    if (whole) return values[whole[1]!] ?? value;
    return value.replace(BLANK, (all, name: string) => values[name] ?? all);
  }
  if (Array.isArray(value)) return value.map((one) => fill(one, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, values)]));
  return value;
};

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "template";

export interface InsertedSteps {
  readonly nodes: WorkflowNode[];
  readonly edges: WorkflowEdge[];
  /** The step the inserted piece starts at. */
  readonly entry?: string | undefined;
}

/** `{{ steps.<old id>… }}` in any text setting, pointed at the step's new id. */
const retarget = (value: unknown, ids: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return value.replace(/\bsteps\.([a-zA-Z0-9_-]+)/g, (all, id: string) => (ids.has(id) ? `steps.${ids.get(id)}` : all));
  if (Array.isArray(value)) return value.map((one) => retarget(one, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, one]) => [key, retarget(one, ids)]));
  return value;
};

export class TemplateService {
  constructor(
    private readonly deps: {
      readonly templates: TemplateStore;
      readonly workflows: WorkflowStore;
      readonly now?: () => Date;
      readonly newId: () => string;
      /** Templates shipped with Dash, read-only, listed after the workspace's own. */
      readonly builtIn?: readonly WorkflowTemplate[];
    },
  ) {}

  private iso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async list(): Promise<WorkflowTemplate[]> {
    const own = await this.deps.templates.list();
    return [...own, ...(this.deps.builtIn ?? []).filter((one) => !own.some((held) => held.id === one.id))];
  }

  async get(id: string): Promise<WorkflowTemplate> {
    const held = (await this.deps.templates.get(id)) ?? this.deps.builtIn?.find((one) => one.id === id);
    if (!held) throw new TemplateError(`There is no template "${id}".`, 404);
    return held;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.deps.templates.get(id)) && this.deps.builtIn?.some((one) => one.id === id)) throw new TemplateError("A template that comes with Dash can't be removed.", 409);
    await this.get(id);
    await this.deps.templates.delete(id);
  }

  /**
   * Save steps of a workflow as a template: one step, several (a path, whose
   * entry is the first named), or the whole workflow. Saving under a name that
   * exists makes its next version.
   */
  async saveFrom(input: {
    readonly workflow: string;
    readonly kind: WorkflowTemplate["kind"];
    readonly name: string;
    readonly description?: string;
    /** For a step or a path: which steps, the entry first. */
    readonly steps?: readonly string[];
    readonly blanks?: WorkflowTemplate["blanks"];
  }): Promise<WorkflowTemplate> {
    const workflow = await this.deps.workflows.get(input.workflow);
    if (!workflow) throw new TemplateError(`There is no workflow "${input.workflow}".`, 404);
    const chosen = input.kind === "workflow" ? workflow.nodes.map((one) => one.id) : (input.steps ?? []);
    if (chosen.length === 0) throw new TemplateError("Say which steps to save.", 400);
    if (input.kind === "step" && chosen.length !== 1) throw new TemplateError("A step template holds one step.", 400);
    const keep = new Set(chosen);
    const nodes = workflow.nodes.filter((one) => keep.has(one.id));
    if (nodes.length !== keep.size) throw new TemplateError("Some of those steps are not in the workflow.", 400);
    const edges = workflow.edges.filter((edge) => keep.has(edge.to) && (keep.has(edge.from) || (input.kind === "workflow" && edge.from === TRIGGER_NODE)));
    const used = blanksIn(nodes);
    const given = new Map((input.blanks ?? []).map((one) => [one.name, one]));
    const blanks = used.map((name) => given.get(name) ?? { name, label: name.replace(/_/g, " ") });
    const { id: _id, nodes: _n, edges: _e, enabledBy: _b, parked: _p, failures: _f, createdAt: _c, updatedAt: _u, enabled: _on, fromTemplate: _t, ...rest } = workflow;
    return this.save({
      kind: input.kind,
      name: input.name,
      description: input.description ?? "",
      blanks,
      nodes,
      edges,
      entry: input.kind === "workflow" ? firstNode(workflow) : chosen[0],
      ...(input.kind === "workflow" ? { workflow: rest as Record<string, unknown> } : {}),
    });
  }

  /** Save a template as given; a name already used makes its next version. */
  async save(input: Omit<WorkflowTemplate, "id" | "version" | "createdAt" | "updatedAt">): Promise<WorkflowTemplate> {
    const all = await this.deps.templates.list();
    const held = all.find((one) => one.name.toLowerCase() === input.name.trim().toLowerCase());
    let id = held?.id ?? slug(input.name);
    if (!held) for (let n = 2; all.some((one) => one.id === id); n++) id = `${slug(input.name)}-${n}`;
    const at = this.iso();
    const template = workflowTemplateSchema.parse({ ...input, id, version: (held?.version ?? 0) + 1, createdAt: held?.createdAt ?? at, updatedAt: at });
    await this.deps.templates.put(template);
    return template;
  }

  /**
   * A template's steps, ready to put in a workflow: fresh ids, blanks filled,
   * placed below `at`. Every blank without a default must be given.
   */
  async insert(id: string, values: Readonly<Record<string, string>>, at: { readonly x: number; readonly y: number } = { x: 0, y: 0 }): Promise<InsertedSteps & { readonly template: WorkflowTemplate }> {
    const template = await this.get(id);
    const filled: Record<string, string> = {};
    const missing: string[] = [];
    for (const blank of template.blanks) {
      const value = values[blank.name] ?? blank.default;
      if (value === undefined || value === "") missing.push(blank.label || blank.name);
      else filled[blank.name] = value;
    }
    if (missing.length > 0) throw new TemplateError(`"${template.name}" needs: ${missing.join(", ")}.`, 400);
    /* Fresh ids, joined with an underscore so `{{ steps.<id>.… }}` can still name them. */
    const ids = new Map(template.nodes.map((node) => [node.id, `${node.id.replace(/-/g, "_")}_${this.deps.newId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 6)}`.slice(0, 64)]));
    const top = Math.min(...template.nodes.map((node) => node.position.y), 0);
    const left = Math.min(...template.nodes.map((node) => node.position.x), 0);
    const nodes = template.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      settings: retarget(fill(node.settings, filled), ids) as Record<string, unknown>,
      position: { x: at.x + node.position.x - left, y: at.y + node.position.y - top },
    }));
    /* A setting naming a step of the template (any field of kind step) follows it to its new id. */
    for (const node of nodes) {
      for (const field of actionVariant(node.action)?.fields ?? []) {
        const named = node.settings[field.key];
        if (field.kind === "step" && typeof named === "string" && ids.has(named)) node.settings = { ...node.settings, [field.key]: ids.get(named)! };
      }
    }
    const edges = template.edges
      .filter((edge) => ids.has(edge.to) && (ids.has(edge.from) || edge.from === TRIGGER_NODE))
      .map((edge) => {
        const from = edge.from === TRIGGER_NODE ? TRIGGER_NODE : ids.get(edge.from)!;
        const to = ids.get(edge.to)!;
        return { ...edge, id: `e-${from}-${to}-${edge.outcome}`.slice(0, 64), from, to };
      });
    return { template, nodes, edges, entry: template.entry ? ids.get(template.entry) : nodes[0]?.id };
  }

  /** A whole workflow from a workflow template: the input to save it with. */
  async workflowFrom(
    id: string,
    values: Readonly<Record<string, string>>,
    name?: string,
    /** For a template a booking starts: only these appointment types. */
    bookingTypes?: readonly string[],
  ): Promise<{ readonly input: WorkflowInput; readonly template: WorkflowTemplate }> {
    const inserted = await this.insert(id, values);
    if (inserted.template.kind !== "workflow" || !inserted.template.workflow) throw new TemplateError(`"${inserted.template.name}" is not a whole workflow.`, 400);
    const rest = inserted.template.workflow as Partial<WorkflowSpec>;
    const trigger = rest.trigger ?? { kind: "manual" as const };
    return {
      template: inserted.template,
      input: {
        ...(rest as object),
        name: name ?? rest.name ?? inserted.template.name,
        trigger: trigger.kind === "booking" && bookingTypes && bookingTypes.length > 0 ? { ...trigger, types: [...bookingTypes] } : trigger,
        nodes: inserted.nodes,
        edges: inserted.edges,
        enabled: false,
      } as WorkflowInput,
    };
  }

  /** Workflows made from an older version of a template: a newer one is offered, never forced. */
  async newerFor(workflow: WorkflowSpec): Promise<WorkflowTemplate | null> {
    if (!workflow.fromTemplate) return null;
    const held = await this.deps.templates.get(workflow.fromTemplate.id);
    return held && held.version > workflow.fromTemplate.version ? held : null;
  }
}
