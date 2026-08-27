import type { ActionRecord } from "@freebirdai/core";
import type { FreeBirdStore } from "@freebirdai/core-state";
import { isLocalActionResult, type RegistrationManifest } from "@freebirdai/manifest";

const OVERLAY_ID = "freebird-action-overlay";
const STYLE_ID = "freebird-action-overlay-style";

/** sessionStorage key — survives full page loads during cross-page actions. */
export const OVERLAY_ACTIVITY_KEY = "freebird:action-overlay";

/** Default accent when neither config nor host CSS vars are set. */
const DEFAULT_ACCENT = "#2563eb";

const OVERLAY_CSS = `
#${OVERLAY_ID} {
  --fb-overlay-accent: var(--freebird-overlay-accent, var(--freebird-accent, ${DEFAULT_ACCENT}));
  --fb-overlay-font: var(--freebird-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 220ms ease;
}
#${OVERLAY_ID}[data-visible="true"] {
  opacity: 1;
  pointer-events: auto;
}
#${OVERLAY_ID}[data-instant="true"] {
  transition: none;
}
#${OVERLAY_ID} .fb-overlay-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(6px);
}
#${OVERLAY_ID} .fb-overlay-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 32px;
  min-width: 220px;
  max-width: min(360px, calc(100vw - 48px));
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid rgba(17, 24, 39, 0.08);
  box-shadow:
    0 4px 6px rgba(15, 23, 42, 0.04),
    0 18px 40px rgba(15, 23, 42, 0.08);
  transform: translateY(4px) scale(0.985);
  opacity: 0;
  transition:
    opacity 280ms ease,
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
  font-family: var(--fb-overlay-font);
}
#${OVERLAY_ID}[data-visible="true"] .fb-overlay-card {
  opacity: 1;
  transform: translateY(0) scale(1);
}
#${OVERLAY_ID}[data-instant="true"] .fb-overlay-card {
  transition: none;
  opacity: 1;
  transform: none;
}
#${OVERLAY_ID} .fb-overlay-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2.5px solid color-mix(in srgb, var(--fb-overlay-accent) 18%, transparent);
  border-top-color: var(--fb-overlay-accent);
  animation: fb-overlay-spin 1.1s linear infinite;
}
#${OVERLAY_ID} .fb-overlay-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.45;
  font-weight: 500;
  color: #374151;
  text-align: center;
}
@keyframes fb-overlay-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID},
  #${OVERLAY_ID} .fb-overlay-card {
    transition: none;
  }
  #${OVERLAY_ID} .fb-overlay-spinner {
    animation: none;
    border-top-color: color-mix(in srgb, var(--fb-overlay-accent) 55%, #d1d5db);
  }
}
`;

export interface StashedOverlayActivity {
  message: string;
  accent?: string;
}

export interface ActionOverlayOptions {
  /** Matches the chat widget accent when set. */
  accent?: string;
  doc?: Document;
  defaultMessage?: string;
}

export interface ActionOverlay {
  show: (message?: string) => void;
  /** Visible immediately — used when restoring after a full page load. */
  showInstant: (message?: string) => void;
  hide: () => void;
  lock: () => void;
  unlock: () => void;
  isVisible: () => boolean;
  isLocked: () => boolean;
  destroy: () => void;
}

export interface WiredActionOverlay extends ActionOverlay {
  showPendingReplay: (pending: { componentId: string; page?: string }) => void;
  endPendingReplay: () => void;
}

const normalizePath = (path: string): string => path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";

export const stashOverlayActivity = (state: StashedOverlayActivity): void => {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(OVERLAY_ACTIVITY_KEY, JSON.stringify(state));
};

export const peekOverlayActivity = (): StashedOverlayActivity | null => {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(OVERLAY_ACTIVITY_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as StashedOverlayActivity).message === "string"
    ) {
      return parsed as StashedOverlayActivity;
    }
  } catch {
    // ignore malformed stash
  }
  return null;
};

export const clearOverlayActivity = (): void => {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(OVERLAY_ACTIVITY_KEY);
};

const ensureStyle = (doc: Document): void => {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = OVERLAY_CSS;
  doc.head.appendChild(style);
};

const defaultLabelForRecord = (
  record: ActionRecord,
  manifest: RegistrationManifest | undefined,
): string => {
  if (record.label) return record.label;
  const component = manifest?.components.find((c) => c.id === record.componentId);
  if (component?.title) return component.title;
  return "your request";
};

export const messageForPending = (
  pending: { componentId: string; page?: string },
  manifest: RegistrationManifest | undefined,
): string => {
  const component = manifest?.components.find((c) => c.id === pending.componentId);
  const label = component?.title ?? pending.componentId;
  return pending.page ? `Taking you to ${label}…` : `Working on ${label}…`;
};

