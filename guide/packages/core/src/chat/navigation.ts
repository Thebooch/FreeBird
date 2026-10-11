import { z } from "zod";
import type { LlmTool } from "../adapters/llm.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { ComponentCitation } from "../types.js";

/**
 * Taking a person somewhere in the app when they ask.
 *
 * "Take me to appointment types", "show me the Showing type": the chat opens
 * the screen rather than describing where it is. Only components with a
 * `domAnchor` can be opened, the same ones a citation chip can point at, and
 * the client does the opening (the engine emits a `navigate` event carrying a
 * citation-shaped target). A change the chat made never opens anything on its
 * own: that is a chip the person follows if they want to.
 */

export const OPEN_COMPONENT_TOOL_NAME = "open_component";

/** The components a person can be taken to: those with somewhere on a page. */
const anchored = (registry: ComponentRegistry<any, any>) => registry.list().filter((component) => component.domAnchor);

/** The tool, or null when nothing in the registry can be opened. */
export const buildOpenComponentTool = (registry: ComponentRegistry<any, any>): LlmTool | null => {
  const ids = anchored(registry).map((component) => component.id);
  if (ids.length === 0) return null;
  return {
    name: OPEN_COMPONENT_TOOL_NAME,
    description:
      "Take the person to a part of the app, when they ask to go there or to see it. Never to show a change you " +
      "made: the record of the change carries a link they can follow. `itemId` opens one item in it when the " +
      "component lists several.",
    schema: z.object({
      componentId: z.enum(ids as [string, ...string[]]).describe("The component to open."),
      itemId: z.string().min(1).max(200).optional().describe("One item in it, as its actions name it."),
    }),
  };
};

/** `"x"` → `"\"x\""`, safe inside an attribute selector whatever the id holds. */
const quoted = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Where an `open_component` call goes, or null when it names nothing that can be opened. */
export const resolveNavigation = (registry: ComponentRegistry<any, any>, args: unknown): ComponentCitation | null => {
  const given = (args ?? {}) as { componentId?: unknown; itemId?: unknown };
  if (typeof given.componentId !== "string") return null;
  const component = registry.get(given.componentId);
  if (!component?.domAnchor) return null;
  const item = typeof given.itemId === "string" && given.itemId.trim() !== "" ? given.itemId.trim() : null;
  return {
    componentId: component.id,
    title: component.title,
    directive: "scroll-to",
    kind: "component",
    selector: item ? `${component.domAnchor.selector} [data-freebird-item=${quoted(item)}]` : component.domAnchor.selector,
    ...(component.domAnchor.page !== undefined ? { page: component.domAnchor.page } : {}),
  };
};
