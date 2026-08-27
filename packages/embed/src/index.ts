import type { ActionRecord } from "@freebirdai/core";
import {
  FreeBirdStore,
  createFetchTransport,
} from "@freebirdai/core-state";
import {
  buildLocalActionResult,
  isLocalActionResult,
  mergeManifests,
  type RegistrationManifest,
} from "@freebirdai/manifest";
import {
  configFromScript,
  chatBaseUrl,
  DEFAULT_CONFIG,
  type EmbedConfig,
  type StartOptions,
} from "./config.js";
import { scanDocument, observeComponents } from "./scanner.js";
import { captureSnapshots } from "./snapshot.js";
import { EmbedBackend } from "./backend.js";
import { createLocalActionExecutor } from "./local-actions.js";
import { readPendingNavigation, resolveSpeculativeResult } from "./pending-navigation.js";
import { wireActionOverlay, createActionOverlay, peekOverlayActivity, stashOverlayActivity, messageForPending } from "./action-overlay.js";
import {
  defineChatElement,
  ELEMENT_TAG,
  type FreeBirdChatElement,
} from "./element.js";

export type { EmbedConfig, StartOptions } from "./config.js";
export { scanDocument, observeComponents, selectorFor } from "./scanner.js";
export { captureSnapshots, snapshotComponent, extractText } from "./snapshot.js";
export { createLocalActionExecutor } from "./local-actions.js";
export {
  PENDING_ACTION_KEY,
  stashPendingNavigation,
  readPendingNavigation,
  isSpeculativeDirective,
  buildSpeculativeResult,
  resolveSpeculativeResult,
} from "./pending-navigation.js";
export { waitForElement, WAIT_FOR_ELEMENT_TIMEOUT_MS } from "./wait-for-element.js";
export {
  createActionOverlay,
  wireActionOverlay,
  messageForPending,
  stashOverlayActivity,
  peekOverlayActivity,
  clearOverlayActivity,
  OVERLAY_ACTIVITY_KEY,
} from "./action-overlay.js";
export { EmbedBackend } from "./backend.js";
export { FreeBirdChatElement, ELEMENT_TAG } from "./element.js";

/**
 * The public runtime handle. Exposed as `window.FreeBird` so tech-savvy static
 * sites can register components imperatively (the escape hatch) and drive the
 * widget without touching the DOM-attribute path.
 */
export interface FreeBirdApi {
  /** Imperatively add/replace a component (merged into the scanned manifest). */
  register: (component: RegistrationManifest["components"][number]) => void;
  /** Re-scan the DOM and re-sync the manifest with the backend. */
  rescan: () => Promise<void>;
  /** Current merged manifest (scanned + imperatively registered). */
  getManifest: () => RegistrationManifest;
  open: () => void;
  close: () => void;
  /** The underlying state store, for advanced hosts. */
  store: FreeBirdStore;
  config: EmbedConfig;
}

declare global {
  interface Window {
    FreeBird?: FreeBirdApi;
  }
}

/**
 * Boot the embed. Called automatically for the bootstrap `<script>` tag, but
 * also exported so bundler users can start it with an explicit config.
 */
