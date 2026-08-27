import type { ComponentRegistry } from "@freebirdai/core";

/** Global MCP access mode configured when the host enables the MCP server. */
export type McpAccessMode = "read-only" | "read-write" | "write-only";

/** Which MCP tool categories are allowed for the current mode. */
export interface McpToolAccess {
  metadata: boolean;
  dataRead: boolean;
  write: boolean;
}

export const resolveToolAccess = (mode: McpAccessMode): McpToolAccess => {
  switch (mode) {
    case "read-only":
      return { metadata: true, dataRead: true, write: false };
    case "write-only":
      return { metadata: true, dataRead: false, write: true };
    case "read-write":
      return { metadata: true, dataRead: true, write: true };
  }
};

export interface ExposedAction {
  componentId: string;
  actionId: string;
  ref: string;
  description: string;
  requiresConfirmation: boolean;
}

export interface ExposedComponent {
  componentId: string;
  title: string;
  description: string;
  readable: boolean;
  reviewable: boolean;
}

export const listExposedActions = (
  registry: ComponentRegistry<any, any>,
  mode: McpAccessMode,
): ExposedAction[] => {
  const access = resolveToolAccess(mode);
  if (!access.write) return [];

  return registry
    .listActions()
    .filter(({ action }) => {
      if (action.mcp?.expose === false) return false;
      return true;
    })
    .map(({ componentId, action }) => ({
      componentId,
      actionId: action.id,
      ref: `${componentId}:${action.id}`,
      description: action.description,
      requiresConfirmation: actionRequiresMcpConfirmation(action),
    }));
};

export const listExposedComponents = (
  registry: ComponentRegistry<any, any>,
  mode: McpAccessMode,
): ExposedComponent[] => {
  const access = resolveToolAccess(mode);

  return registry.list().map((c) => {
    const hasDataSource = typeof c.dataSource === "function";
    const readable =
      access.dataRead &&
      hasDataSource &&
      c.mcp?.read !== false;
    const reviewable = access.dataRead && Boolean(c.review);

    return {
      componentId: c.id,
      title: c.title,
      description: c.description,
      readable,
      reviewable,
    };
  });
};

export const isActionExposed = (
  registry: ComponentRegistry<any, any>,
  mode: McpAccessMode,
  componentId: string,
  actionId: string,
): boolean => {
  const access = resolveToolAccess(mode);
  if (!access.write) return false;
  const def = registry.getAction(componentId, actionId);
  if (!def) return false;
  if (def.mcp?.expose === false) return false;
  return true;
};

export const isComponentReadable = (
  registry: ComponentRegistry<any, any>,
  mode: McpAccessMode,
  componentId: string,
): boolean => {
  const access = resolveToolAccess(mode);
  if (!access.dataRead) return false;
  const c = registry.get(componentId);
  if (!c?.dataSource) return false;
  if (c.mcp?.read === false) return false;
  return true;
};

export const isComponentReviewable = (
  registry: ComponentRegistry<any, any>,
  mode: McpAccessMode,
  componentId: string,
): boolean => {
  const access = resolveToolAccess(mode);
  if (!access.dataRead) return false;
  const c = registry.get(componentId);
  return Boolean(c?.review);
};

/** Whether MCP execute requires a confirmation token for this action. */
export const actionRequiresMcpConfirmation = (action: {
  requiresConfirmation?: "none" | "preview" | "strict";
  mcp?: { requireConfirmation?: boolean };
}): boolean => {
  if (action.mcp?.requireConfirmation === true) return true;
  const policy = action.requiresConfirmation ?? "preview";
  return policy !== "none";
};
