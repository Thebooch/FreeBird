import { SERIES_DARK, SERIES_LIGHT } from "./palette.js";

const seriesVars = (colors: readonly string[]): string =>
  colors.map((hex, i) => `  --dash-series-${i + 1}: ${hex};`).join("\n");

/**
 * Dark mode is *selected*, not flipped: the dark column is the same eight hues
 * re-stepped for the dark surface and validated against it as a set.
 *
 * Both scopes are declared — the media query follows the OS, the
 * `[data-theme]` scope follows an explicit toggle, and the toggle wins in both
 * directions (`:not()` lets a light stamp beat OS-dark; `:where()` keeps the
 * media block below the toggle in specificity).
 */
const DARK_TOKENS = `
  --dash-surface: #141a17;
  --dash-plane: #0c100e;
  --dash-ink: #f2f5f3;
  --dash-ink-secondary: #b9c2be;
  --dash-muted: #808b86;
  --dash-grid: #232b27;
  --dash-axis: #333d38;
  --dash-border: rgba(255, 255, 255, 0.1);
  --dash-delta-up: #5fa882;
  --dash-track: #1e2b24;
  --dash-wash: rgba(255, 255, 255, 0.04);

  --dash-accent: #5fa882;
  --dash-accent-strong: #7bbd99;
  --dash-accent-ink: #08120d;
  --dash-accent-wash: rgba(95, 168, 130, 0.14);
  --dash-accent-line: rgba(95, 168, 130, 0.34);

  /*
   * Elevation on a dark plane is light, not shadow.
   *
   * A drop shadow over #0c100e reads as mud, so the raised surface steps *up*
   * a shade and carries a hairline top highlight instead. Same three tokens as
   * light mode, so nothing downstream branches on the mode.
   */
  --dash-surface-raised: #1a221e;
  --dash-surface-sunken: #101614;
  --dash-shadow: none;
  --dash-shadow-sm: 0 1px 0 rgba(255, 255, 255, 0.03) inset;
  --dash-shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
  --dash-shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.6), 0 1px 0 rgba(255, 255, 255, 0.05) inset;
  --dash-ring: rgba(95, 168, 130, 0.32);
${seriesVars(SERIES_DARK)}
`;

