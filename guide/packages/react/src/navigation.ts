import type { ComponentCitation } from "@freebirdai/core";
import { useEffect, useRef } from "react";
import { useFreeBird } from "./provider.js";

/**
 * Hear where the person asked the chat to take them ("take me to appointment
 * types"), with the engine's `navigation` on. Opening the page is the host's,
 * since only it knows its router; {@link revealElement} then brings the
 * target into view. Changes the chat makes never navigate: they are citation
 * chips on the conversation, followed only if the person clicks.
 */
export const useNavigationRequests = (onNavigate: (target: ComponentCitation) => void): void => {
  const fb = useFreeBird();
  const latest = useRef(onNavigate);
  latest.current = onNavigate;
  useEffect(() => fb.onNavigate((target) => latest.current(target)), [fb]);
};

export interface RevealElementOptions {
  /** How long to wait for the element: the page it is on may still be rendering. Default 4000 ms. */
  readonly timeoutMs?: number;
  /** How long `data-freebird-revealed` stays on it, for the host's CSS to show. Default 2400 ms. */
  readonly markMs?: number;
  /** Scroll to it and mark it (`highlight`, the default), or only scroll (`scroll-to`). */
  readonly directive?: ComponentCitation["directive"];
  readonly root?: ParentNode;
}

/**
 * Wait for an element, scroll it into view and, for `highlight`, mark it with
 * `data-freebird-revealed` for a moment: what following a citation chip or a
 * navigation request ends in. Resolves with whether it was found. The look of
 * the mark is the host's: style `[data-freebird-revealed]`.
 */
export const revealElement = (selector: string, options: RevealElementOptions = {}): Promise<boolean> => {
  const root = options.root ?? document;
  const find = (): Element | null => {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  };
  const show = (element: Element): true => {
    element.scrollIntoView?.({ block: "center", behavior: "smooth" });
    if ((options.directive ?? "highlight") === "highlight") {
      element.setAttribute("data-freebird-revealed", "");
      setTimeout(() => element.removeAttribute("data-freebird-revealed"), options.markMs ?? 2400);
    }
    return true;
  };
  const now = find();
  if (now) return Promise.resolve(show(now));
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, options.timeoutMs ?? 4000);
    const observer = new MutationObserver(() => {
      const found = find();
      if (!found) return;
      observer.disconnect();
      clearTimeout(deadline);
      resolve(show(found));
    });
    observer.observe(root instanceof Document ? root.documentElement : (root as Node), { childList: true, subtree: true, attributes: true });
  });
};
