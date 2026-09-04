/*
 * The app-shell sheet: page, grid, sheet, nav, chat, connection wizard.
 *
 * The shared control units (button, icon button, badge, field) moved to the
 * components package when they became real units in `ui/`. A consumer using
 * only @freebirdai/dash-components has to get working controls out of one stylesheet.
 */
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
.dash-nav {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: var(--dash-space-4);
  padding: var(--dash-space-3) var(--dash-space-5);
  background: var(--dash-surface);
  border-bottom: 1px solid var(--dash-border);
}
.dash-nav__brand {
  display: inline-flex; align-items: center; gap: var(--dash-space-2); flex: none;
  font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.02em; color: var(--dash-ink);
  padding-right: var(--dash-space-4); border-right: 1px solid var(--dash-border);
}
.dash-nav__mark {
  width: 14px; height: 14px; border-radius: 5px; flex: none;
  background: linear-gradient(140deg, var(--dash-accent-strong), var(--dash-accent));
  box-shadow: 0 0 0 3px var(--dash-accent-wash);
}

.dash-nav__rail {
  display: flex; align-items: center; gap: var(--dash-space-1);
  min-width: 0; flex: 1 1 auto;
  overflow-x: auto; scrollbar-width: none;
}
.dash-nav__rail::-webkit-scrollbar { display: none; }
.dash-nav__hint { font-size: var(--dash-text-xs); color: var(--dash-muted); white-space: nowrap; }

.dash-nav__tab {
  font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium);
  white-space: nowrap; flex: none;
  border: 1px solid transparent; border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 32px;
  background: transparent; color: var(--dash-ink-secondary);
  cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease),
              color var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__tab:hover { background: var(--dash-wash); color: var(--dash-ink); }
/* The active tab is a tint plus a ring, not a solid fill: at this size a
   filled pill next to five others reads as a button, not as "you are here". */
.dash-nav__tab[data-active="true"] {
  background: var(--dash-accent-wash);
  border-color: var(--dash-accent-line);
  color: var(--dash-accent);
  font-weight: var(--dash-weight-semi);
}
.dash-nav__tab:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

.dash-nav__tab--editing {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-pill);
  padding: 2px var(--dash-space-1) 2px var(--dash-space-3); background: var(--dash-surface-sunken);
}
.dash-nav__rename {
  font: inherit; font-size: var(--dash-text-sm); width: 11ch; min-width: 6ch;
  border: none; background: transparent; color: var(--dash-ink); padding: 3px 0;
}
.dash-nav__rename:focus-visible { outline: none; }
.dash-nav__x, .dash-nav__confirm {
  font: inherit; border: none; background: transparent; cursor: pointer;
  color: var(--dash-muted); border-radius: var(--dash-radius-pill);
  padding: 3px var(--dash-space-2); line-height: 1;
}
.dash-nav__x { font-size: var(--dash-text-2xs); }
.dash-nav__x:hover { color: var(--dash-critical); background: var(--dash-surface); }
.dash-nav__confirm {
  font-size: var(--dash-text-xs); color: var(--dash-critical);
  font-weight: var(--dash-weight-semi);
}

.dash-nav__add {
  font: inherit; font-size: var(--dash-text-sm); white-space: nowrap; flex: none;
  border: 1px dashed var(--dash-border); border-radius: var(--dash-radius-pill);
  padding: var(--dash-space-1) var(--dash-space-3); min-height: 32px;
  background: transparent; color: var(--dash-muted); cursor: pointer;
  transition: border-color var(--dash-dur-fast) var(--dash-ease),
              color var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__add:hover { border-color: var(--dash-accent); color: var(--dash-accent); }

.dash-nav__actions { display: flex; align-items: center; gap: var(--dash-space-2); flex: none; }
.dash-nav__icon {
  font: inherit; font-size: var(--dash-text-sm); cursor: pointer;
  width: 34px; height: 34px; border-radius: var(--dash-radius-sm);
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-muted);
  transition: color var(--dash-dur-fast) var(--dash-ease),
              border-color var(--dash-dur-fast) var(--dash-ease),
              background var(--dash-dur-fast) var(--dash-ease);
}
.dash-nav__icon:hover { color: var(--dash-ink); border-color: var(--dash-axis); }
.dash-nav__icon[data-on="true"] {
  border-color: var(--dash-accent-line); background: var(--dash-accent-wash); color: var(--dash-accent);
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
  display: flex; align-items: center; gap: var(--dash-space-2);
  padding: var(--dash-space-3) var(--dash-space-4);
  border-bottom: 1px solid var(--dash-border);
  flex: none;
}
.dash-chat__title {
  font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em; margin: 0; color: var(--dash-ink);
}

.dash-chat__log {
  flex: 1; overflow-y: auto; padding: var(--dash-space-4);
  display: flex; flex-direction: column; gap: var(--dash-space-3);
}

.dash-chat__msg {
  font-size: var(--dash-text-sm); line-height: var(--dash-leading-normal);
  white-space: pre-wrap; word-break: break-word;
  padding: var(--dash-space-3) var(--dash-space-3);
  border-radius: var(--dash-radius);
  max-width: 92%;
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
  border-bottom-right-radius: var(--dash-radius-sm);
}
.dash-chat__msg[data-role="assistant"] {
  align-self: flex-start;
  background: var(--dash-surface-sunken); color: var(--dash-ink);
  border: 1px solid var(--dash-border);
  border-bottom-left-radius: var(--dash-radius-sm);
}
.dash-chat__msg[data-role="tool"] {
  align-self: stretch; max-width: 100%;
  background: transparent; border: 1px dashed var(--dash-border);
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
  display: flex; gap: var(--dash-space-2); padding: var(--dash-space-3) var(--dash-space-4);
  border-top: 1px solid var(--dash-border);
  flex: none;
}
.dash-chat__input {
  flex: 1; font: inherit; font-size: var(--dash-text-sm); resize: none;
  color: var(--dash-ink); background: var(--dash-surface-sunken);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  padding: var(--dash-space-2) var(--dash-space-3);
  min-height: 38px; max-height: 140px;
  line-height: var(--dash-leading-normal);
}
.dash-chat__input:focus-visible {
  outline: 2px solid var(--dash-accent); outline-offset: 1px;
}

.dash-chat__empty {
  font-size: var(--dash-text-sm); color: var(--dash-muted);
  line-height: var(--dash-leading-relaxed);
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
`;