export const DASH_STYLES = `
.dash-root {
  color-scheme: light;
  /*
   * Neutrals are cool and near-achromatic with a faint green cast, so the
   * accent reads as deliberate rather than as a colour that wandered in. A
   * crisp white card on a soft plane is the enterprise convention: it makes
   * the widget the object and everything else the background.
   *
   * "--dash-surface" is deliberately unchanged at #ffffff (and #141a17 dark).
   * The series palette's colourblind separation was proved against exactly
   * those two values, and slot order is the safety mechanism — so the restyle
   * moves the *plane* and the elevation and leaves the two surfaces marks are
   * drawn on alone. Anything that changes them has to re-run the validator.
   */
  --dash-surface: #ffffff;
  --dash-surface-raised: #ffffff;
  --dash-surface-sunken: #f0f2f1;
  --dash-plane: #f2f5f3;
  --dash-ink: #0d1211;
  --dash-ink-secondary: #454e4b;
  --dash-muted: #69736f;
  --dash-grid: #e5e8e6;
  --dash-axis: #c8cecb;
  --dash-border: rgba(15, 20, 19, 0.09);
  --dash-delta-up: #1f7a4d;
  --dash-track: #dde8e2;
  --dash-wash: rgba(15, 20, 19, 0.035);

  /*
   * The brand accent, and deliberately NOT a series colour.
   *
   * Chart slots encode which series a mark belongs to; chrome encodes "this is
   * the product". Borrowing series-1 for focus rings and active states (which
   * this did) means a palette change silently restyles the app, and it puts a
   * data colour on things that carry no data.
   *
   * Muted forest at 6.3:1 on the surface — comfortable for text and icons, and
   * for white text on a filled control.
   */
  --dash-accent: #2f6b4f;
  --dash-accent-strong: #24563f;
  --dash-accent-ink: #ffffff;
  --dash-accent-wash: rgba(47, 107, 79, 0.09);
  /* A visible edge in accent, for tints that need a border without a fill. */
  --dash-accent-line: rgba(47, 107, 79, 0.28);
  --dash-ring: rgba(47, 107, 79, 0.28);
${seriesVars(SERIES_LIGHT)}

  /* Reserved status palette — never themed, never reused as a series. */
  --dash-good: #0ca30c;
  --dash-warning: #fab219;
  --dash-serious: #ec835a;
  --dash-critical: #d03b3b;

  /* ── type ──────────────────────────────────────────────────────────────
   * One scale, so a size is chosen from a set rather than typed as a number.
   * Every step up is legible at arm's length: the old sheet leaned on 10px and
   * 11px for anything secondary, which is below what somebody who does not
   * already know what the number means should be asked to parse.
   *
   * "micro" exists for the two places a real grid constrains the glyph — a
   * calendar day cell and a chart tick — and nowhere else.
   */
  --dash-text-micro: 10px;
  --dash-text-2xs: 11px;
  --dash-text-xs: 12px;
  --dash-text-sm: 13px;
  --dash-text-md: 15px;
  --dash-text-lg: 17px;
  --dash-text-xl: 21px;
  --dash-text-2xl: 27px;
  --dash-text-3xl: 36px;
  /* One value, alone on a tile, and the only place type gets this big. */
  --dash-text-hero: 46px;

  --dash-weight-normal: 400;
  --dash-weight-medium: 500;
  --dash-weight-semi: 600;
  --dash-weight-bold: 700;

  --dash-leading-tight: 1.25;
  --dash-leading-normal: 1.5;
  --dash-leading-relaxed: 1.65;

  /* Small caps-ish label treatment, used by every eyebrow in the app. */
  --dash-tracking-label: 0.055em;

  /* ── space ─────────────────────────────────────────────────────────────
   * A 4px rhythm. Component padding reads from the density block below, which
   * sets its own vars from these — so density stays a single attribute and a
   * component never has to know which mode it is in.
   */
  --dash-space-1: 4px;
  --dash-space-2: 8px;
  --dash-space-3: 12px;
  --dash-space-4: 16px;
  --dash-space-5: 20px;
  --dash-space-6: 24px;
  --dash-space-7: 32px;
  --dash-space-8: 40px;

  --dash-radius-sm: 8px;
  --dash-radius: 14px;
  --dash-radius-lg: 20px;
  --dash-radius-pill: 999px;
  --dash-gap: 14px;

  /* ── elevation ─────────────────────────────────────────────────────────
   * Three steps. "sm" is the resting card, "md" is anything that floats over
   * the page (menu, tooltip), "lg" is a sheet. "--dash-shadow" is kept as the
   * name the existing rules use and aliases "sm".
   */
  --dash-shadow-sm: 0 1px 2px rgba(15, 20, 19, 0.05), 0 1px 3px rgba(15, 20, 19, 0.04);
  --dash-shadow-md: 0 4px 12px rgba(15, 20, 19, 0.08), 0 12px 28px rgba(15, 20, 19, 0.07);
  --dash-shadow-lg: 0 8px 24px rgba(15, 20, 19, 0.1), 0 32px 64px rgba(15, 20, 19, 0.12);
  --dash-shadow: var(--dash-shadow-sm);

  /* ── motion ────────────────────────────────────────────────────────────
   * Durations are tokens so the reduced-motion block below can zero all of
   * them in one place. A rule that hardcodes a duration opts itself out of
   * that and has to remember its own media query — which is how an app ends
   * up animating for somebody who asked it not to.
   */
  --dash-dur-fast: 120ms;
  --dash-dur-base: 200ms;
  --dash-dur-slow: 380ms;
  --dash-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dash-ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  --dash-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --dash-font-mono: ui-monospace, SFMono-Regular, "Cascadia Mono", monospace;

  font-family: var(--dash-font);
  font-size: var(--dash-text-sm);
  line-height: var(--dash-leading-normal);
  color: var(--dash-ink);
}

/*
 * Asked not to animate, and answered once.
 *
 * Every transition and animation in both sheets is written against these
 * tokens, so zeroing them here turns the whole app static — including anything
 * added later, which is the point. Rules that must not merely shorten (a
 * looping pulse) still guard themselves.
 */
@media (prefers-reduced-motion: reduce) {
  .dash-root {
    --dash-dur-fast: 0ms;
    --dash-dur-base: 0ms;
    --dash-dur-slow: 0ms;
  }
}

@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .dash-root { color-scheme: dark; ${DARK_TOKENS} }
}
:root[data-theme="dark"] .dash-root { color-scheme: dark; ${DARK_TOKENS} }

.dash-root *, .dash-root *::before, .dash-root *::after { box-sizing: border-box; }

/* ── density ─────────────────────────────────────────────────────────────
 * One scale, declared as tokens and attached to whatever carries the
 * attribute — never to a specific element.
 *
 * That is what lets density nest: the frame carries its own value, a component
 * inside it carries another, and the cascade gives each subtree the nearer
 * one. Tying the scale to the widget frame instead meant a component could
 * advertise a density control that only ever moved the header padding, which
 * is a switch that appears to do nothing.
 */
.dash-root [data-density] {
  --dash-pad-x: var(--dash-space-4);
  --dash-pad-y: var(--dash-space-4);
  --dash-cell-y: var(--dash-space-2);
  --dash-row-gap: var(--dash-space-3);
  --dash-text: var(--dash-text-sm);
}
.dash-root [data-density="compact"] {
  --dash-pad-x: var(--dash-space-3);
  --dash-pad-y: var(--dash-space-2);
  --dash-cell-y: var(--dash-space-1);
  --dash-row-gap: var(--dash-space-2);
  --dash-text: var(--dash-text-xs);
}
.dash-root [data-density="comfortable"] {
  --dash-pad-x: var(--dash-space-5);
  --dash-pad-y: var(--dash-space-5);
  --dash-cell-y: var(--dash-space-3);
  --dash-row-gap: var(--dash-space-4);
  --dash-text: var(--dash-text-md);
}

/* ── widget chrome ─────────────────────────────────────────────────────────
 * The card a widget lives on. The object; everything else is background.
 */
.dash-widget {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm);
  overflow: hidden;
  transition: box-shadow var(--dash-dur-base) var(--dash-ease);
}
/* Borderless: a widget that sits directly on the plane rather than on a card.
   The background goes too — a white panel with no edge on a near-white plane
   reads as a rendering fault rather than as a deliberate choice. */
.dash-widget[data-border="off"] {
  border-color: transparent;
  box-shadow: none;
  background: transparent;
}
.dash-widget__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--dash-space-2);
  padding: var(--dash-pad-y) var(--dash-pad-x) var(--dash-space-2);
  /* Never shrink. The widget is a flex column with a fixed height, so a
     shrinkable header gets squashed below its own content — the title then
     overflows into the body and the table's sticky header paints straight
     over it. Measured at 7-10px of overlap before this. */
  flex: none;
}
.dash-widget__title {
  font-size: var(--dash-text-md);
  font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em;
  line-height: var(--dash-leading-tight);
  color: var(--dash-ink);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-widget__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 var(--dash-pad-x) var(--dash-pad-y);
  display: flex;
  flex-direction: column;
}
/* With no card edge the body no longer needs to inset from one. */
.dash-widget[data-border="off"] .dash-widget__head,
.dash-widget[data-border="off"] .dash-widget__body { padding-left: 0; padding-right: 0; }
/* The description sits on its own line regardless of where the slot order puts
   it in the DOM. Using CSS order rather than markup order is what keeps a
   user-set slot order meaningful without pushing the actions to line two. */
.dash-widget__subtitle {
  order: 99;
  flex-basis: 100%;
  margin: 0;
  font-size: var(--dash-text-xs);
  line-height: var(--dash-leading-normal);
  color: var(--dash-muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.dash-widget__actions { display: inline-flex; gap: 2px; margin-left: auto; }

/* A row count is the cheapest way to notice a filter did something you did not
   mean. It reads as chrome, not as data: muted, small, above the card edge. */
.dash-widget__foot {
  display: flex;
  align-items: baseline;
  gap: var(--dash-space-2);
  flex: none;
  padding: var(--dash-space-2) var(--dash-pad-x);
  border-top: 1px solid var(--dash-border);
  background: var(--dash-surface-sunken);
  font-size: var(--dash-text-2xs);
  color: var(--dash-muted);
  font-variant-numeric: tabular-nums;
}
.dash-widget[data-border="off"] .dash-widget__foot {
  padding-left: 0; padding-right: 0; background: transparent;
}
.dash-widget__count { flex: 1 1 auto; min-width: 0; }
.dash-widget__more { color: var(--dash-serious); }
.dash-widget__updated { flex: none; }
.dash-widget__note {
  font-size: var(--dash-text-xs); color: var(--dash-muted);
  margin-left: auto; white-space: nowrap;
}
/*
 * A related collection that was cut off at the page cap.
 *
 * Above the rows rather than below them: a partial list looks exactly like a
 * complete one, so the caveat has to be read before the data, not after it.
 */
.dash-pane__partial {
  margin: 0 0 var(--dash-space-2);
  font-size: var(--dash-text-xs); color: var(--dash-serious);
  line-height: var(--dash-leading-normal);
}

/* == shared units (ui/) =================================================
 * The controls every component is built from. They live in this sheet, not
 * the app shell one, because the units live in this package: a consumer that
 * takes only @freebirdai/dash-components has to get working controls from one file.
 */
/*
 * One control height across the app.
 *
 * The base type went up a step, so 30px boxes now crowd their own labels.
 * 34px is the size the nav icons already were, which is what makes a row of
 * mixed controls line up instead of stepping.
 */
.dash-control {
  font: inherit;
  font-size: var(--dash-text-sm);
  color: var(--dash-ink);
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  padding: var(--dash-space-1) var(--dash-space-3);
  cursor: pointer;
  min-height: 34px;
  transition: background var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-control:hover { background: var(--dash-wash); }
.dash-control:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

.dash-btn {
  font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  display: inline-flex; align-items: center; gap: var(--dash-space-2);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface); color: var(--dash-ink);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 34px; cursor: pointer;
  white-space: nowrap;
  transition: background var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-btn[data-size="sm"] {
  font-size: var(--dash-text-xs); padding: 3px var(--dash-space-2); min-height: 28px;
}
.dash-btn:hover:not(:disabled) { background: var(--dash-wash); }
.dash-btn:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
/* Dimmed and not-allowed, but still legible: a disabled control nobody can
   read is one nobody can work out how to enable. */
.dash-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.dash-btn[data-tone="primary"] {
  background: var(--dash-accent); border-color: var(--dash-accent);
  color: var(--dash-accent-ink); font-weight: 600;
}
.dash-btn[data-tone="primary"]:hover:not(:disabled) {
  background: var(--dash-accent-strong); border-color: var(--dash-accent-strong);
}
.dash-btn[data-tone="ghost"] { border-color: transparent; background: transparent; }
.dash-btn[data-tone="danger"] { color: var(--dash-critical); }
.dash-btn[data-tone="danger"]:hover:not(:disabled) { border-color: var(--dash-critical); }

.dash-btn__spinner {
  width: 11px; height: 11px; flex: none; border-radius: var(--dash-radius-pill);
  border: 2px solid currentColor; border-top-color: transparent;
}
@media (prefers-reduced-motion: no-preference) {
  .dash-btn__spinner { animation: dash-spin 700ms linear infinite; }
  @keyframes dash-spin { to { transform: rotate(360deg); } }
}

.dash-iconbtn {
  border: none; background: transparent; color: var(--dash-muted);
  cursor: pointer; font-size: var(--dash-text-sm); line-height: 1; padding: 4px 5px; border-radius: var(--dash-radius-sm);
}
.dash-iconbtn:hover:not(:disabled) { background: var(--dash-wash); color: var(--dash-ink); }
.dash-iconbtn:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-iconbtn:disabled { opacity: 0.4; cursor: not-allowed; }
.dash-iconbtn[data-tone="danger"] { color: var(--dash-critical); }
.dash-iconbtn[aria-pressed="true"] { background: var(--dash-accent-wash); color: var(--dash-accent); }

.dash-badge {
  font-size: var(--dash-text-2xs); padding: 1px 6px; border-radius: var(--dash-radius-pill);
  background: var(--dash-wash); color: var(--dash-muted); white-space: nowrap;
}
.dash-badge--stale, .dash-badge[data-tone="stale"] { color: var(--dash-serious); }
.dash-badge--warn, .dash-badge[data-tone="warn"] { color: var(--dash-warning); }
.dash-badge[data-tone="danger"] { color: var(--dash-critical); }
.dash-badge[data-tone="accent"] { color: var(--dash-accent); background: var(--dash-accent-wash); }

.dash-avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; border-radius: var(--dash-radius-pill);
  background: var(--dash-wash); color: var(--dash-ink-secondary);
  font-size: var(--dash-text-2xs); font-weight: 600; letter-spacing: 0.02em;
}
.dash-avatar[data-size="sm"] { width: 18px; height: 18px; font-size: var(--dash-text-micro); }

.dash-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.dash-field > label { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-field input, .dash-field select, .dash-field textarea {
  font: inherit; font-size: var(--dash-text-sm); padding: 7px 9px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink);
  width: 100%;
}
.dash-field input:focus-visible, .dash-field select:focus-visible {
  outline: 2px solid var(--dash-accent); outline-offset: 1px;
}
.dash-hint { font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: 1.5; }

.dash-search { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.dash-search__icon {
  position: absolute; left: 8px; font-size: var(--dash-text-sm); color: var(--dash-muted); pointer-events: none;
}
.dash-search__input {
  font: inherit; font-size: var(--dash-text-sm); color: var(--dash-ink);
  background: var(--dash-surface); border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm); padding: 5px 24px; min-height: 30px;
  width: 100%; min-width: 0;
}
.dash-search__input:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-search__input::-webkit-search-cancel-button { display: none; }
.dash-search__clear {
  position: absolute; right: 4px; border: none; background: transparent;
  color: var(--dash-muted); cursor: pointer; font-size: var(--dash-text-2xs); padding: 4px; border-radius: var(--dash-radius-sm);
}
.dash-search__clear:hover { color: var(--dash-ink); }

.dash-check { display: flex; gap: 9px; align-items: flex-start; font-size: var(--dash-text-sm); cursor: pointer; }
.dash-check[data-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.dash-check input { margin-top: 2px; flex: none; accent-color: var(--dash-accent); }
.dash-check__text { display: flex; flex-direction: column; min-width: 0; }
.dash-check__name { color: var(--dash-ink); }
.dash-check__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }

.dash-menu { position: relative; display: inline-flex; }
.dash-menu__list {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
  min-width: 168px; padding: 4px;
  display: flex; flex-direction: column;
  background: var(--dash-surface); color: var(--dash-ink);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  box-shadow: var(--dash-shadow-md);
}
.dash-menu__item {
  font: inherit; font-size: var(--dash-text-sm); text-align: left;
  display: flex; align-items: center; gap: 8px;
  border: none; background: transparent; color: inherit;
  padding: 6px 9px; border-radius: var(--dash-radius-sm); cursor: pointer; white-space: nowrap;
}
.dash-menu__item[data-active="true"]:not(:disabled) { background: var(--dash-wash); }
.dash-menu__item:disabled { opacity: 0.45; cursor: not-allowed; }
.dash-menu__item[data-tone="danger"] { color: var(--dash-critical); }
/* A rule above the item rather than a separator element: one fewer node, and
   it cannot end up orphaned at the top when the item above it is hidden. */
.dash-menu__item[data-separated="true"] {
  margin-top: 4px; padding-top: 9px; border-top: 1px solid var(--dash-border);
  border-radius: 0 0 7px 7px;
}
.dash-menu__icon { width: 13px; text-align: center; color: var(--dash-muted); flex: none; }

.dash-tabs {
  display: flex; align-items: center; gap: 2px;
  border-bottom: 1px solid var(--dash-border); overflow-x: auto; scrollbar-width: none;
}
.dash-tabs::-webkit-scrollbar { display: none; }
.dash-tabs__tab {
  font: inherit; font-size: var(--dash-text-sm); font-weight: 500; white-space: nowrap; flex: none;
  border: none; background: transparent; color: var(--dash-muted);
  padding: 7px 11px; cursor: pointer;
  /* Transparent rather than absent, so selecting a tab does not shift the
     whole row by two pixels. */
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.dash-tabs__tab:hover { color: var(--dash-ink); }
.dash-tabs__tab[data-selected="true"] {
  color: var(--dash-accent); border-bottom-color: var(--dash-accent);
}
.dash-tabs__tab:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-tabs__meta { margin-left: 6px; font-size: var(--dash-text-xs); font-weight: 400; color: var(--dash-muted); }

.dash-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding-bottom: var(--dash-row-gap, var(--dash-space-3));
}
.dash-toolbar__start { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dash-toolbar__end { display: flex; align-items: center; gap: 6px; flex: none; }

.dash-section-head {
  display: flex; align-items: baseline; gap: var(--dash-space-2);
  margin-bottom: var(--dash-space-2); padding-bottom: var(--dash-space-1);
  border-bottom: 1px solid var(--dash-border);
}
.dash-section-head__title {
  margin: 0;
  font-size: var(--dash-text-2xs); font-weight: var(--dash-weight-semi);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label);
  color: var(--dash-muted);
}
.dash-section-head__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-section-head__actions { margin-left: auto; display: inline-flex; gap: 4px; }

.dash-kbd {
  font-size: var(--dash-text-2xs); font-family: ui-monospace, SFMono-Regular, monospace;
  border: 1px solid var(--dash-border); border-bottom-width: 2px; border-radius: 5px;
  padding: 1px 5px; color: var(--dash-ink-secondary); background: var(--dash-surface);
}

.dash-pager {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 8px; font-size: var(--dash-text-xs); color: var(--dash-muted);
  border-top: 1px solid var(--dash-border); margin-top: auto;
}
.dash-pager__count { flex: 1 1 auto; min-width: 0; }
.dash-pager__controls { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.dash-pager__page { font-variant-numeric: tabular-nums; padding: 0 4px; }

/* Sortable headers are buttons, so they need the header cell's typography
   rather than a browser default. The arrow keeps its column whether or not the
   header is the active one, so nothing shifts as you sort. */
.dash-table__sort {
  font: inherit; font-size: inherit; font-weight: inherit; color: inherit;
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: none; padding: 0; cursor: pointer; white-space: nowrap;
}
.dash-table__sort:hover { color: var(--dash-ink); }
.dash-table__sort:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-table__sort[data-active="true"] { color: var(--dash-accent); }
.dash-table__arrow { opacity: 0.4; font-size: var(--dash-text-micro); }
.dash-table__sort[data-active="true"] .dash-table__arrow { opacity: 1; }
.dash-num .dash-table__sort { flex-direction: row-reverse; }

.dash-table tfoot td {
  position: sticky; bottom: 0;
  background: var(--dash-surface);
  border-top: 1px solid var(--dash-border);
  border-bottom: none;
  font-weight: 600; color: var(--dash-ink);
  padding: var(--dash-cell-y, var(--dash-space-2)) 8px;
}
.dash-table__partial { color: var(--dash-serious); }

/* == metric row ========================================================
 * Tiles laid out by available width rather than by a fixed count: the same
 * widget has to read at 6 columns and at 12 without a breakpoint per size.
 */
.dash-metrics {
  flex: 1 1 auto; min-height: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: var(--dash-row-gap, var(--dash-space-3));
  align-content: center;
  overflow: auto;
}
.dash-metrics[data-align="center"] .dash-metric { align-items: center; text-align: center; }
.dash-metric {
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
  padding: 2px var(--dash-row-gap, var(--dash-space-3)) 2px 0;
}
/* A hairline between tiles rather than a box around each: the tiles already
   sit inside the widget's card, and a card inside a card reads as clutter. */
.dash-metrics[data-dividers="on"] .dash-metric + .dash-metric {
  border-left: 1px solid var(--dash-border);
  padding-left: var(--dash-row-gap, var(--dash-space-3));
}
.dash-metric__label { display: flex; align-items: center; gap: 6px; min-width: 0; }
/*
 * The label is a caption and the number is the content.
 *
 * A tile whose label and value sit at similar weights makes the reader do the
 * work of deciding which one they came for. Uppercase caption above, tabular
 * display figure below, and the gap between them does the rest.
 */
.dash-metric__name {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-metric__value {
  font-size: var(--dash-text-2xl); font-weight: var(--dash-weight-semi);
  line-height: var(--dash-leading-tight); letter-spacing: -0.02em;
  color: var(--dash-ink);
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-metrics[data-density="compact"] .dash-metric__value { font-size: var(--dash-text-xl); }
.dash-metrics[data-density="comfortable"] .dash-metric__value { font-size: var(--dash-text-3xl); }
.dash-metric__delta {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--dash-text-xs); font-weight: 500; font-variant-numeric: tabular-nums;
}
.dash-metric__delta--up { color: var(--dash-delta-up); }
.dash-metric__delta--down { color: var(--dash-critical); }
.dash-metric__delta--flat { color: var(--dash-muted); }
.dash-metric__track {
  height: 4px; border-radius: var(--dash-radius-pill); background: var(--dash-track);
  overflow: hidden; margin-top: 2px;
}
.dash-metric__fill { height: 100%; background: var(--dash-accent); border-radius: var(--dash-radius-pill); }
.dash-metric__caption {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* == cards ============================================================= */
.dash-cards-grid {
  flex: 1 1 auto; min-height: 0;
  display: grid; gap: var(--dash-row-gap, var(--dash-space-3));
  align-content: start; overflow: auto;
}
.dash-card-tile {
  display: flex; flex-direction: column; gap: 4px; min-width: 0;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  padding: var(--dash-row-gap, var(--dash-space-3));
  background: var(--dash-surface);
}
.dash-card-tile.dash-row-open:hover { border-color: var(--dash-accent); }
.dash-card-tile__image {
  width: 100%; height: 88px; object-fit: cover;
  border-radius: var(--dash-radius-sm); background: var(--dash-wash);
  margin-bottom: 2px;
}
.dash-card-tile__head { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.dash-card-tile__title {
  margin: 0; flex: 1 1 auto; min-width: 0;
  font-size: var(--dash-text-sm); font-weight: 600; color: var(--dash-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-card-tile__title a { color: inherit; text-decoration: none; }
.dash-card-tile__title a:hover { text-decoration: underline; }
.dash-card-tile__subtitle {
  margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-card-tile__meta {
  margin: 4px 0 0; display: flex; flex-wrap: wrap; gap: 2px 14px;
  font-size: var(--dash-text-xs);
}
.dash-card-tile__fact { display: flex; flex-direction: column; min-width: 0; }
.dash-card-tile__fact dt { color: var(--dash-muted); font-size: var(--dash-text-2xs); }
.dash-card-tile__fact dd {
  margin: 0; color: var(--dash-ink-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* == record header ======================================================
 * The block that turns a list of pairs into a record.
 *
 * Identity first at heading weight, then the state it is in, then the two to
 * four values somebody opened this record to check — as a stat row, because
 * a number worth leading with should not be sitting in the same typographic
 * register as the forty rows below it.
 */
.dash-record-head {
  display: flex; flex-direction: column; gap: var(--dash-space-1);
  padding-bottom: var(--dash-space-3);
}
.dash-record-head__identity {
  display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap;
}
.dash-record-head__title {
  margin: 0;
  font-size: var(--dash-text-xl); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.015em; line-height: var(--dash-leading-tight);
  color: var(--dash-ink);
  overflow-wrap: anywhere;
}
.dash-record-head__subtitle {
  margin: 0; font-size: var(--dash-text-sm); color: var(--dash-muted);
}
/*
 * Facts sit in a row and wrap, so two read the same way as five. Each is a
 * label above a value rather than beside it — the eye scans the values in one
 * pass and drops to a label only for the one it stopped on.
 */
.dash-record-head__facts {
  margin: var(--dash-space-4) 0 0;
  display: flex; flex-wrap: wrap; gap: var(--dash-space-3) var(--dash-space-6);
  padding: var(--dash-space-3) var(--dash-space-4);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  background: var(--dash-surface-sunken);
}
.dash-record-head__fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-record-head__fact dt {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label);
}
.dash-record-head__fact dd {
  margin: 0;
  font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi);
  color: var(--dash-ink); font-variant-numeric: tabular-nums;
}

/* == record sections ====================================================
 * A heading per section, ruled, so a long record reads as three or four
 * groups of related things rather than as forty rows of equal weight.
 */
.dash-record__section + .dash-record__section { margin-top: var(--dash-space-5); }
/* Multi-column field lists. The pairs stay grid rows, so labels line up down
   each column instead of drifting with the value above them. */
.dash-record[data-columns="2"], .dash-record[data-columns="3"] {
  display: grid; gap: 0 var(--dash-space-6);
}
.dash-record[data-columns="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dash-record[data-columns="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 760px) {
  .dash-record[data-columns="2"], .dash-record[data-columns="3"] {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* == board ============================================================== */
.dash-board {
  flex: 1 1 auto; min-height: 0;
  display: flex; gap: var(--dash-row-gap, var(--dash-space-3));
  overflow: auto; align-items: flex-start;
}
.dash-board__column {
  display: flex; flex-direction: column; gap: 6px; flex: none;
  max-height: 100%; min-height: 0;
}
.dash-board__head {
  display: flex; align-items: center; gap: 6px; flex: none;
  padding-bottom: 4px; border-bottom: 2px solid var(--dash-border);
}
.dash-board__name {
  font-size: var(--dash-text-xs); font-weight: 600; color: var(--dash-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-board__count {
  margin-left: auto; font-size: var(--dash-text-2xs); color: var(--dash-muted);
  background: var(--dash-wash); border-radius: var(--dash-radius-pill); padding: 1px 6px;
  font-variant-numeric: tabular-nums;
}
.dash-board__cards {
  display: flex; flex-direction: column; gap: 6px;
  overflow: auto; min-height: 0; padding: 2px 2px 4px;
}
.dash-board__card {
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface); padding: 8px 9px;
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.dash-board__card.dash-row-open:hover { border-color: var(--dash-accent); }
.dash-board__title { font-size: var(--dash-text-sm); color: var(--dash-ink); overflow-wrap: anywhere; }
.dash-board__subtitle {
  font-size: var(--dash-text-xs); color: var(--dash-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-board__foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.dash-board__meta {
  margin-left: auto; font-size: var(--dash-text-2xs); color: var(--dash-muted);
  font-variant-numeric: tabular-nums;
}

/* == timeline ===========================================================
 * The rail is a border on the list, so it runs continuously behind every
 * entry rather than being drawn per item and leaving gaps at the joins.
 */
.dash-timeline-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dash-timeline {
  list-style: none; margin: 0; padding: 0 0 0 16px;
  border-left: 2px solid var(--dash-border);
}
.dash-timeline__item {
  position: relative; display: flex; align-items: flex-start; gap: 8px;
  padding: var(--dash-row-gap, var(--dash-space-3)) 0;
}
.dash-timeline__item + .dash-timeline__item { border-top: 1px solid var(--dash-border); }
.dash-timeline__dot {
  position: absolute; left: -21px; top: calc(var(--dash-row-gap, var(--dash-space-3)) + 4px);
  width: 8px; height: 8px; border-radius: var(--dash-radius-pill);
  background: var(--dash-accent);
  /* A ring in the surface colour so the dot sits on the rail rather than
     looking threaded onto it. */
  box-shadow: 0 0 0 2px var(--dash-surface);
}
.dash-timeline__body { flex: 1 1 auto; min-width: 0; }
.dash-timeline__when {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.dash-timeline__title { font-size: var(--dash-text-sm); color: var(--dash-ink); overflow-wrap: anywhere; }
.dash-timeline__subtitle { font-size: var(--dash-text-xs); color: var(--dash-muted); overflow-wrap: anywhere; }
.dash-timeline__aside {
  margin: 10px 0 4px; font-size: var(--dash-text-xs); color: var(--dash-muted);
}

/* == feed =============================================================== */
.dash-feed-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dash-feed { list-style: none; margin: 0; padding: 0; }
.dash-feed__day + .dash-feed__day { margin-top: 10px; }
.dash-feed__date {
  position: sticky; top: 0; z-index: 1;
  margin: 0 0 2px; padding: 4px 0;
  background: var(--dash-surface);
  font-size: var(--dash-text-2xs); font-weight: 600; color: var(--dash-muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.dash-feed__item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: var(--dash-row-gap, var(--dash-space-3)) 0;
  border-bottom: 1px solid var(--dash-border);
}
.dash-feed__item:last-child { border-bottom: none; }
.dash-feed__body { flex: 1 1 auto; min-width: 0; }
.dash-feed__line { font-size: var(--dash-text-sm); color: var(--dash-ink); overflow-wrap: anywhere; }
.dash-feed__actor { font-weight: 600; margin-right: 5px; }
.dash-feed__title a { color: inherit; text-decoration: none; }
.dash-feed__title a:hover { text-decoration: underline; }
.dash-feed__subtitle { font-size: var(--dash-text-xs); color: var(--dash-muted); overflow-wrap: anywhere; }
.dash-feed__side {
  display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none;
}
.dash-feed__when { font-size: var(--dash-text-2xs); color: var(--dash-muted); white-space: nowrap; }
.dash-feed__meta {
  font-size: var(--dash-text-2xs); color: var(--dash-ink-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}

/* == progress =========================================================== */
.dash-progress-list {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; gap: var(--dash-row-gap, var(--dash-space-3));
}
.dash-progress-row { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-progress-row__head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dash-progress-row__label {
  font-size: var(--dash-text-xs); color: var(--dash-ink); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-progress-row__value {
  margin-left: auto; font-size: var(--dash-text-xs); color: var(--dash-ink-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dash-progress-row__track {
  height: 7px; border-radius: var(--dash-radius-pill); background: var(--dash-track); overflow: hidden;
}
.dash-progress-row__fill { height: 100%; background: var(--dash-accent); border-radius: var(--dash-radius-pill); }
.dash-progress-list__note {
  margin: 2px 0 0; font-size: var(--dash-text-2xs); color: var(--dash-muted);
}

/* == funnel ============================================================= */
.dash-funnel {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; gap: var(--dash-row-gap, var(--dash-space-3));
}
.dash-funnel__stage { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-funnel__head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dash-funnel__label {
  font-size: var(--dash-text-xs); color: var(--dash-ink); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-funnel__value {
  margin-left: auto; font-size: var(--dash-text-sm); font-weight: 600; color: var(--dash-ink);
  font-variant-numeric: tabular-nums;
}
.dash-funnel__track { height: 16px; background: var(--dash-track); border-radius: 4px; overflow: hidden; }
.dash-funnel__bar { height: 100%; border-radius: 4px; }
.dash-funnel__drop { font-size: var(--dash-text-2xs); color: var(--dash-muted); }

/* == calendar =========================================================== */
.dash-calendar {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; gap: 6px;
}
.dash-calendar__bar { display: flex; align-items: center; gap: 4px; flex: none; }
.dash-calendar__month {
  font-size: var(--dash-text-sm); font-weight: 600; color: var(--dash-ink); min-width: 9ch;
}
.dash-calendar__reset {
  font: inherit; font-size: var(--dash-text-2xs); margin-left: auto;
  border: none; background: none; color: var(--dash-accent); cursor: pointer;
}
.dash-calendar__weekdays {
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; flex: none;
  font-size: var(--dash-text-2xs); color: var(--dash-muted); text-align: center;
}
.dash-calendar__grid {
  flex: 1 1 auto; min-height: 0;
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr); gap: 2px;
}
.dash-calendar__day {
  border: 1px solid var(--dash-border); border-radius: 5px;
  padding: 2px 3px; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; gap: 1px; overflow: hidden;
}
/* Days from the neighbouring months are dimmed rather than blank: an event on
   the 1st that falls on a Sunday has to be somewhere. */
.dash-calendar__day[data-in-month="false"] { opacity: 0.45; }
.dash-calendar__day[data-today="true"] { border-color: var(--dash-accent); }
.dash-calendar__date {
  font-size: var(--dash-text-2xs); color: var(--dash-muted); font-variant-numeric: tabular-nums; flex: none;
}
.dash-calendar__day[data-today="true"] .dash-calendar__date {
  color: var(--dash-accent); font-weight: 700;
}
.dash-calendar__entries { display: flex; flex-direction: column; gap: 1px; min-height: 0; overflow: hidden; }
.dash-calendar__entry {
  font: inherit; font-size: var(--dash-text-2xs); text-align: left;
  display: flex; align-items: center; gap: 3px;
  border: none; border-radius: 3px; padding: 1px 3px;
  background: var(--dash-wash); color: var(--dash-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-calendar__entry:not(:disabled) { cursor: pointer; }
.dash-calendar__entry:not(:disabled):hover { background: var(--dash-accent-wash); }
.dash-calendar__tick { width: 5px; height: 5px; border-radius: var(--dash-radius-pill); flex: none; }
.dash-calendar__more { font-size: var(--dash-text-micro); color: var(--dash-muted); padding-left: 3px; }

/* == states =============================================================
 * Five distinct ones, because "no rows in this range", "your key expired"
 * and "this binding no longer matches the data" are three different
 * problems and a spinner that never resolves tells you none of them.
 */
.dash-state {
  flex: 1 1 auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--dash-space-2); text-align: center; padding: var(--dash-space-5);
}
/*
 * The glyph gets a disc to sit on.
 *
 * A bare character floating above two lines of grey text reads as a rendering
 * artefact rather than as a designed state — and these states are seen often,
 * because being honest about them is most of what this library is for.
 */
.dash-state__glyph {
  width: 44px; height: 44px; flex: none;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--dash-radius-pill);
  background: var(--dash-surface-sunken);
  border: 1px solid var(--dash-border);
  font-size: var(--dash-text-lg); color: var(--dash-muted); line-height: 1;
  margin-bottom: var(--dash-space-1);
}
/* A failure is not an empty result, and must not look like one. */
.dash-state[data-tone="error"] .dash-state__glyph {
  color: var(--dash-critical);
  border-color: var(--dash-critical);
  background: transparent;
  font-weight: var(--dash-weight-bold);
}
.dash-state__title {
  margin: 0; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  color: var(--dash-ink); line-height: var(--dash-leading-normal);
}
.dash-state__body {
  margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted);
  line-height: var(--dash-leading-normal); max-width: 44ch;
}
.dash-state__detail {
  margin: 0; padding-left: var(--dash-space-4); text-align: left;
  font-size: var(--dash-text-xs); color: var(--dash-muted);
  line-height: var(--dash-leading-normal);
}

/* == skeleton ===========================================================
 * The shape of whatever is about to arrive, so the tile does not visibly
 * change form when the data lands. Defined here and nowhere else.
 */
.dash-skeleton {
  flex: 1 1 auto; display: flex; flex-direction: column;
  gap: var(--dash-space-2); padding-bottom: var(--dash-space-2);
}
.dash-skeleton[data-shape="list"] { justify-content: flex-end; }
.dash-skeleton__bar, .dash-skeleton__col, .dash-skeleton__tile,
.dash-skeleton__stage, .dash-skeleton__spark {
  background: var(--dash-wash); border-radius: var(--dash-radius-sm);
}
.dash-skeleton__bar { height: 9px; flex: none; }
.dash-skeleton__plot {
  flex: 1 1 auto; min-height: 0;
  display: flex; align-items: flex-end; gap: var(--dash-space-2);
}
.dash-skeleton__col { flex: 1 1 0; min-width: 0; border-radius: 6px 6px 2px 2px; }
.dash-skeleton__spark { flex: 1 1 auto; min-height: 0; }
.dash-skeleton__grid {
  flex: 1 1 auto; min-height: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--dash-space-2); align-content: start;
}
.dash-skeleton__tile { height: 48px; }
.dash-skeleton__funnel {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--dash-space-2);
}
.dash-skeleton__stage { height: 15px; }
/*
 * A sweep rather than a pulse.
 *
 * A block fading its whole opacity up and down reads as something broken
 * blinking at you; a highlight travelling across it reads as loading, which is
 * what it is. Guarded rather than shortened — an infinite animation is not
 * something to run at zero duration.
 */
@media (prefers-reduced-motion: no-preference) {
  .dash-skeleton__bar, .dash-skeleton__col, .dash-skeleton__tile,
  .dash-skeleton__stage, .dash-skeleton__spark {
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      var(--dash-wash) 40%,
      var(--dash-wash) 60%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: dash-sweep 1.6s ease-in-out infinite;
  }
  @keyframes dash-sweep {
    from { background-position: 120% 0 }
    to { background-position: -20% 0 }
  }
}

/* ── chart surface ───────────────────────────────────────────────────────── */
.dash-chart { flex: 1 1 auto; min-height: 0; position: relative; }
.dash-chart svg { display: block; width: 100%; height: 100%; overflow: visible; }
.dash-grid-line { stroke: var(--dash-grid); stroke-width: 1; shape-rendering: crispEdges; }
.dash-axis-line { stroke: var(--dash-axis); stroke-width: 1; shape-rendering: crispEdges; }
.dash-tick {
  font-size: var(--dash-text-2xs);
  fill: var(--dash-muted);
  font-variant-numeric: tabular-nums;
}
.dash-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dash-area { stroke: none; opacity: 0.1; }
/* The 2px ring in the surface colour keeps a dot legible where marks cross. */
.dash-dot { stroke: var(--dash-surface); stroke-width: 2; }
.dash-label { font-size: var(--dash-text-xs); fill: var(--dash-ink-secondary); font-weight: 500; }
.dash-label--inverse { fill: #ffffff; }

/* ── legend ──────────────────────────────────────────────────────────────── */
.dash-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding-top: 8px;
  font-size: var(--dash-text-xs);
  color: var(--dash-ink-secondary);
}
.dash-legend__item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dash-legend__swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.dash-legend__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── tooltip ─────────────────────────────────────────────────────────────── */
.dash-tooltip {
  position: absolute;
  pointer-events: none;
  z-index: 5;
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  box-shadow: var(--dash-shadow-md);
  padding: 8px 10px;
  font-size: var(--dash-text-xs);
  min-width: 120px;
  max-width: 240px;
  transform: translate(-50%, -100%);
}
.dash-tooltip__head { color: var(--dash-muted); margin-bottom: 5px; }
.dash-tooltip__row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
.dash-tooltip__value {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--dash-ink);
  font-weight: 600;
}
.dash-crosshair { stroke: var(--dash-axis); stroke-width: 1; shape-rendering: crispEdges; }

/* ── stat ────────────────────────────────────────────────────────────────── */
.dash-stat { display: flex; flex-direction: column; justify-content: center; height: 100%; gap: 4px; position: relative; }
.dash-stat__value {
  font-size: var(--dash-text-3xl); font-weight: var(--dash-weight-semi);
  line-height: 1.05; letter-spacing: -0.025em; color: var(--dash-ink);
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
}
.dash-stat__value--hero { font-size: var(--dash-text-hero); }
.dash-stat__delta { display: inline-flex; align-items: center; gap: 4px; font-size: var(--dash-text-sm); font-weight: 500; }
.dash-stat__delta--up { color: var(--dash-delta-up); }
.dash-stat__delta--down { color: var(--dash-critical); }
.dash-stat__delta--flat { color: var(--dash-muted); }
.dash-stat__caption { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-stat__spark { height: 34px; margin-top: 6px; }

/* ── table ───────────────────────────────────────────────────────────────── */
.dash-table-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dash-table { width: 100%; border-collapse: collapse; font-size: var(--dash-text, var(--dash-text-sm)); }
/*
 * Headers recede and rows lead.
 *
 * A header is a label for a column, not content: uppercase at caption size in
 * muted ink says "this names the thing below" without competing with it. The
 * sunken background is what keeps it legible once rows scroll under it.
 */
.dash-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dash-surface-sunken);
  text-align: left;
  font-weight: var(--dash-weight-semi);
  font-size: var(--dash-text-2xs);
  letter-spacing: var(--dash-tracking-label);
  text-transform: uppercase;
  color: var(--dash-muted);
  padding: var(--dash-space-2) var(--dash-space-3);
  border-bottom: 1px solid var(--dash-border);
  white-space: nowrap;
}
.dash-table td {
  padding: var(--dash-cell-y, var(--dash-space-2)) var(--dash-space-3);
  border-bottom: 1px solid var(--dash-border);
  color: var(--dash-ink);
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dash-table tr:last-child td { border-bottom: none; }
/* A row lights up under the pointer whether or not it opens anything: it is
   how you keep your place across fourteen columns. The open-row class adds the
   cursor, which is the part that promises an interaction. */
.dash-table tbody tr { transition: background var(--dash-dur-fast) var(--dash-ease); }
.dash-table tbody tr:hover td { background: var(--dash-wash); }

/* Striping is a wash rather than a second surface colour, so it composes with
   a highlight's left rule instead of covering it. */
.dash-table[data-zebra="on"] tbody tr:nth-child(even) td { background: var(--dash-wash); }

/*
 * A frozen first column needs its own background or the scrolled cells show
 * through it, and a right edge or there is nothing to say it is pinned.
 *
 * Scoped to "on", not to the attribute existing. The attribute is always
 * present and carries "off" when the column is not frozen, so the valueless
 * selector matched every table — painting the first header cell the surface
 * colour while its neighbours took the header's own, which put a visible seam
 * down the left of every header row the moment the two stopped being the same
 * colour.
 */
.dash-table[data-sticky-first="on"] th:first-child,
.dash-table[data-sticky-first="on"] td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--dash-surface);
  border-right: 1px solid var(--dash-border);
}
/* The header's own corner sits above both, being sticky in two directions. */
.dash-table[data-sticky-first="on"] th:first-child { z-index: 2; background: var(--dash-surface-sunken); }
.dash-table td.dash-num {
  text-align: right; font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum"; color: var(--dash-ink);
}

/* ── highlights ──────────────────────────────────────────────────────────── */
/*
 * A left rule plus a labelled pill.
 *
 * The rule rather than a background wash: it survives zebra striping, does not
 * fight the row's own hover state, and stays visible in forced-colours mode
 * where a background would be dropped. And the pill carries the label, so the
 * colour is never the only channel — which is the invariant, not a detail.
 */
.dash-row-tone > td:first-child { position: relative; }
.dash-row-tone--good > td:first-child { box-shadow: inset 3px 0 0 var(--dash-good); }
.dash-row-tone--warning > td:first-child { box-shadow: inset 3px 0 0 var(--dash-warning); }
.dash-row-tone--serious > td:first-child { box-shadow: inset 3px 0 0 var(--dash-serious); }
.dash-row-tone--critical > td:first-child { box-shadow: inset 3px 0 0 var(--dash-critical); }
.dash-row-tone--neutral > td:first-child { box-shadow: inset 3px 0 0 var(--dash-muted); }
.dash-cell-pill { margin-left: var(--dash-space-2); vertical-align: middle; }
.dash-record__marks {
  display: flex; flex-wrap: wrap; gap: var(--dash-space-2);
  margin: 0 0 var(--dash-space-3);
}

/* ── record ──────────────────────────────────────────────────────────────── */
.dash-record-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dash-record__heading {
  margin: 0 0 var(--dash-space-3);
  font-size: var(--dash-text-lg);
  font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em;
  color: var(--dash-ink);
}
.dash-record { margin: 0; font-size: var(--dash-text, var(--dash-text-sm)); }
/* Two columns rather than a table: a label column that shrinks to its content
   and a value column that takes the rest, so long values wrap instead of
   pushing the label off the edge. */
.dash-record__pair {
  display: grid;
  grid-template-columns: minmax(120px, 32%) 1fr;
  gap: var(--dash-space-4);
  align-items: baseline;
  padding: var(--dash-space-2) 0;
  border-bottom: 1px solid var(--dash-border);
}
.dash-record__pair:last-child { border-bottom: none; }
/*
 * The label recedes and the value leads.
 *
 * They used to be near enough the same colour and size, which made a record
 * read as a wall of text with no obvious scanning axis. The value now wears
 * the primary ink and a touch more weight, so the eye runs down the right
 * column and only reads a label when it stops.
 */
.dash-record__pair dt {
  color: var(--dash-muted);
  font-size: var(--dash-text-xs);
  font-weight: var(--dash-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
}
.dash-record__pair dd {
  margin: 0;
  color: var(--dash-ink);
  font-size: var(--dash-text-sm);
  /* A record is where the whole value belongs, so it wraps rather than
     truncating — the opposite of a table cell. */
  overflow-wrap: anywhere;
}
/* An empty value is stated, not left blank. A blank right-hand column reads as
   a rendering fault; an em-dash reads as "this record does not have one". */
.dash-record__pair dd:empty::after { content: "—"; color: var(--dash-axis); }
/* A flattened child sits under its parent's name, with a rule rather than an
   indent — indentation alone at this size reads as an accident. */
.dash-record__pair--nested dt {
  padding-left: var(--dash-space-3);
  border-left: 2px solid var(--dash-border);
  margin-left: 1px;
}

/* ── list ────────────────────────────────────────────────────────────────── */
.dash-list { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0; padding: 0; list-style: none; }
.dash-list__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: var(--dash-row-gap, var(--dash-space-3)) 0;
  border-bottom: 1px solid var(--dash-border);
  font-size: var(--dash-text, var(--dash-text-sm));
}
.dash-list__item:last-child { border-bottom: none; }
.dash-list__text { min-width: 0; flex: 1 1 auto; }
.dash-list__title { color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-list__title a { color: inherit; text-decoration: none; }
.dash-list__title a:hover { text-decoration: underline; }
.dash-list__subtitle { color: var(--dash-muted); font-size: var(--dash-text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-list__meta { color: var(--dash-ink-secondary); font-size: var(--dash-text-xs); white-space: nowrap; font-variant-numeric: tabular-nums; }

/* ── status ──────────────────────────────────────────────────────────────── */
.dash-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--dash-space-1);
  font-size: var(--dash-text-2xs);
  font-weight: var(--dash-weight-medium);
  padding: 2px var(--dash-space-2);
  border: 1px solid transparent;
  border-radius: var(--dash-radius-pill);
  background: var(--dash-wash);
  color: var(--dash-ink-secondary);
  white-space: nowrap;
}
/*
 * Tinted from the reserved status palette, which is never themed and never
 * reused as a series colour. Mixing keeps one definition per tone rather
 * than a hand-mixed pair per mode, and the fallback above is what shows where
 * it is unsupported — a legible grey pill, with the label still on it.
 */
.dash-pill[data-tone="good"] {
  background: color-mix(in srgb, var(--dash-good) 12%, transparent);
  border-color: color-mix(in srgb, var(--dash-good) 32%, transparent);
}
.dash-pill[data-tone="warning"] {
  background: color-mix(in srgb, var(--dash-warning) 16%, transparent);
  border-color: color-mix(in srgb, var(--dash-warning) 38%, transparent);
}
.dash-pill[data-tone="serious"] {
  background: color-mix(in srgb, var(--dash-serious) 14%, transparent);
  border-color: color-mix(in srgb, var(--dash-serious) 36%, transparent);
}
.dash-pill[data-tone="critical"] {
  background: color-mix(in srgb, var(--dash-critical) 12%, transparent);
  border-color: color-mix(in srgb, var(--dash-critical) 32%, transparent);
}
.dash-pill[data-tone="neutral"] { border-color: var(--dash-border); }
.dash-pill__icon { font-size: var(--dash-text-micro); line-height: 1; }
.dash-status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; overflow: auto; align-content: start; flex: 1 1 auto; min-height: 0; }
.dash-status-tile { border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dash-status-tile__label { font-size: var(--dash-text-sm); color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-status-tile__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── gauge ───────────────────────────────────────────────────────────────── */
.dash-gauge { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; }
.dash-gauge__track { fill: none; stroke: var(--dash-track); stroke-linecap: round; }
.dash-gauge__fill { fill: none; stroke-linecap: round; }
.dash-gauge__value { font-size: var(--dash-text-xl); font-weight: 600; fill: var(--dash-ink); }
.dash-gauge__caption { font-size: var(--dash-text-xs); fill: var(--dash-muted); }

/* ── empty / message ─────────────────────────────────────────────────────── */
.dash-message {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 16px;
  font-size: var(--dash-text-sm);
  color: var(--dash-muted);
  line-height: 1.5;
}

/* ── chart motion ────────────────────────────────────────────────────────
 * Marks arrive rather than appear.
 *
 * One rule, and it is not decoration: the transition from skeleton to chart
 * is where somebody's eye is, and a plot that materialises fully formed gives
 * no sense of what changed. A bar growing from its baseline and a line drawing
 * itself left to right both say "this is the axis this data is measured on".
 *
 * Deliberately short and deliberately once. Nothing here loops, nothing
 * re-runs on hover — React keeps the same nodes, so the animation plays on the
 * paint the data lands in and never again.
 */
@media (prefers-reduced-motion: no-preference) {
  /*
   * "transform-box: fill-box" is what makes the origin the bar's own left
   * edge rather than the SVG's. Without it every bar would scale from the
   * canvas origin and fly in from the corner.
   */
  .dash-bar {
    transform-box: fill-box;
    transform-origin: left center;
    animation: dash-grow var(--dash-dur-slow) var(--dash-ease-out) both;
  }
  @keyframes dash-grow {
    from { transform: scaleX(0) }
    to { transform: scaleX(1) }
  }

  /*
   * The line draws itself. A pathLength of 1 on the path normalises its length
   * so one dash rule works for every shape without measuring anything in JS.
   */
  .dash-line {
    stroke-dasharray: 1;
    animation: dash-draw 700ms var(--dash-ease-out) both;
  }
  @keyframes dash-draw {
    from { stroke-dashoffset: 1 }
    to { stroke-dashoffset: 0 }
  }

  /* Everything that hangs off the line follows it rather than racing it. */
  .dash-area, .dash-dot {
    animation: dash-fade-mark var(--dash-dur-slow) var(--dash-ease) both;
    animation-delay: 260ms;
  }
  @keyframes dash-fade-mark {
    from { opacity: 0 }
  }
  .dash-line, .dash-dot { transition: opacity var(--dash-dur-fast) var(--dash-ease); }
}
`;
