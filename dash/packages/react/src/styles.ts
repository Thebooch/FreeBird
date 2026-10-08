/*
 * The app-shell sheet: page, grid, sheet, nav, chat, connection wizard.
 *
 * The shared control units (button, icon button, badge, field) moved to the
 * components package when they became real units in `ui/`. A consumer using
 * only @freebirdai/dash-components has to get working controls out of one stylesheet.
 */
import { DASH_CALENDAR_STYLES } from "./styles-calendar.js";

export const DASH_REACT_STYLES = `
.dash-page { background: var(--dash-plane); min-height: 100%; padding: 16px; }
.dash-page__head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.dash-page__title { font-size: var(--dash-text-lg); font-weight: 650; margin: 0; color: var(--dash-ink); }
.dash-page__description { font-size: var(--dash-text-sm); color: var(--dash-muted); margin: 0; }

/* Filters sit in one row above the charts, with Refresh all on the right. */
.dash-params { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.dash-params__group { display: inline-flex; align-items: center; gap: 6px; }
.dash-params__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }

/* == grid ===============================================================
 * The library positions items with transforms and inline sizes; everything
 * here is the chrome around that. Its stylesheet is inlined rather than
 * imported, because a tsup-built ESM package that imports CSS forces every
 * consumer to own a CSS loader — and this library ships with none.
 */
.dash-grid-host { position: relative; min-width: 0; }
.react-grid-layout { position: relative; transition: height var(--dash-dur-base) var(--dash-ease); }
.react-grid-item { box-sizing: border-box; }
.react-grid-item.cssTransforms { transition-property: transform, width, height; }
.react-grid-item:not(.react-draggable-dragging):not(.resizing) {
  transition: transform var(--dash-dur-base) var(--dash-ease), width var(--dash-dur-base) var(--dash-ease), height var(--dash-dur-base) var(--dash-ease);
}
/* Nothing animates while the pointer is down: a tile easing toward the cursor
   reads as lag rather than as polish. */
.react-grid-item.react-draggable-dragging { transition: none; z-index: 4; will-change: transform; }
.react-grid-item.resizing { transition: none; z-index: 4; }
.react-grid-item.react-grid-placeholder {
  background: var(--dash-accent-wash);
  border: 2px dashed var(--dash-accent);
  border-radius: var(--dash-radius);
  opacity: 0.85;
  z-index: 2;
  transition-duration: 100ms;
  user-select: none;
}
.react-resizable-hide > .react-resizable-handle { display: none; }

.dash-grid__cell { min-width: 0; height: 100%; position: relative; }

/* The lazy wrapper must be invisible to layout: the widget fills the cell, and
   an extra box that does not stretch would leave every tile short. */
.dash-lazy { height: 100%; min-width: 0; display: flex; flex-direction: column; }
.dash-lazy > * { flex: 1 1 auto; min-height: 0; }
.dash-lazy__hold {
  flex: 1 1 auto;
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  background: var(--dash-surface);
}

/* == edit mode ==========================================================
 * The board only becomes draggable on purpose. Outside edit mode the grid is
 * inert and looks it: no handles, no grab cursor, nothing promising an
 * interaction that will not happen.
 */
.dash-grid-host[data-editing="true"] {
  /* A dot per grid cell, so the arrangement being edited is visible rather
     than inferred from where the tiles happen to land. */
  background-image: radial-gradient(var(--dash-axis) 1px, transparent 1px);
  background-size: 24px 24px;
  border-radius: var(--dash-radius);
}
.dash-grid-host[data-editing="true"] .dash-widget {
  box-shadow: 0 0 0 1px var(--dash-accent-wash), var(--dash-shadow);
  cursor: grab;
}
.dash-grid-host[data-editing="true"] .react-draggable-dragging .dash-widget {
  cursor: grabbing;
  opacity: 0.92;
  transform: scale(1.01);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--dash-accent);
}

/*
 * A transparent sheet over each tile while editing.
 *
 * A mousedown meant as the start of a drag otherwise lands on whatever is
 * underneath — a sort header, a row that opens a record, a link — so
 * rearranging the board keeps triggering the things on it.
 */
.dash-edit-guard { position: absolute; inset: 0; z-index: 5; }

.react-resizable-handle {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  z-index: 6;
  opacity: 0;
  border-radius: 4px;
  background: linear-gradient(135deg, transparent 46%, var(--dash-accent) 46%);
  transition: opacity var(--dash-dur-fast) var(--dash-ease);
}
.dash-grid-host[data-editing="true"] .react-resizable-handle { opacity: 0.75; }
.dash-grid-host[data-editing="true"] .react-grid-item:hover .react-resizable-handle { opacity: 1; }

.dash-edit-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 12px; padding: 8px 12px;
  border: 1px solid var(--dash-accent); border-radius: var(--dash-radius);
  background: var(--dash-accent-wash);
  font-size: var(--dash-text-sm); color: var(--dash-ink-secondary);
}
.dash-edit-banner__actions { margin-left: auto; display: inline-flex; gap: 6px; }


/*
 * Skeletons, states and the other shared units are defined ONCE, in the
 * components sheet.
 *
 * They used to be declared here too. Both sheets are concatenated into one
 * <style> with this one last, so the copy here silently won every shared
 * property — including a "justify-content: flex-end" that pushed a chart
 * skeleton's columns to the bottom of the tile. The rule now: a component's
 * styling lives in @freebirdai/dash-components, this file owns app-shell chrome, and
 * nothing is declared in both.
 */

.dash-inspector-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 50;
}
.dash-inspector {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  width: min(760px, 100%); max-height: 86vh; display: flex; flex-direction: column; overflow: hidden;
}
.dash-inspector__head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dash-border); }
.dash-inspector__title { font-size: var(--dash-text-md); font-weight: 600; margin: 0; }
.dash-inspector__body { overflow: auto; padding: 12px 16px 18px; }
.dash-inspector h4 { font-size: var(--dash-text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--dash-muted); margin: 16px 0 6px; }
.dash-inspector h4:first-child { margin-top: 0; }
.dash-inspector__kv { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 3px 12px; font-size: var(--dash-text-sm); }
.dash-inspector__kv dt { color: var(--dash-muted); }
.dash-inspector__kv dd { margin: 0; color: var(--dash-ink); word-break: break-all; }
.dash-steps { width: 100%; border-collapse: collapse; font-size: var(--dash-text-sm); }
.dash-steps th, .dash-steps td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--dash-border); }
.dash-steps th { color: var(--dash-muted); font-weight: 500; font-size: var(--dash-text-xs); }
.dash-steps td.dash-num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 14px; }
.dash-steps code { font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); }
.dash-payload {
  background: var(--dash-plane); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  padding: 10px; font-size: var(--dash-text-xs); max-height: 220px; overflow: auto; margin: 0;
  white-space: pre; color: var(--dash-ink-secondary);
}
.dash-warnlist { margin: 0; padding-left: 18px; font-size: var(--dash-text-sm); color: var(--dash-serious); }
.dash-errlist { margin: 0; padding-left: 18px; font-size: var(--dash-text-sm); color: var(--dash-critical); }

/* ── connection manager ──────────────────────────────────────────────────── */
.dash-steps-rail { display: flex; gap: 6px; align-items: center; font-size: var(--dash-text-xs); color: var(--dash-muted); margin-bottom: 14px; flex-wrap: wrap; }
.dash-steps-rail__step { display: inline-flex; align-items: center; gap: 5px; }
.dash-steps-rail__dot {
  width: 18px; height: 18px; border-radius: var(--dash-radius-pill); display: inline-flex;
  align-items: center; justify-content: center; font-size: var(--dash-text-2xs); font-weight: 600;
  background: var(--dash-wash); color: var(--dash-muted);
}
.dash-steps-rail__step[data-state="active"] { color: var(--dash-ink); font-weight: 600; }
.dash-steps-rail__step[data-state="active"] .dash-steps-rail__dot { background: var(--dash-accent); color: var(--dash-accent-ink); }
.dash-steps-rail__step[data-state="done"] .dash-steps-rail__dot { background: var(--dash-good); color: #fff; }
.dash-steps-rail__sep { color: var(--dash-border); }

.dash-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.dash-card {
  text-align: left; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  padding: 12px; background: var(--dash-surface); cursor: pointer; font: inherit;
  color: var(--dash-ink); display: flex; flex-direction: column; gap: 5px; min-width: 0;
}
.dash-card:hover { background: var(--dash-wash); }
.dash-card:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-card__title { font-size: var(--dash-text-md); font-weight: 600; }
.dash-card__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-card__badges { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 2px; }


/*
 * A row that opens the record behind it.
 *
 * The affordance appears only when a drill-down actually exists — a cursor
 * that promises an interaction which never happens is worse than none.
 */
.dash-row-open { cursor: pointer; }
.dash-row-open:hover { background: var(--dash-surface-2, rgba(127, 127, 127, 0.08)); }
.dash-row-open:focus-visible {
  outline: 2px solid var(--dash-accent); outline-offset: -2px;
}

/* == the record drawer ==================================================
 * What a row opens. A panel rather than a dialog in the middle of the
 * screen: a record belongs beside the thing it came from, and the board
 * staying visible behind it is what makes closing it feel like stepping
 * back rather than navigating.
 */
.dash-sheet-backdrop {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(8, 12, 10, 0.42);
  display: flex; justify-content: flex-end;
  animation: dash-fade-in var(--dash-dur-base) var(--dash-ease) both;
}
.dash-sheet {
  background: var(--dash-surface-raised); color: var(--dash-ink);
  border-left: 1px solid var(--dash-border);
  width: min(760px, 100%); height: 100%;
  display: flex; flex-direction: column;
  box-shadow: var(--dash-shadow-lg);
  animation: dash-slide-in var(--dash-dur-slow) var(--dash-ease-out) both;
}
/*
 * The heading is a block, not a line.
 *
 * The trail sits above at caption weight and the record's own name below at
 * heading weight, so a record three levels down still says plainly what you
 * are looking at instead of trailing off the end of a breadcrumb.
 */
.dash-sheet__head {
  display: flex; flex-direction: column; gap: var(--dash-space-1);
  padding: var(--dash-space-4) var(--dash-space-5) var(--dash-space-3);
  border-bottom: 1px solid var(--dash-border);
  background: var(--dash-surface-raised);
  flex: none;
}
.dash-sheet__trail {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--dash-space-1);
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
}
.dash-sheet__bar { display: flex; align-items: center; gap: var(--dash-space-2); min-width: 0; }
.dash-sheet__title {
  margin: 0; flex: 1 1 auto; min-width: 0;
  font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em; line-height: var(--dash-leading-tight);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-sheet__close { flex: none; font-size: var(--dash-text-xs); }
.dash-sheet__sub {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  font-weight: var(--dash-weight-semi);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label);
  margin: 0 0 var(--dash-space-2);
}
.dash-sheet__body {
  padding: var(--dash-space-5); overflow: auto; flex: 1;
  display: flex; flex-direction: column; gap: var(--dash-space-4);
}
/*
 * Sections stack down the sheet, each on its own card.
 *
 * They used to be separated by a hairline, which made a record and the four
 * collections under it read as one long undifferentiated scroll. A card per
 * collection is what says "this is a different set of things".
 */
.dash-sheet__section {
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  background: var(--dash-surface);
  box-shadow: var(--dash-shadow-sm);
  padding: var(--dash-space-4);
  display: flex; flex-direction: column; min-width: 0;
}
/* An earlier step of the trail. A control, so it looks and behaves like one. */
.dash-sheet__crumb {
  background: none; border: none; padding: 0;
  font: inherit; font-size: var(--dash-text-2xs);
  color: var(--dash-muted); cursor: pointer; border-radius: var(--dash-radius-sm);
}
.dash-sheet__crumb:hover { color: var(--dash-accent); text-decoration: underline; }
.dash-sheet__crumb:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-sheet__crumb-sep { color: var(--dash-axis); }

@keyframes dash-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes dash-slide-in {
  from { transform: translateX(16px); opacity: 0 }
  to { transform: translateX(0); opacity: 1 }
}

/* On a narrow screen the sheet is the whole surface, not a side panel. */
@media (max-width: 640px) {
  .dash-sheet { width: 100%; border-left: none; }
  .dash-sheet__body { padding: var(--dash-space-4) var(--dash-space-3); }
}

/* Groups a credential's name with its value so the pairing is visible. */
.dash-keyblock {
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  padding: 10px 12px 2px; margin: 0 0 10px;
}
.dash-keyblock > legend {
  font-size: var(--dash-text-xs); color: var(--dash-muted); padding: 0 6px;
}
.dash-keyblock .dash-field:last-of-type { margin-bottom: 10px; }
.dash-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dash-row--end { justify-content: flex-end; }

.dash-callout {
  border: 1px solid var(--dash-border); border-left-width: 3px; border-radius: var(--dash-radius-sm);
  padding: 10px 12px; font-size: var(--dash-text-sm); line-height: 1.5; margin: 10px 0;
  color: var(--dash-ink-secondary);
}
.dash-callout--good { border-left-color: var(--dash-good); }
.dash-callout--bad { border-left-color: var(--dash-critical); }
.dash-callout--info { border-left-color: var(--dash-accent); }
.dash-callout strong { color: var(--dash-ink); }

/*
 * Determinate on purpose. The read it tracks is paced to a known duration, so
 * an indeterminate spinner would be throwing away information we actually have.
 */
.dash-progress {
  height: 6px; border-radius: 3px; overflow: hidden; margin: 10px 0;
  background: var(--dash-wash); border: 1px solid var(--dash-border);
}
.dash-progress__bar {
  height: 100%; background: var(--dash-accent);
  transition: width var(--dash-dur-fast) linear;
}
@media (prefers-reduced-motion: reduce) {
  .dash-progress__bar { transition: none; }
}

/* == workspace nav ======================================================
 * Where you are, and the handful of things you can do from anywhere. Sticky,
 * because the tabs are how you move around and a long board should not
 * strand you at the bottom of it.
 */
/*
 * The bar is dark in both modes.
 *
 * It is the one piece of chrome that never belongs to the page: a charcoal
 * rail top and bottom frames the board the same way whichever theme is on,
 * and it stops the white nav and the white widget cards from running together
 * into one undifferentiated sheet.
 *
 * The palette below is deliberately NOT named --dash-*. The overflow popover
 * is absolutely positioned *inside* this element (and hosts the model sheet),
 * so anything written into the --dash-* scope here would be inherited by a
 * menu that is drawn on the light plane. Re-declaring the light values on the
 * popover to undo that would be worse: it would hard-code light and break
 * real dark mode. Bar-local names cannot leak, because nothing downstream
 * reads them.
 */
.dash-nav {
  --nav-ink: #f4f4f2;
  --nav-ink-dim: rgba(244, 244, 242, 0.60);
  --nav-ink-faint: rgba(244, 244, 242, 0.45);
  --nav-fill: rgba(255, 255, 255, 0.04);
  --nav-fill-hover: rgba(255, 255, 255, 0.07);
  --nav-fill-active: rgba(255, 255, 255, 0.10);
  --nav-line: rgba(255, 255, 255, 0.13);
  --nav-mint: #7fd8d0;

  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 18px;
  padding: var(--dash-space-2) 22px; min-height: 56px;
  background: linear-gradient(180deg, #22262b, #15171a);
  /* Light, not shadow: a drop shadow under a dark bar on a warm plane reads as
     a smudge, where a one-pixel top highlight reads as a lit edge. */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  border-bottom: none;
}
.dash-nav__brand {
  display: inline-flex; align-items: center; gap: 9px; flex: none;
  font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.02em; color: var(--nav-ink);
  padding-right: 18px; border-right: 1px solid var(--nav-line);
  /* The switch lives inside this segment, beside the name. */
}
.dash-nav__mark {
  width: 20px; height: 20px; border-radius: var(--dash-radius-xs); flex: none;
  /* Mint to deep teal: the full brand ramp in one 20px tile, which is the only
     place both ends of it appear together. */
  background: linear-gradient(140deg, #3fb5ad, var(--dash-accent));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.10), 0 2px 6px rgba(0, 0, 0, 0.4);
}

/* The Agent | Tabs switch: two segments in one ring, the active one lit. */
.dash-nav__switch {
  margin-left: 4px; display: inline-flex; flex: none; padding: 2px; gap: 2px;
  border: 1px solid var(--nav-line); border-radius: var(--dash-radius-pill);
  background: var(--nav-fill);
}
.dash-nav__seg {
  font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  border: 0; border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 28px;
  background: transparent; color: var(--nav-ink-dim); cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__seg:hover { color: var(--nav-ink); }
.dash-nav__seg[data-active="true"] { background: var(--nav-fill-active); color: #ffffff; font-weight: var(--dash-weight-semi); }
.dash-nav__seg:focus-visible { outline: 2px solid var(--nav-mint); outline-offset: 1px; }

/* The Agent | Tabs switch: two segments in one ring, the active one lit. */
.dash-nav__switch {
  display: inline-flex; flex: none; padding: 2px; gap: 2px;
  border: 1px solid var(--nav-line); border-radius: var(--dash-radius-pill);
  background: var(--nav-fill);
}
.dash-nav__seg {
  font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  border: 0; border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 28px;
  background: transparent; color: var(--nav-ink-dim); cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__seg:hover { color: var(--nav-ink); }
.dash-nav__seg[data-active="true"] { background: var(--nav-fill-active); color: #ffffff; font-weight: var(--dash-weight-semi); }
.dash-nav__seg:focus-visible { outline: 2px solid var(--nav-mint); outline-offset: 1px; }

.dash-nav__rail {
  display: flex; align-items: center; gap: var(--dash-space-1);
  min-width: 0; flex: 1 1 auto;
  overflow-x: auto; scrollbar-width: none;
}
.dash-nav__rail::-webkit-scrollbar { display: none; }
.dash-nav__hint { font-size: var(--dash-text-xs); color: var(--nav-ink-faint); white-space: nowrap; }

.dash-nav__tab {
  font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  white-space: nowrap; flex: none;
  border: 1px solid transparent; border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 32px;
  background: transparent; color: var(--nav-ink-dim);
  cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease),
              color var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__tab:hover { background: var(--nav-fill-hover); color: var(--nav-ink); }
/* The active tab is a tint plus a ring, not a solid fill: at this size a
   filled pill next to five others reads as a button, not as "you are here".
   On the dark bar the tint is white rather than accent — the deep teal that
   marks selection on the light plane is a 1.4:1 smudge on charcoal. */
.dash-nav__tab[data-active="true"] {
  background: var(--nav-fill-active);
  border-color: var(--nav-line);
  color: #ffffff;
  font-weight: var(--dash-weight-semi);
}
.dash-nav__tab:focus-visible { outline: 2px solid var(--nav-mint); outline-offset: 1px; }

.dash-nav__tab--editing {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  border: 1px solid var(--nav-line); border-radius: var(--dash-radius-pill);
  padding: 2px var(--dash-space-1) 2px var(--dash-space-3); background: var(--nav-fill-hover);
}
.dash-nav__rename {
  font: inherit; font-size: var(--dash-text-sm); width: 11ch; min-width: 6ch;
  border: none; background: transparent; color: var(--nav-ink); padding: 3px 0;
}
.dash-nav__rename:focus-visible { outline: none; }
.dash-nav__x, .dash-nav__confirm {
  font: inherit; border: none; background: transparent; cursor: pointer;
  color: var(--nav-ink-faint); border-radius: var(--dash-radius-pill);
  padding: 3px var(--dash-space-2); line-height: 1;
}
.dash-nav__x { font-size: var(--dash-text-2xs); }
/* #d03b3b is a 3.4:1 warning on white and 2.6:1 here, so destructive intent on
   the bar is carried by the lighter step of the same hue. */
.dash-nav__x:hover { color: #ff8b8b; background: var(--nav-fill-hover); }
.dash-nav__confirm {
  font-size: var(--dash-text-xs); color: #ff8b8b;
  font-weight: var(--dash-weight-semi);
}

.dash-nav__add {
  font: inherit; font-size: var(--dash-text-sm); white-space: nowrap; flex: none;
  border: 1px dashed rgba(255, 255, 255, 0.16); border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 32px;
  background: transparent; color: var(--nav-ink-faint); cursor: pointer;
  transition: border-color var(--dash-dur-fast) var(--dash-ease),
              color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__add:hover { border-color: rgba(63, 181, 173, 0.6); color: var(--nav-mint); }

.dash-nav__actions { display: flex; align-items: center; gap: var(--dash-space-2); flex: none; }
.dash-nav__icon {
  font: inherit; font-size: var(--dash-text-sm); cursor: pointer;
  width: 34px; height: 34px; border-radius: var(--dash-radius-sm);
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.10); background: var(--nav-fill);
  color: rgba(244, 244, 242, 0.66);
  transition: color var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease),
              background var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__icon:hover { color: var(--nav-ink); background: var(--nav-fill-active); }
.dash-nav__icon[data-on="true"] {
  border-color: rgba(63, 181, 173, 0.34); background: rgba(63, 181, 173, 0.14);
  color: var(--nav-mint);
}
/*
 * The assistant is the one promoted action in the bar, so it carries the
 * filled accent while the edit and overflow icons beside it stay neutral.
 *
 * It stays a 34px square with only the glyph in it. Labelling it "Assistant"
 * would widen the one control whose position people learn fastest, and the
 * title and aria-label already name it for anyone who needs the word.
 *
 * Written as its own attribute rather than by recolouring the shared
 * dash-nav__icon rule, which the edit and overflow buttons also use. Both
 * selectors below out-specify the data-on rule above and sit after it, so
 * the open state restyles the fill instead of reverting it to the neutral
 * wash.
 */
/*
 * Literal teal, not var(--dash-accent).
 *
 * The bar it sits on is the same charcoal in both themes, so a button that
 * followed the accent token would be deep teal in light mode and mint in dark
 * — two different buttons on an identical bar. The backdrop is fixed, so the
 * fill on it is fixed too. White on #0f4d52 is 9.7:1 either way.
 */
.dash-nav__icon[data-accent="true"] {
  border-color: transparent;
  background: linear-gradient(180deg, #146066, #0f4d52);
  color: #ffffff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 2px 8px -2px rgba(15, 77, 82, 0.5);
  transition: filter var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__icon[data-accent="true"]:hover {
  color: #ffffff; border-color: transparent; filter: brightness(1.12);
}
/* Open reads as pressed: the ramp inverts and the lift becomes a recess. */
.dash-nav__icon[data-accent="true"][data-on="true"] {
  background: linear-gradient(180deg, #0f4d52, #146066);
  color: #ffffff; border-color: transparent;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}
.dash-control[data-on="true"] {
  border-color: var(--dash-accent-line); background: var(--dash-accent-wash); color: var(--dash-accent);
}

/* The overflow menu: one button in the bar, everything else a click away.
 *
 * The bar used to carry six controls plus the tabs, which made the two things
 * you actually navigate with — the tabs and the assistant — compete with four
 * things you touch once a session. These live behind a single disclosure now.
 * Anchored to its trigger rather than fixed, so it tracks the button when the
 * action group wraps to its own row on a narrow window. */
.dash-nav__menu { position: relative; display: inline-flex; }
.dash-nav__pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 5;
  min-width: 216px; padding: var(--dash-space-1);
  display: flex; flex-direction: column; gap: 2px;
  background: var(--dash-surface);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-md);
}
/* Carried by the rows themselves rather than by a bare descendant rule: the
   model sheet renders inside this popover, and its own controls must not come
   out dressed as menu rows. */
.dash-nav__pop .dash-nav__item {
  font: inherit; font-size: var(--dash-text-sm); text-align: left; white-space: nowrap;
  display: flex; align-items: center; gap: var(--dash-space-2);
  width: 100%; min-height: 32px; padding: var(--dash-space-1) var(--dash-space-2);
  border: 1px solid transparent; border-radius: var(--dash-radius-sm);
  background: transparent; color: var(--dash-ink); cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease),
              color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__pop .dash-nav__item:hover:not(:disabled) { background: var(--dash-wash); }
.dash-nav__pop .dash-nav__item:disabled { color: var(--dash-muted); cursor: not-allowed; }
.dash-nav__pop .dash-nav__item[data-on="true"] {
  border-color: var(--dash-accent-line); background: var(--dash-accent-wash); color: var(--dash-accent);
}
.dash-nav__pop .dash-nav__item:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-nav__sep { height: 1px; margin: var(--dash-space-1) 0; background: var(--dash-border); }
/* Standing behind one of its own sheets: the panel gets out of the way but
   stays in the tree, because the sheet renders inside it. */
.dash-nav__pop[data-sheet="open"] {
  padding: 0; background: none; border-color: transparent; box-shadow: none;
}
.dash-nav__pop[data-sheet="open"] > .dash-nav__item,
.dash-nav__pop[data-sheet="open"] > .dash-nav__sep { display: none; }

@media (max-width: 900px) {
  .dash-nav { flex-wrap: wrap; gap: var(--dash-space-2); }
  .dash-nav__rail { order: 3; width: 100%; }
  .dash-nav__switch { order: 1; }
  /*
   * The action group takes a row of its own and wraps inside it.
   *
   * Allowing it to wrap is not enough on its own, which took two goes to get
   * right: with a flex value of none the container is still sized to its content on
   * one line, so the wrap had nothing to wrap *within* and the buttons pushed
   * the page into horizontal scroll — the one thing the layout must never do.
   * Giving it the full row is what bounds it.
   */
  .dash-nav__actions {
    flex: 1 1 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
  }
}

/* == empty state =========================================================
 * What a brand-new install opens on. The shell is real and present — only
 * the data is missing — so the two things worth doing are the only two
 * things offered.
 */
.dash-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--dash-space-3); text-align: center;
  min-height: 62vh; padding: var(--dash-space-8) var(--dash-space-5);
}
/*
 * A mark rather than an icon font or an illustration.
 *
 * Two concentric rings in the accent: enough shape that the page reads as
 * designed rather than unfinished, and nothing to load, nothing to license,
 * and nothing that has to be redrawn for dark mode.
 */
.dash-empty__mark {
  width: 68px; height: 68px; border-radius: var(--dash-radius-pill); flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--dash-accent-wash);
  color: var(--dash-accent); font-size: var(--dash-text-2xl);
  box-shadow: 0 0 0 10px var(--dash-accent-wash);
  margin-bottom: var(--dash-space-2);
}
.dash-empty__title {
  font-size: var(--dash-text-xl); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.02em; color: var(--dash-ink); margin: 0;
}
.dash-empty__body {
  font-size: var(--dash-text-md); color: var(--dash-muted); margin: 0;
  max-width: 52ch; line-height: var(--dash-leading-relaxed);
}
.dash-empty__actions {
  display: flex; gap: var(--dash-space-2); flex-wrap: wrap; justify-content: center;
  margin-top: var(--dash-space-2);
}
.dash-btn--primary {
  background: var(--dash-accent); color: var(--dash-accent-ink);
  border-color: var(--dash-accent); font-weight: var(--dash-weight-semi);
}
.dash-btn--primary:hover {
  background: var(--dash-accent-strong); border-color: var(--dash-accent-strong);
}

/* ── chat column ─────────────────────────────────────────────────────────
 * A full-height accordion on the right, ported from the embed widget's
 * "full-right" position. One difference that matters: the embed *overlays*
 * the page, while here the dashboard reflows out of the way — a panel that
 * covers the widgets you are asking about is the wrong shape for this.
 */
.dash-shell {
  margin-right: 0;
  transition: margin-right var(--dash-dur-slow) var(--dash-ease);
}
.dash-shell[data-chat="open"] { margin-right: var(--dash-chat-width, 380px); }

/*
 * Building a widget needs room to show it.
 *
 * One variable does both halves: the shell reads it as a right margin and the
 * column reads it as a width, and the column is a descendant of the shell. The
 * board reflows narrower rather than being covered, so what is being built
 * stays next to what it is being added to.
 */
.dash-shell[data-building="true"] { --dash-chat-width: 640px; }
@media (max-width: 1180px) {
  .dash-shell[data-building="true"] { --dash-chat-width: 460px; }
}

.dash-chat {
  position: fixed; top: 0; right: 0; height: 100%; z-index: 40;
  width: var(--dash-chat-width, 380px); max-width: 90vw;
  display: flex; flex-direction: column;
  background: var(--dash-surface);
  border-left: 1px solid var(--dash-border);
  /* Off-screen rather than hidden: width cannot animate smoothly, transform can. */
  transform: translateX(100%);
  transition: transform var(--dash-dur-slow) var(--dash-ease);
}
.dash-chat[data-open="true"] { transform: translateX(0); }

.dash-chat__head {
  display: flex; align-items: center; gap: var(--dash-space-3);
  min-height: 52px; padding: var(--dash-space-2) var(--dash-space-3) var(--dash-space-2) var(--dash-space-4);
  border-bottom: 1px solid var(--dash-border);
  background: var(--dash-surface);
  flex: none;
}
.dash-chat__title {
  font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.015em; margin: 0; color: var(--dash-ink);
}

.dash-chat__log {
  flex: 1; overflow-y: auto;
  padding: var(--dash-space-4) var(--dash-space-4) var(--dash-space-6);
  display: flex; flex-direction: column; gap: var(--dash-space-2);
  background: var(--dash-surface-sunken);
}

.dash-chat__msg {
  font-size: var(--dash-text-sm); line-height: var(--dash-leading-normal);
  white-space: pre-wrap; word-break: break-word;
  padding: 9px 13px;
  border-radius: 12px;
  max-width: 86%;
  animation: dash-msg-in var(--dash-dur-base) var(--dash-ease-out) both;
}
@keyframes dash-msg-in {
  from { opacity: 0; transform: translateY(4px) }
  to { opacity: 1; transform: none }
}
.dash-chat__msg[data-role="user"] {
  align-self: flex-end;
  background: var(--dash-accent); color: var(--dash-accent-ink);
  /* One squared corner points the bubble at its own side of the column. */
  border-bottom-right-radius: 4px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.dash-chat__msg[data-role="assistant"] {
  align-self: flex-start;
  background: var(--dash-surface-raised); color: var(--dash-ink);
  border: 1px solid var(--dash-border);
  border-bottom-left-radius: 4px;
  box-shadow: var(--dash-shadow-sm);
}
/* A change of speaker gets a little more air than a run from one side. */
.dash-chat__msg[data-role="user"] + .dash-chat__msg[data-role="assistant"],
.dash-chat__msg[data-role="assistant"] + .dash-chat__msg[data-role="user"] { margin-top: var(--dash-space-2); }
.dash-chat__msg[data-role="tool"] {
  align-self: stretch; max-width: 100%;
  background: transparent; border: 1px dashed var(--dash-border-strong);
  color: var(--dash-muted); font-size: var(--dash-text-xs);
}

/*
 * Footnotes under a reply: where it came from, and how far it looked.
 *
 * Deliberately quiet and deliberately below the text. A citation is a place
 * to go and a coverage note is a limit on the claim above it - neither is the
 * assistant speaking, so neither should read like part of the sentence.
 */
.dash-chat__cites {
  display: flex; flex-wrap: wrap; gap: var(--dash-space-1);
  margin-top: var(--dash-space-2);
}
.dash-chat__cite {
  font: inherit; font-size: var(--dash-text-xs); line-height: 1.2;
  padding: 2px var(--dash-space-2);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-pill);
  background: var(--dash-surface); color: var(--dash-muted);
  cursor: pointer; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: color var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat__cite::before { content: "↗ "; opacity: 0.7; }
.dash-chat__cite:hover { color: var(--dash-accent); border-color: var(--dash-accent); }
.dash-chat__cite:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

/* The corner, where a limit on the claim belongs. */
.dash-chat__coverage {
  display: flex; justify-content: flex-end; align-items: baseline;
  flex-wrap: wrap; gap: var(--dash-space-1);
  margin-top: var(--dash-space-2);
  font-size: var(--dash-text-xs); color: var(--dash-muted);
  text-align: right;
}
.dash-chat__deeper {
  font: inherit; padding: 0; border: 0; background: none;
  color: var(--dash-accent); cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.dash-chat__deeper:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }

/*
 * The wait, with something honest in it.
 *
 * The dots say the turn is alive; the line beside them says what it is doing,
 * and it is only ever the name of an action the server actually started. A
 * generated stream of "reasoning" would fill the same space and mean nothing,
 * which is the failure this product is built to avoid everywhere else.
 */
.dash-chat__thinking {
  display: inline-flex; align-items: center; gap: var(--dash-space-2);
  color: var(--dash-muted);
}
.dash-chat__thinking-text { font-size: var(--dash-text-xs); }
.dash-chat__dots { display: inline-flex; gap: 3px; flex: none; }
.dash-chat__dots i {
  width: 5px; height: 5px; border-radius: var(--dash-radius-pill);
  background: currentColor; opacity: 0.35;
}
@media (prefers-reduced-motion: no-preference) {
  .dash-chat__dots i { animation: dash-blink 1.2s ease-in-out infinite; }
  .dash-chat__dots i:nth-child(2) { animation-delay: 0.16s; }
  .dash-chat__dots i:nth-child(3) { animation-delay: 0.32s; }
  @keyframes dash-blink {
    0%, 60%, 100% { opacity: 0.25; transform: translateY(0) }
    30% { opacity: 1; transform: translateY(-2px) }
  }
}

.dash-chat__form {
  display: flex; align-items: flex-end; gap: var(--dash-space-2);
  padding: var(--dash-space-3) var(--dash-space-4) var(--dash-space-4);
  border-top: 1px solid var(--dash-border);
  background: var(--dash-surface);
  flex: none;
}
.dash-chat__input {
  flex: 1; font: inherit; font-size: var(--dash-text-sm); resize: none;
  color: var(--dash-ink); background: var(--dash-surface-raised);
  border: 1px solid var(--dash-border-strong); border-radius: 10px;
  padding: 9px var(--dash-space-3);
  min-height: 40px; max-height: 140px;
  line-height: var(--dash-leading-normal);
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat__input::placeholder { color: var(--dash-muted); }
.dash-chat__input:focus-visible {
  outline: none; border-color: var(--dash-accent);
  box-shadow: 0 0 0 3px var(--dash-ring);
}
.dash-chat__input:disabled { opacity: 0.6; cursor: not-allowed; }
.dash-chat__send {
  height: 40px; padding: 0 var(--dash-space-4); border-radius: 10px;
  font-weight: var(--dash-weight-semi);
  background: var(--dash-accent); color: var(--dash-accent-ink); border-color: transparent;
}
.dash-chat__send:hover:not(:disabled) { background: var(--dash-accent-strong); }
.dash-chat__send:disabled { background: var(--dash-wash); color: var(--dash-muted); border-color: var(--dash-border); }

.dash-chat__empty {
  font-size: var(--dash-text-sm); color: var(--dash-muted);
  line-height: var(--dash-leading-relaxed);
  padding: var(--dash-space-4); margin: 0;
  border: 1px dashed var(--dash-border-strong); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface);
}

/*
 * One stream, divided by day and by topic (plan 3). The dividers are quiet
 * on purpose: they are where the reader is, not something said.
 */
.dash-chat__log[hidden], .dash-chat__form[hidden] { display: none; }

/* Chat | Timeline as a segmented control: two views of one thing, not pages. */
.dash-chat__tabs { display: flex; min-width: 0; }
.dash-chat__tabs .dash-tabs {
  border-bottom: 0; gap: 2px; padding: 2px;
  background: var(--dash-wash);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
}
.dash-chat__tabs .dash-tabs__tab {
  font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium);
  padding: 4px 12px; margin: 0; border: 0; border-radius: 6px;
  color: var(--dash-muted);
  transition: color var(--dash-dur-fast) var(--dash-ease), background var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat__tabs .dash-tabs__tab:hover { color: var(--dash-ink); }
.dash-chat__tabs .dash-tabs__tab[data-selected="true"] {
  color: var(--dash-ink); background: var(--dash-surface-raised);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--dash-border);
}
.dash-chat__tabs .dash-tabs__tab:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

.dash-chat__day {
  display: flex; align-items: center; gap: var(--dash-space-3);
  margin: var(--dash-space-5) 0 var(--dash-space-2);
  font-family: var(--dash-font-mono); font-size: var(--dash-text-2xs);
  font-weight: var(--dash-weight-medium); text-transform: uppercase;
  letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
}
.dash-chat__day:first-child, .dash-chat__earlier + .dash-chat__day { margin-top: 0; }
.dash-chat__day::before, .dash-chat__day::after {
  content: ""; flex: 1; height: 1px; background: var(--dash-border);
}
.dash-chat__topic {
  display: flex; align-items: center; gap: var(--dash-space-2);
  margin: var(--dash-space-3) 0 var(--dash-space-1);
  font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi);
  color: var(--dash-ink-secondary);
}
.dash-chat__day + .dash-chat__topic { margin-top: 0; }
.dash-chat__topic::before {
  content: ""; flex: none; width: 6px; height: 6px; border-radius: var(--dash-radius-pill);
  background: var(--dash-accent-line);
}
.dash-chat__topic::after {
  content: ""; flex: 1; height: 1px;
  background: linear-gradient(90deg, var(--dash-border), transparent);
}
.dash-chat__topic span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-chat__topic[data-viewing="true"] { color: var(--dash-accent); }
.dash-chat__topic[data-viewing="true"]::before { background: var(--dash-accent); }
.dash-chat__earlier {
  align-self: center; font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium);
  padding: 4px var(--dash-space-3); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-pill);
  background: var(--dash-surface); color: var(--dash-ink-secondary); cursor: pointer;
}
.dash-chat__earlier:hover { color: var(--dash-accent); border-color: var(--dash-accent-line); }
.dash-chat__earlier:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-chat__latest {
  position: absolute; left: 50%; bottom: 84px; z-index: 1; transform: translateX(-50%);
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi);
  padding: 6px var(--dash-space-3);
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-pill);
  background: var(--dash-surface-raised); color: var(--dash-ink);
  box-shadow: var(--dash-shadow-md);
  cursor: pointer;
  transition: color var(--dash-dur-fast) var(--dash-ease), border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat__latest:hover { color: var(--dash-accent); border-color: var(--dash-accent-line); }
.dash-chat__latest:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }

/*
 * The Timeline tab: the last seven days as tiles, "Later" for older ones, and
 * the day picked below them.
 */
.dash-chat-timeline {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column;
  background: var(--dash-surface-sunken);
}
.dash-chat-timeline__strip {
  padding: var(--dash-space-4);
  background: var(--dash-surface);
  border-bottom: 1px solid var(--dash-border);
}
.dash-chat-timeline__strip-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2);
  margin-bottom: var(--dash-space-3);
}
.dash-chat-timeline__eyebrow {
  font-family: var(--dash-font-mono); font-size: var(--dash-text-2xs);
  font-weight: var(--dash-weight-medium); text-transform: uppercase;
  letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
}
.dash-chat-timeline__tiles {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px;
}
.dash-chat-timeline__tile {
  position: relative; width: 100%;
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: var(--dash-space-2) 2px 9px;
  font: inherit; color: var(--dash-ink); cursor: pointer;
  background: var(--dash-surface-raised);
  border: 1px solid var(--dash-border-strong); border-radius: 10px;
  box-shadow: var(--dash-shadow-sm);
  transition: border-color var(--dash-dur-fast) var(--dash-ease), background var(--dash-dur-fast) var(--dash-ease),
              box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat-timeline__tile:hover { border-color: var(--dash-accent-line); box-shadow: var(--dash-shadow-md); }
.dash-chat-timeline__tile:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-chat-timeline__tile-weekday, .dash-chat-timeline__tile-month {
  font-size: var(--dash-text-micro); font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--dash-muted);
}
.dash-chat-timeline__tile-date {
  font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi);
  line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
}
/* Today: a small accent mark under the date, the way a calendar app does it. */
.dash-chat-timeline__tile[data-today="true"]::after {
  content: ""; position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
  width: 4px; height: 4px; border-radius: var(--dash-radius-pill); background: var(--dash-accent);
}
.dash-chat-timeline__tile[data-empty="true"] {
  background: transparent; box-shadow: none; border-style: dashed; border-color: var(--dash-border-strong);
}
.dash-chat-timeline__tile[data-empty="true"] .dash-chat-timeline__tile-date { color: var(--dash-muted); font-weight: var(--dash-weight-normal); }
.dash-chat-timeline__tile[aria-pressed="true"] {
  background: var(--dash-accent); border-color: var(--dash-accent); border-style: solid;
  color: var(--dash-accent-ink); box-shadow: 0 2px 8px -2px var(--dash-ring);
}
.dash-chat-timeline__tile[aria-pressed="true"] .dash-chat-timeline__tile-weekday,
.dash-chat-timeline__tile[aria-pressed="true"] .dash-chat-timeline__tile-month { color: inherit; opacity: 0.8; }
.dash-chat-timeline__tile[aria-pressed="true"] .dash-chat-timeline__tile-date { color: inherit; }
.dash-chat-timeline__tile[aria-pressed="true"][data-today="true"]::after { background: var(--dash-accent-ink); }

/* "Later": a button, and the month calendar it opens. */
.dash-later { position: relative; }
.dash-later__trigger {
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium);
  padding: 5px 10px; cursor: pointer;
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface-raised); color: var(--dash-ink-secondary);
  transition: color var(--dash-dur-fast) var(--dash-ease), border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-later__trigger:hover, .dash-later__trigger[aria-expanded="true"] { color: var(--dash-ink); border-color: var(--dash-accent-line); }
.dash-later__trigger[data-active="true"] { color: var(--dash-accent); border-color: var(--dash-accent); background: var(--dash-accent-wash); }
.dash-later__trigger:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-later__pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 5;
  width: 272px; padding: var(--dash-space-3);
  background: var(--dash-surface-raised);
  border: 1px solid var(--dash-border-strong); border-radius: 12px;
  box-shadow: var(--dash-shadow-lg);
  animation: dash-msg-in var(--dash-dur-fast) var(--dash-ease-out) both;
}
.dash-later__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--dash-space-2); }
.dash-later__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-later__nav {
  display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 1px solid transparent; border-radius: var(--dash-radius-xs);
  background: none; color: var(--dash-ink-secondary); cursor: pointer;
}
.dash-later__nav:hover:not(:disabled) { background: var(--dash-wash); color: var(--dash-ink); }
.dash-later__nav:disabled { opacity: 0.35; cursor: default; }
.dash-later__nav:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-later__grid { display: flex; flex-direction: column; gap: 2px; }
.dash-later__row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.dash-later__weekday {
  text-align: center; padding: 4px 0;
  font-size: var(--dash-text-micro); font-weight: var(--dash-weight-semi);
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--dash-muted);
}
.dash-later__row > [role="gridcell"] { display: flex; justify-content: center; }
.dash-later__day {
  position: relative; width: 34px; height: 32px; padding: 0;
  font: inherit; font-size: var(--dash-text-xs); font-variant-numeric: tabular-nums;
  border: 0; border-radius: var(--dash-radius-xs);
  background: none; color: var(--dash-ink); cursor: pointer;
}
.dash-later__day:hover:not(:disabled) { background: var(--dash-wash); }
.dash-later__day:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 0; }
.dash-later__day:disabled { color: var(--dash-muted); opacity: 0.4; cursor: default; }
.dash-later__day[data-active="true"] { font-weight: var(--dash-weight-semi); }
.dash-later__day[data-active="true"]::after {
  content: ""; position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
  width: 4px; height: 4px; border-radius: var(--dash-radius-pill); background: var(--dash-accent);
}
.dash-later__day[data-today="true"] { box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.dash-later__foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: var(--dash-space-2); padding-top: var(--dash-space-2);
  border-top: 1px solid var(--dash-border);
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
}
.dash-later__legend { display: inline-flex; align-items: center; gap: 6px; }
.dash-later__legend i {
  display: inline-block; width: 4px; height: 4px;
  border-radius: var(--dash-radius-pill); background: var(--dash-accent);
}

/* The day picked: a heading, then what happened, in time order. */
.dash-chat-timeline__dayview { padding: var(--dash-space-4); }
.dash-chat-timeline__dayhead { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--dash-space-4); }
.dash-chat-timeline__title {
  margin: 0; font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em; color: var(--dash-ink);
}
.dash-chat-timeline__summary { margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-chat-timeline__note { margin: 0; padding: var(--dash-space-4); font-size: var(--dash-text-sm); color: var(--dash-muted); }
.dash-chat-timeline__empty {
  display: flex; flex-direction: column; gap: 2px; align-items: center; text-align: center;
  padding: var(--dash-space-6) var(--dash-space-4);
  border: 1px dashed var(--dash-border-strong); border-radius: var(--dash-radius-sm);
  font-size: var(--dash-text-xs); color: var(--dash-muted);
}
.dash-chat-timeline__empty strong { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink-secondary); }
.dash-chat-timeline__rail { list-style: none; margin: 0; padding: 0; }
.dash-chat-timeline__item {
  position: relative;
  display: grid; grid-template-columns: 56px 1fr; column-gap: var(--dash-space-5);
  padding-bottom: var(--dash-space-2);
}
/* The rail: a line through the dots, stopping at the last one. */
.dash-chat-timeline__item::before {
  content: ""; position: absolute; left: 66px; top: 22px; bottom: -4px; width: 1px;
  background: var(--dash-border-strong);
}
.dash-chat-timeline__item:last-child::before { display: none; }
.dash-chat-timeline__item::after {
  content: ""; position: absolute; left: 62px; top: 13px; width: 9px; height: 9px; box-sizing: border-box;
  border-radius: var(--dash-radius-pill);
  border: 2px solid var(--dash-accent); background: var(--dash-surface-sunken);
}
.dash-chat-timeline__item[data-kind="task"]::after { background: var(--dash-accent); }
.dash-chat-timeline__item[data-status="failed"]::after { border-color: var(--dash-critical); background: var(--dash-critical); }
.dash-chat-timeline__time {
  padding-top: 10px; text-align: right;
  font-family: var(--dash-font-mono); font-size: var(--dash-text-2xs);
  font-variant-numeric: tabular-nums; color: var(--dash-muted); white-space: nowrap;
}
.dash-chat-timeline__row {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
  padding: var(--dash-space-2) var(--dash-space-3);
  font: inherit; font-size: var(--dash-text-sm); text-align: left;
  border: 1px solid var(--dash-border); border-radius: 10px;
  background: var(--dash-surface-raised); color: var(--dash-ink);
  box-shadow: var(--dash-shadow-sm);
  cursor: pointer; text-decoration: none;
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.dash-chat-timeline__row:hover { border-color: var(--dash-accent-line); box-shadow: var(--dash-shadow-md); }
.dash-chat-timeline__row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-chat-timeline__kind {
  font-family: var(--dash-font-mono); font-size: var(--dash-text-micro);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
}
.dash-chat-timeline__item[data-status="failed"] .dash-chat-timeline__kind { color: var(--dash-critical); }
.dash-chat-timeline__name { font-weight: var(--dash-weight-semi); line-height: var(--dash-leading-tight); overflow-wrap: anywhere; }
.dash-chat-timeline__meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--dash-space-1);
  font-size: var(--dash-text-xs); color: var(--dash-muted);
}

@media (prefers-reduced-motion: reduce) {
  .dash-shell, .dash-chat { transition: none; }
}

/* Narrow screens: the column covers rather than squeezes the board. */
@media (max-width: 860px) {
  .dash-shell[data-chat="open"] { margin-right: 0; }
}

/* == record page ========================================================
 * The full-width record. Same RecordView the drawer renders, given room —
 * so a change to how a record reads lands on both surfaces rather than on
 * whichever was edited last.
 */
.dash-record-page {
  display: flex; flex-direction: column; gap: var(--dash-space-4);
  min-width: 0; max-width: 1100px;
}
.dash-record-page__crumbs {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--dash-space-1);
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
}
.dash-record-page__here { color: var(--dash-ink); font-weight: var(--dash-weight-semi); }

/* The figures above a record. Wraps rather than scrolls: four numbers on two
   lines still read at a glance, where a horizontal scroll hides one of them. */
.dash-record-page__stats {
  display: flex; flex-wrap: wrap; gap: var(--dash-space-2);
  margin: var(--dash-space-3) 0;
}
.dash-record-page__stat {
  flex: 1 1 140px; min-width: 0;
  padding: var(--dash-space-2);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface);
}
/* Above the figure, quieter than it: the number is what gets read, the label
   is what makes it mean anything. */
.dash-record-page__stat-label {
  margin: 0 0 var(--dash-space-1);
  font-size: var(--dash-text-xs);
  color: var(--dash-muted);
}
/* A tile is too small for a paragraph. A collection this account cannot read
   still has to say which collection it is, so the label above carries that and
   the message inside is allowed to clamp. */
.dash-record-page__stat .dash-state {
  padding: 0;
  gap: var(--dash-space-1);
}
.dash-record-page__stat .dash-state__title {
  font-size: var(--dash-text-xs);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden;
}
.dash-record-page__stat .dash-state__detail { display: none; }

/* Tabs and their panel are one card, so the panel reads as belonging to the
   selected tab rather than floating under a detached strip. */
.dash-record-tabs {
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  background: var(--dash-surface);
  box-shadow: var(--dash-shadow-sm);
  overflow: hidden;
}
.dash-record-tabs .dash-tabs {
  padding: 0 var(--dash-space-4);
  background: var(--dash-surface-sunken);
}
.dash-record-tabs__panel {
  padding: var(--dash-space-4);
  /* Tall enough that switching to a shorter collection does not collapse the
     card and jump everything below it up the page. */
  min-height: 240px;
  display: flex; flex-direction: column;
}
/* The panel's content fades in, so switching tabs reads as a change rather
   than as a flicker. Distance would be worse here — the strip stays put. */
@media (prefers-reduced-motion: no-preference) {
  .dash-record-tabs__panel > * {
    animation: dash-fade-in var(--dash-dur-base) var(--dash-ease) both;
  }
}

/* On the page the record itself sits on a card too, matching the tabs. */
.dash-record-page .dash-record-head,
.dash-record-page .dash-record-scroll {
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm);
  padding: var(--dash-space-5);
}
.dash-record-page .dash-record-scroll { max-height: none; overflow: visible; }

/* The picker needs room for a card grid. */
.dash-sheet--wide { width: min(860px, 100%); }
.dash-bind-role { padding: 8px 0; border-bottom: 1px solid var(--dash-border); }
.dash-bind-role:last-of-type { border-bottom: none; }
/* Multi roles list every candidate field as a checkbox, so a table with
   fourteen columns stays a scrollable block rather than a wall. */
.dash-bind-multi {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 190px; overflow: auto;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); padding: 8px 10px;
}

.dash-customise { padding: 10px 0; border-bottom: 1px solid var(--dash-border); }
.dash-customise:last-of-type { border-bottom: none; }
.dash-customise__title {
  margin: 0 0 8px; font-size: var(--dash-text-sm); font-weight: 600; color: var(--dash-ink);
}
.dash-customise__group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.dash-customise__label {
  font-size: var(--dash-text-xs); color: var(--dash-muted); margin-bottom: 2px;
}

/*
 * The stale banner.
 *
 * Serving old numbers is only safe while this is impossible to miss. If it
 * ever becomes subtle, this is the feature that makes a dashboard confidently
 * wrong — so it sits above the content, in the warning tone, at body size
 * rather than as a caption.
 */
.dash-widget__stale {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 0 var(--dash-pad-x) var(--dash-cell-y);
  padding: 7px 9px;
  border: 1px solid var(--dash-serious);
  border-left-width: 3px;
  border-radius: var(--dash-radius-sm);
  background: var(--dash-wash);
  font-size: var(--dash-text-xs); line-height: 1.45; color: var(--dash-ink-secondary);
}
.dash-widget[data-border="off"] .dash-widget__stale { margin-left: 0; margin-right: 0; }
/* Quieter than the stale banner: the numbers are current, just not all of it. */
.dash-widget__incomplete {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 0 var(--dash-pad-x) var(--dash-cell-y);
  padding: 6px 9px;
  border-left: 3px solid var(--dash-border-strong, var(--dash-border));
  border-radius: var(--dash-radius-sm);
  background: var(--dash-wash);
  font-size: var(--dash-text-xs); line-height: 1.45; color: var(--dash-ink-secondary);
}
.dash-widget[data-border="off"] .dash-widget__incomplete { margin-left: 0; margin-right: 0; }

.dash-cost {
  display: flex; flex-wrap: wrap; gap: 4px 14px;
  font-size: var(--dash-text-xs); color: var(--dash-muted);
}
.dash-cost__value { color: var(--dash-ink); font-variant-numeric: tabular-nums; }

.dash-checklist { list-style: none; margin: 0; padding: 0; }
.dash-checklist li { border-bottom: 1px solid var(--dash-border); }
.dash-checklist li:last-child { border-bottom: none; }
.dash-checklist label {
  display: flex; gap: 10px; align-items: flex-start; padding: 9px 2px;
  font-size: var(--dash-text-sm); cursor: pointer;
}
.dash-checklist input { margin-top: 2px; }
.dash-checklist__name { color: var(--dash-ink); }
.dash-checklist__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }

.dash-conn-list { list-style: none; margin: 0; padding: 0; }
.dash-conn-list li {
  display: flex; align-items: center; gap: 10px; padding: 10px 2px;
  border-bottom: 1px solid var(--dash-border); font-size: var(--dash-text-sm);
}
.dash-conn-list li:last-child { border-bottom: none; }
.dash-conn-list__text { flex: 1 1 auto; min-width: 0; }
.dash-conn-list__title { color: var(--dash-ink); }
.dash-conn-list__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-danger { color: var(--dash-critical); }

/* == guided setup =======================================================
 * The widget being built, inside the chat column: what it will look like,
 * and everything you can say about it.
 */
.dash-setup {
  border: 1px solid var(--dash-accent-line);
  border-radius: var(--dash-radius);
  background: var(--dash-surface);
  box-shadow: var(--dash-shadow-sm);
  padding: var(--dash-space-3);
  margin: var(--dash-space-1) 0;
  display: flex; flex-direction: column; gap: var(--dash-space-3);
  animation: dash-msg-in var(--dash-dur-base) var(--dash-ease-out) both;
}
.dash-setup__head { display: flex; align-items: baseline; gap: var(--dash-space-2); }
.dash-setup__badge {
  font-size: var(--dash-text-2xs); font-weight: var(--dash-weight-semi);
  letter-spacing: var(--dash-tracking-label); text-transform: uppercase;
  color: var(--dash-accent);
}
.dash-setup__count { margin-left: auto; font-size: var(--dash-text-2xs); color: var(--dash-muted); }
.dash-setup__q {
  margin: 0; font-size: var(--dash-text-md); font-weight: var(--dash-weight-medium);
  line-height: var(--dash-leading-tight); color: var(--dash-ink);
}
.dash-setup__help {
  margin: var(--dash-space-1) 0 0;
  font-size: var(--dash-text-xs); line-height: var(--dash-leading-normal);
  color: var(--dash-muted);
}

.dash-setup__options {
  list-style: none; margin: var(--dash-space-3) 0 0; padding: 0;
  display: grid; gap: var(--dash-space-1);
}
.dash-setup__option {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  padding: var(--dash-space-2) var(--dash-space-3); text-align: left; cursor: pointer;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface-sunken); font: inherit; color: inherit;
  transition: border-color var(--dash-dur-fast) var(--dash-ease),
              background var(--dash-dur-fast) var(--dash-ease);
}
.dash-setup__option:hover:not(:disabled) {
  border-color: var(--dash-accent); background: var(--dash-accent-wash);
}
.dash-setup__option:disabled { opacity: 0.55; cursor: default; }
.dash-setup__option[data-on="true"] {
  border-color: var(--dash-accent);
  background: var(--dash-accent-wash);
  box-shadow: inset 0 0 0 1px var(--dash-accent);
}
.dash-setup__option:focus-visible {
  outline: 2px solid var(--dash-accent); outline-offset: 1px;
}
.dash-setup__option-name {
  font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink);
}
.dash-setup__option-meta {
  font-size: var(--dash-text-xs); line-height: var(--dash-leading-normal); color: var(--dash-muted);
}
.dash-setup__suggested { color: var(--dash-accent); font-size: var(--dash-text-2xs); }

.dash-setup__text {
  margin-top: var(--dash-space-2); width: 100%;
  padding: var(--dash-space-2) var(--dash-space-3); font: inherit; font-size: var(--dash-text-sm);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface); color: var(--dash-ink);
}

.dash-setup__why {
  margin: var(--dash-space-2) 0 0; padding-left: var(--dash-space-4);
  font-size: var(--dash-text-xs); color: var(--dash-muted);
}
.dash-setup__why li { line-height: var(--dash-leading-normal); }
/*
 * A caveat, and never behind a disclosure.
 *
 * A join that can repeat a row turns a total into a number that is wrong and
 * looks right. Reading it once in good faith is the whole failure, so this
 * stays on the card beside the confirm button where it cannot be missed.
 */
.dash-setup__warn {
  margin: var(--dash-space-2) 0 0;
  padding: var(--dash-space-2) var(--dash-space-3);
  font-size: var(--dash-text-xs); line-height: var(--dash-leading-normal);
  border-left: 3px solid var(--dash-serious);
  border-radius: 0 var(--dash-radius-sm) var(--dash-radius-sm) 0;
  background: var(--dash-surface-sunken);
  color: var(--dash-ink-secondary);
}
.dash-setup__error {
  margin: var(--dash-space-2) 0 0;
  font-size: var(--dash-text-xs); line-height: var(--dash-leading-normal);
  color: var(--dash-critical);
}
.dash-setup__more {
  margin-top: var(--dash-space-2); padding: var(--dash-space-1) var(--dash-space-2);
  font: inherit; font-size: var(--dash-text-xs); cursor: pointer;
  border: 1px dashed var(--dash-border); border-radius: var(--dash-radius-sm);
  background: none; color: var(--dash-muted);
}
.dash-setup__more:hover { color: var(--dash-accent); border-color: var(--dash-accent); }

/* The widget being built, at a size it can be judged at. */
.dash-setup__preview {
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  background: var(--dash-plane);
  padding: var(--dash-space-2);
  /* Several widgets stack, because a setup can now produce more than one and
     each has to be judged at a size worth judging. */
  display: flex;
  flex-direction: column;
  gap: var(--dash-space-2);
}
/* The two decisions worth reaching without opening anything: what the widget
   is called, and what it lets people do. Above the disclosure, not inside it. */
.dash-primary {
  list-style: none;
  margin: var(--dash-space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--dash-space-1);
}
.dash-primary__row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--dash-space-2);
  padding: var(--dash-space-2);
  text-align: left;
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  cursor: pointer;
}
.dash-primary__row:hover:not(:disabled) { border-color: var(--dash-accent); }
.dash-primary__row:disabled { opacity: 0.6; cursor: default; }
.dash-primary__name {
  font-size: var(--dash-text-xs);
  font-weight: 600;
  color: var(--dash-text);
  flex: 0 0 auto;
}
.dash-primary__value {
  flex: 1;
  min-width: 0;
  font-size: var(--dash-text-xs);
  color: var(--dash-muted);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Unset is worth noticing on a row this prominent. */
.dash-primary__row[data-unset="true"] .dash-primary__value { color: var(--dash-accent); }
.dash-primary__go { color: var(--dash-muted); flex: 0 0 auto; }

/* A name is typed, not picked. The suggestions live behind the arrow, so the
   box is the first thing offered rather than a footnote under a list. */
.dash-setup__namerow { display: flex; gap: var(--dash-space-1); align-items: stretch; }
.dash-setup__name {
  flex: 1;
  min-width: 0;
  padding: var(--dash-space-2);
  font: inherit;
  color: var(--dash-text);
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
}
.dash-setup__name:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -1px; }
.dash-setup__namemore {
  padding: 0 var(--dash-space-2);
  color: var(--dash-muted);
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  cursor: pointer;
}
.dash-setup__namemore:hover:not(:disabled) { color: var(--dash-accent); border-color: var(--dash-accent); }
.dash-setup__namemore[aria-expanded="true"] { color: var(--dash-accent); }

/* The other ways these could be shown, as small abstract pictures.
   Never a question and never a gate: what is on screen is what happens if
   nobody touches them. */
.dash-arrange {
  display: flex;
  flex-direction: column;
  gap: var(--dash-space-1);
  padding: var(--dash-space-2) 0 0;
}
.dash-arrange__label {
  font-size: var(--dash-text-xs);
  color: var(--dash-muted);
}
.dash-arrange__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--dash-space-2);
}
.dash-arrange__chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--dash-space-2);
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  cursor: pointer;
  transition: border-color var(--dash-dur-base) var(--dash-ease);
}
.dash-arrange__chip:hover:not(:disabled) { border-color: var(--dash-accent); }
.dash-arrange__chip:disabled { opacity: 0.5; cursor: default; }
.dash-arrange__mock { width: 72px; height: 48px; display: block; }
/* Grey bars and nothing else. A mock carrying plausible values would be a
   promise about data nobody has read yet. */
.dash-arrange__body { fill: var(--dash-border); }
.dash-arrange__on { fill: var(--dash-muted); }
.dash-arrange__off { fill: var(--dash-border); }
.dash-arrange__name {
  font-size: var(--dash-text-xs);
  font-weight: 600;
  color: var(--dash-text);
}
.dash-arrange__cost {
  font-size: var(--dash-text-xs);
  color: var(--dash-muted);
}

/* What the frame will be called, under the widgets that go in it. */
.dash-setup__frame {
  margin: 0;
  font-size: var(--dash-text-xs);
  color: var(--dash-muted);
  text-align: center;
}
/*
 * A fixed height, because the pane must not resize under someone every time a
 * different view is chosen. Tall enough for a chart to be judged, short enough
 * that the conversation stays on screen with it.
 */
.dash-setup__preview .dash-widget { height: 280px; }
.dash-setup__body { padding: 0; display: flex; flex-direction: column; }
.dash-setup__question { display: block; }

/* == settings ===========================================================
 * Every decision about the widget, behind one control that says so.
 *
 * The row of pills this replaced had no heading, no grouping, and an
 * affordance you had to already know about. The specific failure is that
 * nothing on screen said those were the things you could change.
 */
.dash-settings {
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius-sm);
  background: var(--dash-surface-sunken);
  overflow: hidden;
}
.dash-settings__toggle {
  display: flex; align-items: center; gap: var(--dash-space-2); width: 100%;
  padding: var(--dash-space-2) var(--dash-space-3);
  font: inherit; text-align: left; cursor: pointer;
  border: none; background: transparent; color: var(--dash-ink);
}
.dash-settings__toggle:hover { background: var(--dash-wash); }
.dash-settings__toggle:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-settings__chevron {
  font-size: var(--dash-text-2xs); color: var(--dash-muted); flex: none;
  transition: transform var(--dash-dur-fast) var(--dash-ease);
}
.dash-settings[data-open="true"] .dash-settings__chevron { transform: rotate(90deg); }
.dash-settings__label {
  font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi);
}
.dash-settings__summary {
  margin-left: auto; font-size: var(--dash-text-2xs); color: var(--dash-muted);
}

.dash-settings__list {
  list-style: none; margin: 0; padding: 0;
  border-top: 1px solid var(--dash-border);
  background: var(--dash-surface);
  animation: dash-fade-in var(--dash-dur-fast) var(--dash-ease) both;
}
.dash-settings__list li + li { border-top: 1px solid var(--dash-border); }
/* A full-width row with the value on the right, which is what a settings list
   looks like everywhere else and therefore what reads as clickable. */
.dash-settings__row {
  display: flex; align-items: baseline; gap: var(--dash-space-3); width: 100%;
  padding: var(--dash-space-2) var(--dash-space-3);
  font: inherit; text-align: left; cursor: pointer;
  border: none; background: transparent; color: inherit;
}
.dash-settings__row:hover:not(:disabled) { background: var(--dash-accent-wash); }
.dash-settings__row:disabled { opacity: 0.55; cursor: default; }
.dash-settings__row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-settings__name {
  font-size: var(--dash-text-xs); color: var(--dash-muted); flex: none; min-width: 8ch;
}
.dash-settings__value {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-size: var(--dash-text-sm); color: var(--dash-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-settings__go { color: var(--dash-axis); flex: none; }
/* Not set, and the widget cannot be built without it. */
.dash-settings__row[data-unset="true"][data-required="true"] .dash-settings__value {
  color: var(--dash-serious);
}
.dash-settings__row[data-unset="true"] .dash-settings__value { color: var(--dash-muted); }

/* == the model panel ====================================================
 * One row per AI action: what it is, why it routes where it does, and a
 * control. The name column carries three lines and the control one, so the
 * row is aligned to its top rather than its baseline — a two-line note
 * beside a select is otherwise pushed out of line with its own label.
 */
.dash-models__row {
  display: flex; align-items: flex-start; gap: var(--dash-space-3);
  padding: var(--dash-space-3) 0;
}
.dash-models__row + .dash-models__row { border-top: 1px solid var(--dash-border); }
.dash-models__name {
  display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0;
  font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi);
}
.dash-models__note {
  font-size: var(--dash-text-2xs); color: var(--dash-muted);
  font-weight: var(--dash-weight-normal); line-height: var(--dash-leading-tight);
}
.dash-models__row select { flex: none; max-width: 46%; }
.dash-models__total {
  margin: 0; font-size: var(--dash-text-2xs); color: var(--dash-muted); text-align: right;
}
/* Below the widest phone the control drops under its label rather than being
   squeezed to a few characters of a model name. */
@media (max-width: 520px) {
  .dash-models__row { flex-direction: column; align-items: stretch; }
  .dash-models__row select { max-width: none; }
}

/*
 * The tile a widget was just added to, so it can be found on a full board -
 * and the tile a citation was just clicked through to, which is the same need
 * with a different cause, so it wears the same ring rather than a second one.
 */
.dash-grid__cell[data-just-added="true"],
.dash-grid__cell[data-cited="true"] {
  animation: dash-landed 2.4s ease-out 1;
}
@keyframes dash-landed {
  0%, 70% { box-shadow: 0 0 0 2px var(--dash-accent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}

/* ── widget groups ─────────────────────────────────────────────────────────
   Several widgets inside one frame. The frame owns the card — border, radius,
   shadow — and each member is quieted to borderless through the presentation
   system, so a group reads as one object rather than as cards inside a card. */
.dash-group {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--dash-surface);
  border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm);
  overflow: hidden;
}
.dash-group__head {
  display: flex;
  align-items: center;
  gap: var(--dash-space-2);
  padding: var(--dash-space-3) var(--dash-space-4) 0;
}
.dash-group__title {
  margin: 0;
  font-size: var(--dash-text-sm);
  font-weight: 600;
  color: var(--dash-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dash-group__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.dash-group__tabs .dash-tabs { padding: 0 var(--dash-space-4); }
.dash-group__panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: var(--dash-space-3) var(--dash-space-4) var(--dash-space-4);
}

/* A row or a stack. The .dash-widget rule sets height:100%, which is right
   when it owns a whole grid cell and wrong when several share one — so members
   are flex children with their own min-size floor instead. */
.dash-group__lane {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: var(--dash-space-4);
  padding: var(--dash-space-3) var(--dash-space-4) var(--dash-space-4);
}
.dash-group[data-arrangement="row"] .dash-group__lane { flex-direction: row; }
.dash-group[data-arrangement="stack"] .dash-group__lane {
  flex-direction: column;
  overflow-y: auto;
}
.dash-group__member {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
/* A stacked member sizes to its content rather than being squeezed to an
   equal share of a height it cannot know. */
.dash-group[data-arrangement="stack"] .dash-group__member { flex: 0 0 auto; }

/*
 * Changing a record: the form, and the review a person says yes to.
 * Plain text in comments here: a backtick would end this template literal.
 */
.dash-write-form { display: flex; flex-direction: column; }
.dash-write-form .dash-keyblock { margin-top: 4px; }
.dash-write-item {
  border-bottom: 1px dashed var(--dash-border); padding-bottom: 8px; margin-bottom: 8px;
}
.dash-write-error { color: var(--dash-critical); font-size: var(--dash-text-xs); }
.dash-write-review { display: flex; flex-direction: column; gap: 8px; }
.dash-write-review__summary { margin: 0; color: var(--dash-ink); font-size: var(--dash-text-sm); line-height: 1.5; }
.dash-write-review__diff { border-collapse: collapse; width: 100%; font-size: var(--dash-text-sm); }
.dash-write-review__diff th, .dash-write-review__diff td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dash-border); vertical-align: top;
  overflow-wrap: anywhere;
}
.dash-write-review__diff thead th { font-size: var(--dash-text-xs); color: var(--dash-muted); font-weight: 500; }
.dash-write-review__before { color: var(--dash-muted); text-decoration: line-through; text-decoration-color: var(--dash-border); }
.dash-write-review__after { color: var(--dash-ink); font-weight: 500; }
.dash-write-review__kept { display: block; margin-top: 4px; }
.dash-write-review__detail {
  margin-top: 6px; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs);
  color: var(--dash-muted); overflow-wrap: anywhere;
}
.dash-write-review[data-compact="true"] .dash-write-review__diff th,
.dash-write-review[data-compact="true"] .dash-write-review__diff td { padding: 4px 6px; }
.dash-linkish {
  font: inherit; font-size: inherit; color: var(--dash-accent); background: none; border: none;
  padding: 0; cursor: pointer; text-decoration: underline;
}
.dash-record-changes {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0 10px;
}
.dash-sheet-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.32); z-index: 50;
  display: flex; justify-content: flex-end;
}
.dash-sheet-panel {
  width: min(560px, 100vw); height: 100%; overflow-y: auto; background: var(--dash-surface);
  border-left: 1px solid var(--dash-border); padding: 18px 20px 24px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px;
}
.dash-sheet-panel__head { display: flex; align-items: center; gap: 8px; }
.dash-sheet-panel__head h2 { margin: 0; font-size: var(--dash-text-lg, 1.1rem); flex: 1; }
/* == agents ==============================================================
 * The Agent side of the app: a list of agents beside the editor for one.
 * An agent's colour is a series hue, so it reads on both surfaces.
 */
.dash-agent__inner { max-width: 1400px; margin: 0 auto; }
.dash-agents { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: var(--dash-space-4, 16px); align-items: start; }
.dash-agents__list, .dash-agents__detail {
  background: var(--dash-surface); border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius); padding: var(--dash-space-3, 12px);
}
.dash-agents__head, .dash-agents__subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dash-agents__title, .dash-agents__subtitle { margin: 0; font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); }
.dash-agents__subtitle { margin-bottom: 8px; }
.dash-agents__subhead .dash-agents__subtitle { margin-bottom: 0; }
.dash-agents__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dash-agents__rows--archived { opacity: 0.7; }
.dash-agents__toggle {
  font: inherit; font-size: var(--dash-text-xs); color: var(--dash-muted);
  background: none; border: 0; padding: 8px 2px 4px; cursor: pointer; text-align: left;
}
.dash-agents__toggle:hover { color: var(--dash-ink); }
.dash-agent-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%;
  font: inherit; text-align: left; cursor: pointer;
  padding: 8px 10px; border: 1px solid transparent; border-radius: var(--dash-radius-sm);
  background: transparent; color: var(--dash-ink);
}
.dash-agent-row:hover { background: var(--dash-wash); }
.dash-agent-row[data-active="true"] { background: var(--dash-accent-wash); border-color: var(--dash-accent-line); }
.dash-agent-row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-agent-row__reach { font-size: var(--dash-text-xs); color: var(--dash-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dash-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.dash-swatch {
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 2px solid transparent; box-shadow: 0 0 0 1px var(--dash-border);
}
.dash-swatch[data-active="true"] { border-color: var(--dash-surface); box-shadow: 0 0 0 2px var(--dash-ink); }
.dash-swatch:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }

.dash-reach { display: flex; flex-direction: column; gap: 8px; }
.dash-reach__row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
  padding: 8px 10px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
}
.dash-reach__where { flex: 1 1 200px; font-size: var(--dash-text-sm); min-width: 0; }
.dash-reach__checks { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.dash-reach__check { display: inline-flex; align-items: center; gap: 4px; font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); }
.dash-reach__check input { width: auto; margin: 0; }
.dash-reach__remove { border: 0; background: none; color: var(--dash-muted); cursor: pointer; font-size: var(--dash-text-xs); padding: 4px; }
.dash-reach__remove:hover { color: var(--dash-critical); }
.dash-reach__add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dash-reach__add select { width: auto; flex: 1 1 140px; }
.dash-agent-editor__actions { display: flex; gap: 8px; margin-top: 8px; }

/* The agent editor's parts: tabs, Generate fields, knowledge rules, tools. */
.dash-agent-editor .dash-tabs { margin-bottom: 12px; }
.dash-agent-editor__pane[hidden] { display: none; }
.dash-agent-editor__lede { margin: 4px 0 12px; }
.dash-agent-editor__preview { margin: 4px 0 8px; font-size: var(--dash-text-sm); }
.dash-agent-editor__preview summary { cursor: pointer; color: var(--dash-ink-secondary); }
.dash-agent-editor__preview pre {
  white-space: pre-wrap; font-size: var(--dash-text-xs); line-height: 1.5;
  max-height: 360px; overflow: auto; margin: 8px 0 0; padding: 10px;
  background: var(--dash-wash); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  color: var(--dash-ink-secondary);
}
.dash-genfield__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dash-genfield__actions { display: inline-flex; align-items: center; gap: 8px; }
.dash-genfield__undo {
  font: inherit; font-size: var(--dash-text-xs); color: var(--dash-accent);
  background: none; border: 0; padding: 0; cursor: pointer;
}
.dash-genfield__error { color: var(--dash-critical); }
.dash-agent-row--shared { margin-bottom: 8px; border: 1px dashed var(--dash-border); }
.dash-agent-row__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); }

.dash-rules, .dash-tools { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.dash-rule, .dash-tool {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
}
.dash-rule__head, .dash-tool__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dash-rule__on, .dash-tool__on { display: inline-flex; align-items: center; gap: 6px; font-size: var(--dash-text-sm); }
.dash-rule__on input, .dash-tool__on input { width: auto; margin: 0; }
.dash-rule__trigger { flex: 1 1 220px; min-width: 0; }
.dash-rule__sources { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dash-rule__chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--dash-text-xs); padding: 2px 4px 2px 8px;
  border-radius: var(--dash-radius-pill); background: var(--dash-accent-wash); color: var(--dash-ink);
}
.dash-rule__chip button { border: 0; background: none; cursor: pointer; color: var(--dash-muted); font-size: var(--dash-text-2xs); }
.dash-tool[data-enabled="false"] { opacity: 0.6; }
.dash-tool__name { font-weight: var(--dash-weight-medium); }
.dash-tool__head .dash-tool__on { flex: 1 1 auto; min-width: 0; }
.dash-tool__modes {
  display: inline-flex; padding: 2px; gap: 2px;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-pill);
}
.dash-tool__mode {
  font: inherit; font-size: var(--dash-text-xs); border: 0; cursor: pointer;
  padding: 3px 10px; border-radius: var(--dash-radius-pill); background: transparent; color: var(--dash-muted);
}
.dash-tool__mode[data-active="true"] { background: var(--dash-accent-wash); color: var(--dash-accent); font-weight: var(--dash-weight-semi); }
.dash-tool__mode[data-mode="deny"][data-active="true"] { background: var(--dash-wash); color: var(--dash-critical); }
.dash-tool__mode:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-tool__body { display: flex; flex-direction: column; gap: 6px; }
.dash-tool__when, .dash-tool__deny, .dash-rule__trigger {
  font: inherit; font-size: var(--dash-text-sm); padding: 6px 8px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink); width: 100%;
}
.dash-tool__warn { color: var(--dash-warning); }
.dash-agent-editor select {
  font: inherit; font-size: var(--dash-text-sm); padding: 6px 8px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink);
}
.dash-agent-editor select:disabled { opacity: 0.6; }

/* Workflows: the editor's steps, a preview's paths, what waits for a person, and runs. */
.dash-workflow-editor__heading {
  margin: 16px 0 6px; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink-secondary);
}
.dash-workflow-editor .dash-reach__add .dash-tool__when { flex: 1 1 220px; width: auto; min-width: 0; }
.dash-workflow-editor .dash-reach__add .dash-tool__when.dash-workflow__short { flex: 0 1 160px; }
.dash-workflow-field { display: grid; grid-template-columns: 110px minmax(0, 1fr); align-items: center; gap: 8px; }
.dash-workflow-field__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }
@media (max-width: 520px) { .dash-workflow-field { grid-template-columns: minmax(0, 1fr); gap: 2px; } }
.dash-workflow-step__spacer { flex: 1 1 auto; }
.dash-workflow-step[data-mode="auto"] { border-left: 3px solid var(--dash-accent-line); }
.dash-workflow-step[data-mode="approve"] { border-left: 3px solid var(--dash-warning); }
.dash-workflow-preview { margin: 12px 0; overflow-x: auto; }
.dash-workflow-preview__table { width: 100%; border-collapse: collapse; font-size: var(--dash-text-xs); }
.dash-workflow-preview__table th, .dash-workflow-preview__table td {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--dash-border); white-space: nowrap;
}
.dash-workflow-preview__table td[data-mode="auto"] { color: var(--dash-accent); font-weight: var(--dash-weight-semi); }
.dash-workflow-preview__table td[data-mode="approve"] { color: var(--dash-warning); font-weight: var(--dash-weight-semi); }
.dash-workflow-preview__table td[data-mode="skip"] { color: var(--dash-muted); }
.dash-proposals, .dash-workflow-runs { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dash-proposal, .dash-workflow-run {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
}
.dash-proposal[data-status="stale"] { opacity: 0.75; }
.dash-proposal__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dash-proposal__title { font-size: var(--dash-text-sm); }
.dash-workflow-run__outputs { margin: 6px 0 0; padding-left: 18px; font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); }
.dash-workflow-run__outcome { font-weight: var(--dash-weight-semi); text-transform: capitalize; }
.dash-workflow-run__outputs li[data-outcome="failed"] .dash-workflow-run__outcome { color: var(--dash-critical); }
.dash-workflow-run__outputs li[data-outcome="proposed"] .dash-workflow-run__outcome { color: var(--dash-warning); }
.dash-callout--warn { border-left-color: var(--dash-warning); }

/* The workflow builder: a canvas of step cards and arrows, with a settings panel beside it. */

.dash-workflow-page { display: flex; flex-direction: column; gap: 12px; }
.dash-builder { display: flex; flex-direction: column; gap: 10px; }
.dash-builder__bar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
}
.dash-builder__bar select {
  font: inherit; font-size: var(--dash-text-sm); padding: 5px 8px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink); max-width: 220px;
}
.dash-builder__title { font-size: var(--dash-text-md); }
.dash-builder__check {
  padding: 10px 12px; border: 1px solid var(--dash-border); border-left: 3px solid var(--dash-accent);
  border-radius: var(--dash-radius-sm); background: var(--dash-surface);
}
.dash-builder__sentence { margin: 0; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium, 500); }
.dash-builder__questions { margin: 6px 0 0; padding-left: 18px; font-size: var(--dash-text-sm); }
.dash-builder__questions li[data-kind="missing"]::marker { color: var(--dash-warning); }
.dash-builder__body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
.dash-builder__panel {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  padding: 12px; max-height: 720px; overflow: auto; position: sticky; top: 8px;
}
.dash-builder__panel select, .dash-step-panel select {
  font: inherit; font-size: var(--dash-text-sm); padding: 6px 8px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink); width: 100%;
}
.dash-step-panel { display: flex; flex-direction: column; gap: 8px; }
.dash-step-panel__head { display: flex; align-items: center; gap: 8px; }
.dash-step-panel__problems { margin: 0; padding: 8px 8px 8px 24px; border-radius: var(--dash-radius-sm); background: var(--dash-wash); color: var(--dash-warning); font-size: var(--dash-text-xs); }
.dash-step-panel .dash-workflow-field { grid-template-columns: 96px minmax(0, 1fr); }
.dash-workflow-field__control { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dash-workflow-field[data-required="true"] .dash-workflow-field__label { color: var(--dash-ink-secondary); }
.dash-workflow-editor .dash-tool__when.dash-workflow__tiny, .dash-tool__when.dash-workflow__tiny { width: 72px; }

.dash-canvas {
  position: relative; overflow: auto; max-height: 720px; min-height: 420px;
  background-color: var(--dash-surface);
  background-image: radial-gradient(var(--dash-border) 1px, transparent 1px);
  background-size: 16px 16px;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
}
.dash-canvas[data-connecting="true"] { cursor: crosshair; }
.dash-canvas__surface { position: relative; }
.dash-canvas__wires { position: absolute; inset: 0; overflow: visible; }
.dash-canvas__wire-line { fill: none; stroke: var(--dash-muted); stroke-width: 1.5; pointer-events: none; }
.dash-canvas__wire[data-loop="true"] .dash-canvas__wire-line { stroke-dasharray: 5 4; }
.dash-canvas__wire[data-selected="true"] .dash-canvas__wire-line { stroke: var(--dash-accent); stroke-width: 2.5; }
.dash-canvas__wire-hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; pointer-events: stroke; }
.dash-canvas__wire-label { font-size: 11px; fill: var(--dash-ink-secondary); }
.dash-canvas__arrowhead { fill: var(--dash-muted); }
.dash-canvas__wire-draft { stroke: var(--dash-accent); stroke-width: 1.5; stroke-dasharray: 4 4; }
.dash-canvas__node {
  position: absolute; display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); cursor: pointer; user-select: none;
}
.dash-canvas__node[data-selected="true"] { border-color: var(--dash-accent); box-shadow: 0 0 0 2px var(--dash-accent-wash); }
.dash-canvas__node[data-target="true"]:hover { border-color: var(--dash-accent); }
.dash-canvas__node--trigger { background: var(--dash-accent-wash); border-color: var(--dash-accent-line); }
.dash-canvas__head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 0; cursor: grab; }
.dash-canvas__head:active { cursor: grabbing; }
.dash-canvas__body { display: flex; flex-direction: column; gap: 2px; padding: 4px 10px; min-height: 0; flex: 1 1 auto; overflow: hidden; }
.dash-canvas__node--trigger .dash-canvas__body { padding-top: 8px; }
.dash-canvas__body .dash-canvas__kind { align-self: flex-start; }
.dash-canvas__kind {
  font-size: 10.5px; font-weight: var(--dash-weight-semi); letter-spacing: 0.02em; text-transform: uppercase;
  color: var(--dash-ink-secondary); padding: 1px 6px; border-radius: var(--dash-radius-pill); background: var(--dash-wash);
}
.dash-canvas__kind[data-base="outreach"], .dash-canvas__kind[data-base="notify"] { background: color-mix(in srgb, var(--dash-series-2) 18%, transparent); }
.dash-canvas__kind[data-base="wait"], .dash-canvas__kind[data-base="branch"] { background: color-mix(in srgb, var(--dash-series-4) 18%, transparent); }
.dash-canvas__kind[data-base="create"], .dash-canvas__kind[data-base="update"], .dash-canvas__kind[data-base="delete"], .dash-canvas__kind[data-base="assign"] { background: color-mix(in srgb, var(--dash-series-1) 18%, transparent); }
.dash-canvas__kind[data-base="think"], .dash-canvas__kind[data-base="ask"] { background: color-mix(in srgb, var(--dash-series-5) 18%, transparent); }
.dash-canvas__mode { font-size: 10.5px; padding: 1px 6px; border-radius: var(--dash-radius-pill); margin-left: auto; }
.dash-canvas__mode[data-mode="auto"] { background: var(--dash-accent-wash); color: var(--dash-accent); }
.dash-canvas__mode[data-mode="approve"] { background: color-mix(in srgb, var(--dash-warning) 16%, transparent); color: var(--dash-warning); }
.dash-canvas__issues {
  font-size: 10.5px; min-width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 8px;
  background: var(--dash-warning); color: var(--dash-surface); margin-left: 4px;
}
.dash-canvas__name { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium, 500); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dash-canvas__when { font-size: 11px; color: var(--dash-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dash-canvas__ports { display: flex; border-top: 1px solid var(--dash-border); }
.dash-canvas__port {
  flex: 1 1 0; min-width: 0; font: inherit; font-size: 10.5px; padding: 3px 2px; border: 0; border-right: 1px solid var(--dash-border);
  background: transparent; color: var(--dash-ink-secondary); cursor: crosshair; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dash-canvas__port:last-child { border-right: 0; }
.dash-canvas__port:hover, .dash-canvas__port[data-active="true"] { background: var(--dash-accent-wash); color: var(--dash-accent); }
.dash-canvas__port[data-outcome="failed"], .dash-canvas__port[data-outcome="timed_out"] { color: var(--dash-muted); }

.dash-workflow-preview__paths { margin: 6px 0 0; padding-left: 18px; font-size: var(--dash-text-sm); }
.dash-workflow-preview__paths span[data-mode="approve"] { color: var(--dash-warning); }
.dash-workflow-preview__paths span[data-mode="skip"] { color: var(--dash-muted); }

.dash-cases { width: 100%; border-collapse: collapse; font-size: var(--dash-text-sm); background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius); }
.dash-cases th, .dash-cases td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--dash-border); }
.dash-cases th { font-size: var(--dash-text-xs); color: var(--dash-muted); font-weight: var(--dash-weight-semi); }
.dash-cases tr[data-status="failed"] td:nth-child(2) { color: var(--dash-critical); }
.dash-template-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 2px; font-size: var(--dash-text-sm); }

/* Tasks: one record per action, shaped by what it did. */
.dash-task { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface); list-style: none; }
.dash-task[data-status="waiting_approval"] { border-left: 3px solid var(--dash-warning); }
.dash-task[data-status="waiting"] { border-left: 3px solid var(--dash-accent); }
.dash-task[data-status="reversed"], .dash-task[data-status="dismissed"] { opacity: 0.75; }
.dash-task__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dash-task__title { font-size: var(--dash-text-sm); }
.dash-task__text { margin: 0; font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); }
.dash-task__changes { border-collapse: collapse; font-size: var(--dash-text-sm); }
.dash-task__changes th, .dash-task__changes td { text-align: left; padding: 3px 12px 3px 0; }
.dash-task__changes th { font-size: var(--dash-text-xs); color: var(--dash-muted); font-weight: var(--dash-weight-semi); }
.dash-task__before { color: var(--dash-muted); text-decoration: line-through; }
.dash-task__conversation { display: flex; flex-direction: column; gap: 4px; }
.dash-task__bubble { margin: 0; padding: 6px 10px; border-radius: 12px 12px 12px 2px; background: var(--dash-wash); font-size: var(--dash-text-sm); max-width: 520px; }
.dash-task__bubble[data-from="them"] { align-self: flex-end; border-radius: 12px 12px 2px 12px; background: var(--dash-accent-wash); }
.dash-overview__detail { list-style: none; margin: 6px 0 0; padding: 0; flex-basis: 100%; }
.dash-overview__done { flex-wrap: wrap; }
.dash-overview__cases { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--dash-text-sm); }
.dash-overview__cases li { display: flex; gap: 8px; flex-wrap: wrap; }

@media (max-width: 960px) {
  .dash-builder__body { grid-template-columns: minmax(0, 1fr); }
  .dash-builder__panel { position: static; max-height: none; }
}

/* The Agent side's Overview: filters, active workflows, and completed tasks by day. */
.dash-overview { display: flex; flex-direction: column; gap: var(--dash-space-4, 16px); }
.dash-overview__filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dash-overview__filters select {
  font: inherit; font-size: var(--dash-text-sm); padding: 6px 8px; border-radius: var(--dash-radius-sm);
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink); flex: 0 1 200px; min-width: 0;
}
.dash-overview__panel .dash-agents__title { margin-bottom: 8px; }
.dash-overview__item {
  display: flex; flex-direction: column; gap: 6px; padding: 10px;
  border: 1px solid var(--dash-border); border-left-width: 3px; border-radius: var(--dash-radius-sm);
}
.dash-overview__item[data-state="running"] { border-left-color: var(--dash-accent); }
.dash-overview__item[data-state="waiting_approval"] { border-left-color: var(--dash-warning); }
.dash-overview__item[data-state="paused"] { border-left-color: var(--dash-critical); }
.dash-overview__facts { display: flex; flex-direction: column; gap: 2px; font-size: var(--dash-text-sm); min-width: 0; overflow-wrap: anywhere; }
.dash-overview__facts .dash-overview__link { white-space: normal; }
.dash-overview__fact { display: inline-block; min-width: 84px; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-overview__link {
  font: inherit; font-weight: var(--dash-weight-semi); color: var(--dash-ink); background: none; border: 0; padding: 0; cursor: pointer; text-align: left;
}
.dash-overview__link:hover { color: var(--dash-accent); text-decoration: underline; }
.dash-overview__timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dash-overview__done {
  display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--dash-border); font-size: var(--dash-text-sm);
}
.dash-overview__done:last-child { border-bottom: 0; }
.dash-overview__time { flex: 0 0 72px; font-size: var(--dash-text-xs); color: var(--dash-muted); font-variant-numeric: tabular-nums; }
.dash-overview__what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dash-overview__task { font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi); color: var(--dash-ink-secondary); margin-right: 4px; }
.dash-overview__what .dash-overview__link { font-weight: var(--dash-weight-normal, 400); color: inherit; }

@media (max-width: 760px) {
  .dash-agents { grid-template-columns: minmax(0, 1fr); }
}
` + DASH_CALENDAR_STYLES;
