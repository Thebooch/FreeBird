/// <reference lib="dom" />
import type { ComponentCitation } from "../types.js";

/**
 * Shared browser-side citation activation: resolve a {@link ComponentCitation}
 * to its page/section, navigating cross-page when needed and pulse-highlighting
 * the target. Used by the framework ChatPanels (react/vue/angular); the vanilla
 * embed keeps its richer local-action executor and shares only `safeQuery`.
 *
 * SSR-safe: nothing here touches `window`/`document` at module scope, and every
 * entry point no-ops (with an explanatory outcome) when no DOM is available.
 */

/** sessionStorage key for a citation awaiting replay after navigation. */
export const PENDING_CITATION_KEY = "freebird:pending-citation";

/** Pending citations older than this are considered stale and dropped (ms). */
const PENDING_CITATION_TTL_MS = 60_000;

/** Cap for post-navigation target polling (ms). */
const WAIT_FOR_TARGET_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

/** Highlight pulse duration (ms) — matches the embed's pulse timing. */
const PULSE_MS = 2_400;

export interface CitationActivationOutcome {
  ok: boolean;
  /**
   * "navigating"     — cross-page navigation started; replay happens on load.
   * "page-only"      — citation carries no selector; being on the page is the win.
   * "target-missing" — selector didn't resolve; degraded to page-only.
   * "no-dom"         — no document available (SSR); nothing happened.
   * "wrong-page"     — pending replay found itself on an unexpected page.
   */
  detail?: string;
}

export interface ActivateCitationOptions {
  /** Defaults to the global document. */
  doc?: Document;
  /**
   * Host hook for client-side routing (React Router, Vue Router, …).
   * Return `false` to fall back to a full-page `location.assign`; any other
   * return (including void) means the host handled navigation.
   */
  onNavigate?: (
    path: string,
    citation: ComponentCitation,
  ) => void | boolean | Promise<void | boolean>;
  /** Defaults to the global sessionStorage. Test seam. */
  storage?: Storage;
}

/** Normalize for comparison — ignore trailing slash / query / hash differences. */
const normalizePath = (path: string): string =>
  path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";

const resolveDoc = (doc?: Document): Document | undefined =>
  doc ?? (typeof document !== "undefined" ? document : undefined);

const resolveStorage = (storage?: Storage): Storage | undefined =>
  storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);

/**
 * `querySelector` that never throws and understands id fragments whose ids
 * aren't valid CSS identifiers (e.g. `#2024-pricing` or percent-encoded
 * heading ids) by falling back to `getElementById`.
 */
export const safeQuery = (root: ParentNode, selector: string): Element | null => {
  let found: Element | null = null;
  try {
    found = root.querySelector(selector);
  } catch {
    found = null;
  }
  if (!found && selector.startsWith("#")) {
    const byId = (root as Partial<Document>).getElementById;
    if (typeof byId === "function") {
      try {
        found = byId.call(root as Document, decodeURIComponent(selector.slice(1)));
      } catch {
        found = null;
      }
    }
  }
  return found;
};

/** Scroll the target into view and pulse-highlight it. */
const focusTarget = (el: Element, opts: { instant?: boolean; pulse?: boolean }): void => {
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: opts.instant ? "auto" : "smooth", block: "center" });
  }
  if (opts.pulse === false) return;
  const html = el as HTMLElement;
  if (typeof html.animate === "function") {
    html.animate(
      [
        { boxShadow: "0 0 0 4px rgba(59,130,246,0.9)" },
        { boxShadow: "0 0 0 4px rgba(59,130,246,0)" },
      ],
      { duration: PULSE_MS, easing: "ease-out" },
    );
  } else if (html.style) {
    // No Web Animations (older engines, jsdom): inline outline with cleanup.
    const prev = html.style.outline;
    html.style.outline = "3px solid rgba(59,130,246,0.9)";
    setTimeout(() => {
      html.style.outline = prev;
    }, PULSE_MS);
  }
};

interface PendingCitation {
  citation: ComponentCitation;
  stashedAt: number;
}

