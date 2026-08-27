import { safeQuery } from "@freebirdai/core";
import type { LocalActionResult } from "@freebirdai/manifest";
import type { RegistrationManifest } from "@freebirdai/manifest";
import {
  stashPendingNavigation,
  type PendingNavigation,
} from "./pending-navigation.js";
import { waitForElement } from "./wait-for-element.js";

/**
 * Executes local-DOM directives in the visitor's browser. The server-side
 * manifest compiler returns these as action *results*; the embed spots them
 * on `action.executed` events and runs them here.
 */

const HIGHLIGHT_STYLE_ID = "freebird-highlight-style";
const HIGHLIGHT_CLASS = "freebird-highlight";

const ensureHighlightStyle = (doc: Document): void => {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
@keyframes freebird-pulse {
  0% { outline-color: rgba(59,130,246,0.9); }
  100% { outline-color: rgba(59,130,246,0); }
}
.${HIGHLIGHT_CLASS} {
  outline: 3px solid rgba(59,130,246,0.9);
  outline-offset: 3px;
  animation: freebird-pulse 2.4s ease-out forwards;
}`;
  doc.head.appendChild(style);
};

export interface LocalActionOutcome {
  ok: boolean;
  detail?: string;
  /** For show-in-chat: the extracted content the widget should display. */
  card?: { componentId: string; title?: string; text: string };
}

export interface LocalActionExecutorOptions {
  doc?: Document;
  /** Called when show-in-chat produces a card — the widget renders it. */
  onCard?: (card: NonNullable<LocalActionOutcome["card"]>) => void;
  /** Called when a cross-page navigation is about to start. */
  onNavigating?: (result: LocalActionResult) => void;
  /**
   * Optional host hook for client-side routing (Next.js, Vue Router, etc.).
   * Return `true` when navigation was handled without a full page load.
   * When omitted, cross-page actions use `location.assign`.
   */
  navigate?: (path: string) => void | boolean | Promise<void | boolean>;
}

/** Normalize for comparison — ignore trailing slash / query / hash differences. */
const normalizePath = (path: string): string =>
  path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";

export interface ExecuteOptions {
  /** Instant scroll on replay after cross-page navigation (default false). */
  crossPageReplay?: boolean;
  /** Wait for selector via MutationObserver when element is not present yet. */
  waitForSelector?: boolean;
}

export const createLocalActionExecutor = (
  getManifest: () => RegistrationManifest,
  opts: LocalActionExecutorOptions = {},
) => {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);

  const resolveSelector = (result: LocalActionResult): string | null => {
    const component = getManifest().components.find((c) => c.id === result.componentId);
    return component?.source.selector ?? result.selector ?? null;
  };

  /**
   * Attention-only directives targeting a page we're already on succeed even
   * when the selector doesn't resolve — for knowledge citations, landing on
   * the source page IS the deliverable (anchors may not survive redesigns or
   * post-JS rendering).
   */
  const pageOnlyOutcome = (result: LocalActionResult): LocalActionOutcome | null => {
    if (result.directive !== "highlight" && result.directive !== "scroll-to") return null;
    const component = getManifest().components.find((c) => c.id === result.componentId);
    const page = component?.source.page ?? result.page;
    if (!page || !win) return null;
    if (normalizePath(page) !== normalizePath(win.location.pathname)) return null;
    return { ok: true, detail: "page-only" };
  };

  const resolveFieldSelector = (componentId: string, name: string): string => {
    const component = getManifest().components.find((c) => c.id === componentId);
    const field = component?.fields?.find((f) => f.name === name);
    return field?.selector ?? `[name="${name}"]`;
  };

  const scrollBehavior = (instant: boolean): ScrollBehavior => (instant ? "auto" : "smooth");

  const applyDirective = (
    result: LocalActionResult,
    root: Element,
    instantScroll: boolean,
  ): LocalActionOutcome => {
    switch (result.directive) {
      case "highlight": {
        ensureHighlightStyle(doc);
        root.classList.remove(HIGHLIGHT_CLASS);
        void (root as HTMLElement).offsetWidth;
        root.classList.add(HIGHLIGHT_CLASS);
        root.scrollIntoView({ behavior: scrollBehavior(instantScroll), block: "center" });
        return { ok: true };
      }
      case "scroll-to": {
        root.scrollIntoView({ behavior: scrollBehavior(instantScroll), block: "center" });
        return { ok: true };
      }
      case "show-in-chat": {
        const component = getManifest().components.find((c) => c.id === result.componentId);
        const text = (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
        const card = {
          componentId: result.componentId,
          ...(component?.title ? { title: component.title } : {}),
          text,
        };
        opts.onCard?.(card);
        return { ok: true, card };
      }
      case "fill-form": {
        let filled = 0;
        for (const [name, value] of Object.entries(result.args)) {
          const fieldSelector = resolveFieldSelector(result.componentId, name);
          const el = root.querySelector(fieldSelector);
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement
          ) {
            if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
              el.checked = Boolean(value);
            } else {
              el.value = String(value);
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled += 1;
          }
        }
        root.scrollIntoView({ behavior: scrollBehavior(instantScroll), block: "center" });
        return filled > 0
          ? { ok: true, detail: `${filled} field(s) filled` }
          : { ok: false, detail: "no matching form fields" };
      }
      case "click": {
        const target =
          typeof result.args["target"] === "string"
            ? root.querySelector(String(result.args["target"]))
            : root;
        if (target instanceof HTMLElement) {
          target.click();
          return { ok: true };
        }
        return { ok: false, detail: "click target not found" };
      }
    }
  };

  /**
   * If the component's registered page differs from where we are now,
   * stash the result and navigate there instead of searching the current DOM.
   */
  const navigateIfWrongPage = async (result: LocalActionResult): Promise<boolean> => {
    const component = getManifest().components.find((c) => c.id === result.componentId);
    const page = component?.source.page ?? result.page;
    if (!page || !win) return false;
    if (normalizePath(page) === normalizePath(win.location.pathname)) return false;

    stashPendingNavigation(result);
    opts.onNavigating?.(result);

    if (opts.navigate) {
      const handled = await opts.navigate(page);
      if (handled !== false) return true;
    }

    win.location.assign(page);
    return true;
  };

  const execute = (result: LocalActionResult, execOpts: ExecuteOptions = {}): LocalActionOutcome => {
    const instantScroll = execOpts.crossPageReplay === true;
    // navigateIfWrongPage is async — sync execute can't await; use executeAsync for full flow.
    const component = getManifest().components.find((c) => c.id === result.componentId);
    const page = component?.source.page ?? result.page;
    if (page && win && normalizePath(page) !== normalizePath(win.location.pathname)) {
      stashPendingNavigation(result);
      opts.onNavigating?.(result);
      if (opts.navigate) {
        void Promise.resolve(opts.navigate(page)).then((handled) => {
          if (handled === false) win.location.assign(page);
        });
      } else {
        win.location.assign(page);
      }
      return { ok: true, detail: "navigating" };
    }

    const selector = resolveSelector(result);
    const root = selector ? safeQuery(doc, selector) : null;
    if (!root) {
      return (
        pageOnlyOutcome(result) ?? {
          ok: false,
          detail: `component "${result.componentId}" not found on this page`,
        }
      );
    }
    return applyDirective(result, root, instantScroll);
  };

  const executeAsync = async (
    result: LocalActionResult | PendingNavigation,
    execOpts: ExecuteOptions = {},
  ): Promise<LocalActionOutcome> => {
    const instantScroll =
      execOpts.crossPageReplay === true ||
      (result as PendingNavigation).crossPageReplay === true;
    const wait = execOpts.waitForSelector !== false;

    if (await navigateIfWrongPage(result)) {
      return { ok: true, detail: "navigating" };
    }

    const selector = resolveSelector(result);
    if (!selector) {
      return (
        pageOnlyOutcome(result) ?? {
          ok: false,
          detail: `component "${result.componentId}" not found on this page`,
        }
      );
    }

    const root = wait ? await waitForElement(doc, selector) : safeQuery(doc, selector);
    if (!root) {
      return (
        pageOnlyOutcome(result) ?? {
          ok: false,
          detail: `component "${result.componentId}" not found on this page`,
        }
      );
    }
    return applyDirective(result, root, instantScroll);
  };

  return { execute, executeAsync };
};
