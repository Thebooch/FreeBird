import { safeQuery } from "@freebirdai/core";

/** Default cap for post-navigation selector polling (ms). */
export const WAIT_FOR_ELEMENT_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

/**
 * Resolve once `selector` matches in `root`, using MutationObserver with a
 * polling fallback. Used after cross-page navigation when SPAs hydrate late.
 * Uses `safeQuery`, so selectors that aren't valid CSS (e.g. `#2024-pricing`
 * fragment ids) fall back to `getElementById` instead of throwing.
 */
export const waitForElement = (
  root: ParentNode,
  selector: string,
  timeoutMs = WAIT_FOR_ELEMENT_TIMEOUT_MS,
): Promise<Element | null> => {
  const existing = safeQuery(root, selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: Element | null): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(el);
    };

    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            const el = safeQuery(root, selector);
            if (el) finish(el);
          })
        : null;
    observer?.observe(root, { childList: true, subtree: true });

    const poll = setInterval(() => {
      const el = safeQuery(root, selector);
      if (el) finish(el);
    }, POLL_INTERVAL_MS);

    const timer = setTimeout(() => finish(safeQuery(root, selector)), timeoutMs);
  });
};
