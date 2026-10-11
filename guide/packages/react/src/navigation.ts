import type { ComponentCitation } from "@freebirdai/core";
import { useEffect, useRef } from "react";
import { useFreeBird } from "./provider.js";

/**
 * Hear where the person asked the chat to take them ("take me to appointment
 * types"), with the engine's `navigation` on. The target is citation-shaped,
 * so the host follows it the way it follows a citation chip:
 * `activateCitation(target, { onNavigate })` from `@freebirdai/core` opens the
 * page through the host's router and brings the element into view, and
 * `replayPendingCitation()` finishes the job once the page has drawn. Changes
 * the chat makes never navigate: they are citation chips on the conversation,
 * followed only if the person clicks.
 */
export const useNavigationRequests = (onNavigate: (target: ComponentCitation) => void): void => {
  const fb = useFreeBird();
  const latest = useRef(onNavigate);
  latest.current = onNavigate;
  useEffect(() => fb.onNavigate((target) => latest.current(target)), [fb]);
};
