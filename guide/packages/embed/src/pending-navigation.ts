import {
  buildLocalActionResult,
  isLocalActionResult,
  type LocalActionResult,
  type RegistrationManifest,
} from "@freebirdai/manifest";

/** sessionStorage key for a pending cross-page local-dom action. */
export const PENDING_ACTION_KEY = "freebird:pending-action";

/**
 * Stashed navigation payload. Extends {@link LocalActionResult} with replay
 * hints so the destination page can find the target without waiting on a
 * fresh DOM scan or manifest merge.
 */
export interface PendingNavigation extends LocalActionResult {
  /** When true, use instant scroll (not smooth) on replay after a page load. */
  crossPageReplay?: boolean;
}

export const isPendingNavigation = (value: unknown): value is PendingNavigation =>
  isLocalActionResult(value);

export const stashPendingNavigation = (result: LocalActionResult): void => {
  if (typeof sessionStorage === "undefined") return;
  const pending: PendingNavigation = { ...result, crossPageReplay: true };
  sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(pending));
};

export const readPendingNavigation = (): PendingNavigation | null => {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(PENDING_ACTION_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_ACTION_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingNavigation(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Read-only directives safe for speculative client execution. */
export const SPECULATIVE_DIRECTIVES = new Set<LocalActionResult["directive"]>([
  "highlight",
  "scroll-to",
  "show-in-chat",
]);

export const isSpeculativeDirective = (directive: string): directive is LocalActionResult["directive"] =>
  (SPECULATIVE_DIRECTIVES as Set<string>).has(directive);

export const buildSpeculativeResult = (input: {
  directive: LocalActionResult["directive"];
  componentId: string;
  selector?: string;
  page?: string;
  args?: Record<string, unknown>;
}): LocalActionResult =>
  buildLocalActionResult({
    directive: input.directive,
    componentId: input.componentId,
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.page ? { page: input.page } : {}),
    args: input.args ?? {},
  });

const normalizePath = (path: string): string =>
  path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";

/**
 * Build a read-only local-dom result for speculative execution on
 * `action.started`. Cross-page actions may default to `scroll-to` when the
 * client manifest omits action definitions (common for DOM-scanned components).
 */
export const resolveSpeculativeResult = (
  manifest: RegistrationManifest,
  input: {
    componentId: string;
    actionId: string;
    args: Record<string, unknown>;
    currentPath: string;
  },
): LocalActionResult | null => {
  const component = manifest.components.find((c) => c.id === input.componentId);
  if (!component) return null;

  const action = component.actions?.find((a) => a.id === input.actionId);
  const page = component.source.page;
  const onOtherPage =
    page !== undefined && normalizePath(page) !== normalizePath(input.currentPath);

  const directive =
    action?.kind === "local-dom" && action.directive
      ? action.directive
      : onOtherPage
        ? "scroll-to"
        : undefined;
  if (!directive || !isSpeculativeDirective(directive)) return null;
  if (!onOtherPage && (!action || action.kind !== "local-dom" || !action.directive)) {
    return null;
  }

  return buildSpeculativeResult({
    directive,
    componentId: component.id,
    ...(component.source.selector !== undefined
      ? { selector: component.source.selector }
      : {}),
    ...(page !== undefined ? { page } : {}),
    args: input.args,
  });
};