export const start = (config: EmbedConfig, startOpts: StartOptions = {}): FreeBirdApi => {
  defineChatElement();

  const backend = new EmbedBackend(config);
  const pendingReplay = readPendingNavigation();

  // Imperative registrations are merged on top of every DOM scan.
  let imperative: RegistrationManifest = { version: 1, components: [] };
  let manifest: RegistrationManifest = { version: 1, components: [] };

  const rebuildManifest = (): RegistrationManifest => {
    const scanned = config.autoScan
      ? scanDocument(document, config.siteId)
      : { version: 1 as const, components: [] };
    manifest = mergeManifests(scanned, imperative);
    if (config.siteId !== undefined) manifest.siteId = config.siteId;
    return manifest;
  };

  const transport = createFetchTransport({
    baseUrl: chatBaseUrl(config),
    getAuthToken: () => backend.sessionToken,
  });
  const store = new FreeBirdStore(transport);

  const speculativeHandled = new Set<string>();

  rebuildManifest();

  const stashedOverlay = peekOverlayActivity();

  const actionOverlayEnabled =
    config.actionOverlay ?? (config.siteId !== undefined);
  const overlayInstance = actionOverlayEnabled
    ? createActionOverlay({ ...(config.accent ? { accent: config.accent } : {}) })
    : undefined;
  if (overlayInstance && stashedOverlay) {
    overlayInstance.showInstant(stashedOverlay.message);
    overlayInstance.lock();
  } else if (overlayInstance && pendingReplay) {
    const message = messageForPending(pendingReplay, manifest);
    overlayInstance.showInstant(message);
    overlayInstance.lock();
    stashOverlayActivity({
      message,
      ...(config.accent ? { accent: config.accent } : {}),
    });
  }

  const actionOverlay = actionOverlayEnabled
    ? wireActionOverlay(store, {
        ...(config.accent ? { accent: config.accent } : {}),
        getManifest: () => manifest,
        ...(overlayInstance ? { overlay: overlayInstance } : {}),
      })
    : undefined;

  // Mount the widget element (executor needs a late-bound onCard reference).
  let element: FreeBirdChatElement | undefined;
  const executor = createLocalActionExecutor(() => manifest, {
    onCard: (card) => element?.showCard(card),
    ...(startOpts.navigate ? { navigate: startOpts.navigate } : {}),
    onNavigating: (result) => {
      actionOverlay?.showPendingReplay({
        componentId: result.componentId,
        ...(result.page ? { page: result.page } : {}),
      });
    },
  });

  const trySpeculativeLocalDom = (record: ActionRecord): void => {
    if (speculativeHandled.has(record.id)) return;
    const currentPath =
      typeof location !== "undefined" ? location.pathname : "/";
    const result = resolveSpeculativeResult(manifest, {
      componentId: record.componentId,
      actionId: record.actionId,
      args: record.args,
      currentPath,
    });
    if (!result) return;
    speculativeHandled.add(record.id);
    void executor.executeAsync(result);
  };

  store.onActionEvent((event) => {
    if (event.kind === "action.started") {
      trySpeculativeLocalDom(event.record);
      return;
    }
    if (event.kind === "action.executed" && isLocalActionResult(event.result)) {
      if (speculativeHandled.has(event.record.id)) return;
      void executor.executeAsync(event.result);
    }
  });

  // Persist the session across a real page navigation (e.g. the local-action
  // executor sending the visitor to a different page to highlight something
  // there) — otherwise every navigation would silently start a brand-new,
  // empty conversation. Scoped per-site, cleared when the browser tab closes.
  const sessionStorageKey = config.siteId ? `freebird:session:${config.siteId}` : null;

  let sessionCreated = false;
  const ensureSession = async (): Promise<void> => {
    if (sessionCreated) return;
    rebuildManifest();
    await backend.handshake(manifest);

    let sessionId = sessionStorageKey ? sessionStorage.getItem(sessionStorageKey) : null;
    if (sessionId) {
      try {
        store.setMessages(await store.transport.listMessages(sessionId));
      } catch {
        sessionId = null; // stale/invalid — fall through to creating a fresh one
      }
    }
    if (!sessionId) {
      const session = await store.transport.createSession({
        tags: manifest.components.map((c) => c.id),
      });
      sessionId = session.id;
    }
    store.setSessionId(sessionId);
    if (sessionStorageKey) sessionStorage.setItem(sessionStorageKey, sessionId);
    store.setActiveComponentIds(manifest.components.map((c) => c.id));
    sessionCreated = true;
    void syncSnapshots();
  };

  const syncSnapshots = async (): Promise<void> => {
    if (!backend.enabled || !config.snapshots) return;
    await backend.postSnapshots(captureSnapshots(manifest));
  };

  // Mount the widget element.
  element = document.createElement(ELEMENT_TAG) as FreeBirdChatElement;
  element.configure({
    store,
    title: config.title,
    placeholder: config.placeholder,
    position: config.position,
    ...(config.accent ? { accent: config.accent } : {}),
    ensureSession,
    onCiteClick: (citation) =>
      void executor.executeAsync(
        buildLocalActionResult({
          directive: citation.directive,
          componentId: citation.componentId,
          ...(citation.selector ? { selector: citation.selector } : {}),
          ...(citation.page ? { page: citation.page } : {}),
          args: {},
        }),
      ),
  });
  document.body.appendChild(element);

  const startDeferredBoot = (): void => {
    if (config.autoScan) {
      observeComponents(() => {
        rebuildManifest();
        store.setActiveComponentIds(manifest.components.map((c) => c.id));
        if (sessionCreated) void syncSnapshots();
      });
    }
  };

  // Replay a cross-page pending action before non-critical boot work.
  if (pendingReplay) {
    element.open();
    if (!actionOverlay?.isVisible()) {
      actionOverlay?.showPendingReplay(pendingReplay);
    }
    void executor
      .executeAsync(pendingReplay, { crossPageReplay: true })
      .finally(() => {
        actionOverlay?.endPendingReplay();
        startDeferredBoot();
      });
  } else {
    startDeferredBoot();
  }

  const api: FreeBirdApi = {
    register: (component) => {
      imperative = mergeManifests(imperative, {
        version: 1,
        components: [component],
      });
      rebuildManifest();
      store.setActiveComponentIds(manifest.components.map((c) => c.id));
    },
    rescan: async () => {
      rebuildManifest();
      if (sessionCreated) await backend.handshake(manifest);
      await syncSnapshots();
    },
    getManifest: () => manifest,
    open: () => element.open(),
    close: () => element.close(),
    store,
    config,
  };
  return api;
};

/** Locate the bootstrap script tag (the one that loaded this bundle). */
const findBootstrapScript = (): HTMLScriptElement | null => {
  if (document.currentScript instanceof HTMLScriptElement) {
    return document.currentScript;
  }
  // IIFE bundles lose `currentScript` by the time DOMContentLoaded fires;
  // fall back to any script that carries a data-site-id or our filename.
  const scripts = Array.from(document.querySelectorAll("script"));
  return (
    scripts.find((s) => s.dataset.siteId) ??
    scripts.find((s) => /freebird(\.min)?\.js/.test(s.src)) ??
    null
  );
};

const autostart = (): void => {
  if (typeof document === "undefined") return;
  const script = findBootstrapScript();
  const config = script ? configFromScript(script) : DEFAULT_CONFIG;
  const run = () => {
    if (!window.FreeBird) window.FreeBird = start(config);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
};

// Auto-boot when loaded as a plain script tag. Bundler users import { start }.
autostart();