const isCitationShape = (value: unknown): value is ComponentCitation =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ComponentCitation).componentId === "string" &&
  typeof (value as ComponentCitation).title === "string";

export const stashPendingCitation = (
  citation: ComponentCitation,
  storage?: Storage,
): void => {
  const store = resolveStorage(storage);
  if (!store) return;
  const pending: PendingCitation = { citation, stashedAt: Date.now() };
  try {
    store.setItem(PENDING_CITATION_KEY, JSON.stringify(pending));
  } catch {
    // Storage full/blocked — the click degrades to plain navigation.
  }
};

/** Pop the pending citation, dropping malformed or stale entries. */
export const readPendingCitation = (storage?: Storage): ComponentCitation | null => {
  const store = resolveStorage(storage);
  if (!store) return null;
  const raw = store.getItem(PENDING_CITATION_KEY);
  if (!raw) return null;
  store.removeItem(PENDING_CITATION_KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCitation>;
    if (!isCitationShape(parsed.citation)) return null;
    if (
      typeof parsed.stashedAt !== "number" ||
      Date.now() - parsed.stashedAt > PENDING_CITATION_TTL_MS
    ) {
      return null;
    }
    return parsed.citation;
  } catch {
    return null;
  }
};

const waitForTarget = (
  doc: Document,
  selector: string,
  timeoutMs = WAIT_FOR_TARGET_TIMEOUT_MS,
): Promise<Element | null> => {
  const existing = safeQuery(doc, selector);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const el = safeQuery(doc, selector);
      if (el || Date.now() - started >= timeoutMs) {
        clearInterval(poll);
        resolve(el);
      }
    }, POLL_INTERVAL_MS);
  });
};

/**
 * Handle a citation chip click: navigate to the citation's page when needed
 * (stashing it for replay after load), otherwise scroll to and pulse the
 * cited section. Missing targets degrade gracefully — reaching the page is
 * treated as success.
 */
export const activateCitation = async (
  citation: ComponentCitation,
  opts: ActivateCitationOptions = {},
): Promise<CitationActivationOutcome> => {
  const doc = resolveDoc(opts.doc);
  if (!doc) return { ok: false, detail: "no-dom" };
  const win = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);

  if (
    citation.page &&
    win &&
    normalizePath(citation.page) !== normalizePath(win.location.pathname)
  ) {
    stashPendingCitation(citation, opts.storage);
    if (opts.onNavigate) {
      const handled = await opts.onNavigate(citation.page, citation);
      if (handled !== false) return { ok: true, detail: "navigating" };
    }
    win.location.assign(citation.page);
    return { ok: true, detail: "navigating" };
  }

  if (!citation.selector) return { ok: true, detail: "page-only" };
  const el = safeQuery(doc, citation.selector);
  if (!el) return { ok: true, detail: "target-missing" };
  focusTarget(el, { pulse: citation.directive !== "scroll-to" });
  return { ok: true };
};

export interface ReplayPendingCitationOptions {
  doc?: Document;
  storage?: Storage;
  /** Target polling cap in ms (SPAs hydrate late). */
  timeoutMs?: number;
}

/**
 * Call on page load / panel mount: if a citation click navigated here, finish
 * the job — wait for the target section to exist, then scroll + pulse.
 * Returns null when nothing was pending.
 */
export const replayPendingCitation = async (
  opts: ReplayPendingCitationOptions = {},
): Promise<CitationActivationOutcome | null> => {
  const citation = readPendingCitation(opts.storage);
  if (!citation) return null;
  const doc = resolveDoc(opts.doc);
  if (!doc) return { ok: false, detail: "no-dom" };
  const win = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);

  if (
    citation.page &&
    win &&
    normalizePath(citation.page) !== normalizePath(win.location.pathname)
  ) {
    return { ok: false, detail: "wrong-page" };
  }

  if (!citation.selector) return { ok: true, detail: "page-only" };
  const el = await waitForTarget(doc, citation.selector, opts.timeoutMs);
  if (!el) return { ok: true, detail: "target-missing" };
  focusTarget(el, { instant: true, pulse: citation.directive !== "scroll-to" });
  return { ok: true };
};
