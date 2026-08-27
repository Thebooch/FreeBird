import type { Presentation } from "@freebirdai/dash-spec";
import { WIDGET_CHROME_ID, defaultPresentationFor, resolvePresentation } from "@freebirdai/dash-spec";
import type { CSSProperties } from "react";

/**
 * Assembling the look of one widget out of the layers that have an opinion.
 *
 * Pure and separate from the components, because the interesting part is the
 * precedence — which layer wins, and what happens when one of them is silent —
 * and none of that needs a DOM to check.
 */

/**
 * Presentations that came from the parts registry, keyed by component id.
 *
 * Already resolved across `builtin -> project -> user` by the server, because
 * a part override is a **whole part rather than a diff**: the highest layer
 * holding one simply is the answer, and re-implementing that resolution in the
 * browser would be a second copy of a rule that already exists.
 */
export type StoredPresentations = Readonly<Record<string, Presentation>>;

export interface PresentationSources {
  /** From `GET /api/presentation`. */
  readonly stored?: StoredPresentations;
  /** From `dashboard.presentation`. */
  readonly board?: Readonly<Record<string, Presentation>>;
}

/**
 * The look of one component on one widget.
 *
 * The compiled-in default goes underneath everything, so a stored override
 * that mentions a single field still behaves — without it, a user part saying
 * only `{ density: "compact" }` would drop every shipped setting beside it,
 * because a whole-part override replaces rather than merges.
 */
export const presentationFor = (
  sources: PresentationSources | undefined,
  id: string,
  widget?: Presentation,
): Presentation =>
  resolvePresentation([
    defaultPresentationFor(id),
    sources?.stored?.[id],
    sources?.board?.[id],
    widget,
  ]);

/**
 * The look of the frame around a widget.
 *
 * A widget's own `presentation` feeds both this and its component: chrome
 * slots (`title`, `badges`, `actions`) and component slots (`header`, `pills`)
 * share one namespace because their ids do not collide, and asking someone to
 * remember which half of an object a switch belongs to would be a worse
 * trade than keeping the names distinct.
 */
export const chromePresentationFor = (
  sources: PresentationSources | undefined,
  widget?: Presentation,
): Presentation => presentationFor(sources, WIDGET_CHROME_ID, widget);

/**
 * Token overrides as an inline style.
 *
 * Custom properties cascade, so setting them on the widget root restyles
 * everything inside it without touching the stylesheet — which means a
 * per-widget colour costs no rebuild and cannot leak to its neighbours.
 */
export const presentationStyle = (presentation: Presentation): CSSProperties | undefined => {
  const entries = Object.entries(presentation.tokens);
  if (entries.length === 0) return undefined;
  const style: Record<string, string> = {};
  for (const [name, value] of entries) style[name] = value;
  return style as CSSProperties;
};
