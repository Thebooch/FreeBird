/**
 * Put a widget — or a setting the chat just changed — in front of the user.
 *
 * Three things now want this — a widget the assistant just built, an
 * `open_widget` action, and a citation chip — and they want it for the same
 * reason: a tile on a full board, possibly one tab away, is not findable by
 * being told its name.
 *
 * Two details make it work, and both were learned the hard way:
 *
 * The tile is **waited for, not assumed**. Whatever caused this — a confirm
 * that wrote server-side, a tab change that refetched the board — completes
 * asynchronously, so at the moment the widget is named its tile does not exist
 * yet. Looking once and giving up meant the board silently never scrolled.
 *
 * The wait is a **timer, not `requestAnimationFrame`**. rAF does not fire in a
 * window that is not compositing, and this has to work in a background tab.
 */

/** Roughly three seconds. Past that the tile is not coming. */
const MAX_ATTEMPTS = 30;
const INTERVAL_MS = 100;
/** How long the ring stays. Matches `dash-landed` in the stylesheet. */
export const RING_MS = 2_600;

export type RingKind = "just-added" | "cited";

export interface ShowWidgetOptions {
  readonly ring?: RingKind;
  /** Called when the tile never appeared, so a caller can drop its state. */
  readonly onGaveUp?: () => void;
  readonly doc?: Document;
}

/**
 * Scroll to whatever `selector` names and ring it — a widget's tile, or a
 * setting on one of the screens the chat can change (`data-freebird-item`
 * inside a `data-freebird-component`). Returns a cancel function, so an
 * effect can stop looking when its input changes.
 */
export const showElement = (
  selector: string,
  options: ShowWidgetOptions = {},
): (() => void) => {
  const doc = options.doc ?? document;
  const ring = options.ring ?? "cited";
  let attempts = 0;
  let timer = 0;

  const look = (): void => {
    const found = doc.querySelector(selector);
    if (!found) {
      if (attempts++ < MAX_ATTEMPTS) timer = window.setTimeout(look, INTERVAL_MS);
      else options.onGaveUp?.();
      return;
    }
    found.setAttribute(`data-${ring}`, "true");
    found.scrollIntoView({ behavior: "smooth", block: "center" });
    timer = window.setTimeout(() => {
      found.removeAttribute(`data-${ring}`);
      options.onGaveUp?.();
    }, RING_MS);
  };

  look();
  return () => window.clearTimeout(timer);
};

/** Scroll to a widget's tile and ring it. */
export const showWidget = (widgetId: string, options: ShowWidgetOptions = {}): (() => void) =>
  showElement(`[data-widget-id="${CSS.escape(widgetId)}"]`, options);