export const createActionOverlay = (opts: ActionOverlayOptions = {}): ActionOverlay => {
  const doc = opts.doc ?? document;
  const defaultMessage = opts.defaultMessage ?? "Working on your request…";

  ensureStyle(doc);

  const root = doc.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("aria-live", "polite");
  root.hidden = true;

  if (opts.accent) {
    root.style.setProperty("--freebird-overlay-accent", opts.accent);
  }

  const backdrop = doc.createElement("div");
  backdrop.className = "fb-overlay-backdrop";

  const card = doc.createElement("div");
  card.className = "fb-overlay-card";

  const spinner = doc.createElement("div");
  spinner.className = "fb-overlay-spinner";
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Loading");

  const messageEl = doc.createElement("p");
  messageEl.className = "fb-overlay-message";
  messageEl.textContent = defaultMessage;

  card.append(spinner, messageEl);
  root.append(backdrop, card);
  doc.body.appendChild(root);

  let visible = false;
  let locked = false;

  const paintVisible = (instant: boolean): void => {
    root.hidden = false;
    root.setAttribute("aria-busy", "true");
    if (instant) {
      root.setAttribute("data-instant", "true");
      root.setAttribute("data-visible", "true");
      return;
    }
    root.removeAttribute("data-instant");
    requestAnimationFrame(() => root.setAttribute("data-visible", "true"));
  };

  const show = (text?: string): void => {
    if (text) messageEl.textContent = text;
    if (visible) return;
    visible = true;
    paintVisible(false);
  };

  const showInstant = (text?: string): void => {
    if (text) messageEl.textContent = text;
    visible = true;
    paintVisible(true);
  };

  const hide = (): void => {
    if (locked || !visible) return;
    visible = false;
    root.removeAttribute("data-visible");
    root.removeAttribute("data-instant");
    root.removeAttribute("aria-busy");
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== root || event.propertyName !== "opacity") return;
      root.hidden = true;
      root.removeEventListener("transitionend", onEnd);
    };
    root.addEventListener("transitionend", onEnd);
    setTimeout(() => {
      if (!visible && !locked) root.hidden = true;
    }, 260);
  };

  const destroy = (): void => {
    root.remove();
    doc.getElementById(STYLE_ID)?.remove();
  };

  return {
    show,
    showInstant,
    hide,
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    isVisible: () => visible,
    isLocked: () => locked,
    destroy,
  };
};

const isCrossPageResult = (
  result: unknown,
  manifest: RegistrationManifest,
  currentPath: string,
): boolean => {
  if (!isLocalActionResult(result)) return false;
  const component = manifest.components.find((c) => c.id === result.componentId);
  const page = result.page ?? component?.source.page;
  return page !== undefined && normalizePath(page) !== normalizePath(currentPath);
};

/**
 * Show a calm full-page overlay while actions run. Wired to store action events
 * and pending-replay flows in {@link start}.
 */
export const wireActionOverlay = (
  store: FreeBirdStore,
  opts: ActionOverlayOptions & {
    getManifest: () => RegistrationManifest;
    overlay?: ActionOverlay;
  },
): WiredActionOverlay => {
  const overlay = opts.overlay ?? createActionOverlay(opts);
  const manifest = opts.getManifest;
  const accent = opts.accent;

  let navigationActivity = false;

  const messageForRecord = (record: ActionRecord, kind: "working" | "navigating"): string => {
    const label = defaultLabelForRecord(record, manifest());
    return kind === "navigating" ? `Taking you to ${label}…` : `Working on ${label}…`;
  };

  const beginActivity = (message: string, mode: "fade" | "instant", persist: boolean): void => {
    if (persist) {
      stashOverlayActivity({
        message,
        ...(accent ? { accent } : {}),
      });
      overlay.lock();
      navigationActivity = true;
    }
    if (mode === "instant") overlay.showInstant(message);
    else overlay.show(message);
  };

  const endActivity = (): void => {
    navigationActivity = false;
    clearOverlayActivity();
    overlay.unlock();
    overlay.hide();
  };

  const isCrossPageComponent = (componentId: string, currentPath: string): boolean => {
    const page = manifest().components.find((c) => c.id === componentId)?.source.page;
    return page !== undefined && normalizePath(page) !== normalizePath(currentPath);
  };

  const unsubEvents = store.onActionEvent((event) => {
    const currentPath = typeof location !== "undefined" ? location.pathname : "/";

    switch (event.kind) {
      case "action.started": {
        const requiresConfirmation = event.state.pending?.requiresConfirmation ?? "preview";
        if (requiresConfirmation !== "none") return;
        const navigating = isCrossPageComponent(event.record.componentId, currentPath);
        beginActivity(
          messageForRecord(event.record, navigating ? "navigating" : "working"),
          navigating ? "fade" : "fade",
          navigating,
        );
        break;
      }
      case "action.confirmed": {
        const record = store.getState().actionState.journal.find((r) => r.id === event.recordId);
        if (!record) return;
        const navigating = isCrossPageComponent(record.componentId, currentPath);
        beginActivity(
          messageForRecord(record, navigating ? "navigating" : "working"),
          overlay.isVisible() ? "instant" : "fade",
          navigating || navigationActivity,
        );
        break;
      }
      case "action.executed": {
        if (isCrossPageResult(event.result, manifest(), currentPath)) {
          beginActivity(
            messageForRecord(event.record, "navigating"),
            overlay.isVisible() ? "instant" : "fade",
            true,
          );
          return;
        }
        if (navigationActivity) return;
        endActivity();
        break;
      }
      case "action.failed":
      case "action.cancelled":
        endActivity();
        break;
    }
  });

  return {
    ...overlay,
    showPendingReplay: (pending) => {
      const message = messageForPending(pending, manifest());
      if (overlay.isVisible()) {
        overlay.showInstant(message);
        overlay.lock();
        stashOverlayActivity({ message, ...(accent ? { accent } : {}) });
        navigationActivity = true;
        return;
      }
      beginActivity(message, "instant", true);
    },
    endPendingReplay: () => {
      endActivity();
    },
    destroy: () => {
      unsubEvents();
      overlay.destroy();
    },
  };
};
