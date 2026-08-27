import type { LlmTool } from "../adapters/llm.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { ActionState } from "../actions/types.js";

export interface ResolveProcessingToolsInput {
  /** Host-provided tools always eligible (e.g. a shared entity-lookup tool). */
  baseExtraTools?: Record<string, LlmTool>;
  /** Catalog of named processing tools actions/components reference by id. */
  processingToolCatalog?: Record<string, LlmTool>;
  actionState?: ActionState;
  activeComponentIds?: string[];
  registry: ComponentRegistry<any, any>;
}

/**
 * Merge host base tools with processing tools referenced by the pending
 * action and/or currently active components. Unreferenced catalog entries
 * are omitted so the LLM only sees tools relevant to this turn.
 */
export function resolveProcessingToolsForTurn(
  input: ResolveProcessingToolsInput,
): Record<string, LlmTool> {
  const out: Record<string, LlmTool> = { ...(input.baseExtraTools ?? {}) };
  const catalog = input.processingToolCatalog ?? {};
  const wanted = new Set<string>();

  const pending = input.actionState?.pending;
  if (pending) {
    const action = input.registry.getAction(
      pending.componentId,
      pending.actionId,
    );
    for (const id of action?.processingTools ?? []) {
      wanted.add(id);
    }
    const component = input.registry.get(pending.componentId);
    for (const id of component?.processingTools ?? []) {
      wanted.add(id);
    }
  }

  for (const componentId of input.activeComponentIds ?? []) {
    const component = input.registry.get(componentId);
    for (const id of component?.processingTools ?? []) {
      wanted.add(id);
    }
  }

  for (const id of wanted) {
    const tool = catalog[id];
    // Host-injected tools in baseExtraTools win (e.g. per-turn dynamic enums).
    if (tool && out[tool.name] === undefined) out[tool.name] = tool;
  }

  return out;
}
