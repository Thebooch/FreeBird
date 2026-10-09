/*
 * The Calendar section on the Agent side: the month, week and agenda views,
 * the legend, an entry's sheet and the entry form.
 *
 * Its own prefix (`dash-cal-`), apart from the Calendar *widget*'s
 * `dash-calendar__*`, so a board's calendar tile and this page never restyle
 * each other. Every colour is a token: an entry's owner colour arrives as
 * `--cal-color` (a series slot), and tints are mixed from it against the
 * surface, so both themes work without a rule of their own.
 */
export const DASH_CALENDAR_STYLES = `
/* == the page ============================================================ */
.dash-cal-page { display: flex; flex-direction: column; gap: var(--dash-space-4); }
.dash-cal-page__head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: var(--dash-space-4); flex-wrap: wrap;
}
.dash-cal-page__title {
  margin: 0; font-size: var(--dash-text-xl); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.015em; line-height: var(--dash-leading-tight); color: var(--dash-ink);
}
.dash-cal-page__lede { margin: var(--dash-space-1) 0 0; font-size: var(--dash-text-sm); color: var(--dash-muted); max-width: 64ch; }
.dash-cal-page__tabs { margin-top: calc(-1 * var(--dash-space-2)); }

/* A row of mutually exclusive choices, drawn as one control. */
.dash-segmented {
  display: inline-flex; align-items: stretch; gap: 2px; padding: 2px;
  background: var(--dash-wash); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
}
.dash-segmented__option {
  font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium);
  border: 0; border-radius: calc(var(--dash-radius-sm) - 2px); background: transparent; color: var(--dash-muted);
  padding: 0 var(--dash-space-3); min-height: 28px; cursor: pointer; white-space: nowrap;
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease);
}
.dash-segmented__option:hover { color: var(--dash-ink); }
.dash-segmented__option[aria-checked="true"] {
  background: var(--dash-surface); color: var(--dash-ink);
  box-shadow: 0 1px 2px rgba(22, 23, 26, 0.08), inset 0 0 0 1px var(--dash-border);
}
.dash-segmented__option:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

/* On or off: a checkbox drawn as a switch. */
.dash-switch { position: relative; display: inline-flex; align-items: center; gap: var(--dash-space-2); cursor: pointer; font-size: var(--dash-text-sm); color: var(--dash-ink); }
.dash-switch[data-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.dash-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.dash-switch__track {
  position: relative; flex: none; width: 34px; height: 20px; border-radius: var(--dash-radius-pill);
  background: var(--dash-track); box-shadow: inset 0 0 0 1px var(--dash-border);
  transition: background var(--dash-dur-fast) var(--dash-ease);
}
.dash-switch__track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #ffffff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform var(--dash-dur-fast) var(--dash-ease);
}
.dash-switch input:checked + .dash-switch__track { background: var(--dash-accent); box-shadow: none; }
.dash-switch input:checked + .dash-switch__track::after { transform: translateX(14px); }
.dash-switch input:focus-visible + .dash-switch__track { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-switch__text { display: flex; flex-direction: column; min-width: 0; }
.dash-switch__label { font-weight: var(--dash-weight-medium); }
.dash-switch__hint { font-size: var(--dash-text-xs); color: var(--dash-muted); }

/* == the board: calendar and legend ====================================== */
.dash-cal {
  display: grid; grid-template-columns: minmax(0, 1fr) 248px; gap: var(--dash-space-4); align-items: start;
}
.dash-cal__main {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm); min-width: 0; overflow: hidden;
}
.dash-cal__toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-3); flex-wrap: wrap;
  padding: var(--dash-space-3) var(--dash-space-4); border-bottom: 1px solid var(--dash-border);
}
.dash-cal__nav { display: flex; align-items: center; gap: var(--dash-space-2); min-width: 0; }
.dash-cal__steppers { display: inline-flex; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); overflow: hidden; }
.dash-cal__step {
  font: inherit; border: 0; background: var(--dash-surface); color: var(--dash-ink-secondary);
  width: 32px; min-height: 32px; cursor: pointer; display: inline-grid; place-items: center;
}
.dash-cal__step + .dash-cal__step { border-left: 1px solid var(--dash-border); }
.dash-cal__step:hover { background: var(--dash-wash); color: var(--dash-ink); }
.dash-cal__step:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-cal__step svg { width: 14px; height: 14px; }
.dash-cal__period {
  margin: 0 0 0 var(--dash-space-2); font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi);
  letter-spacing: -0.01em; color: var(--dash-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dash-cal__actions { display: flex; align-items: center; gap: var(--dash-space-2); }

/* Your calendar on your phone: a small panel under the Subscribe button. */
.dash-cal-feed { position: relative; }
.dash-cal-feed__panel {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: min(380px, calc(100vw - 32px));
  display: flex; flex-direction: column; gap: var(--dash-space-3); padding: var(--dash-space-4);
  background: var(--dash-surface-raised); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-md);
}
.dash-cal-feed__head { display: flex; flex-direction: column; gap: 4px; }
.dash-cal-feed__head strong { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-cal-feed__head span, .dash-cal-feed__state { margin: 0; font-size: var(--dash-text-xs); line-height: 1.5; color: var(--dash-ink-secondary); }
.dash-cal-feed__made { display: flex; flex-direction: column; gap: var(--dash-space-2); padding: var(--dash-space-3); border-radius: var(--dash-radius-sm); background: var(--dash-accent-wash); border: 1px solid var(--dash-accent-line); }
.dash-cal-feed__made input {
  font: inherit; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-ink);
  padding: 6px 8px; border-radius: var(--dash-radius-xs); border: 1px solid var(--dash-border); background: var(--dash-surface); width: 100%; min-width: 0;
}
.dash-cal-feed__made .dash-hint { margin: 0; }
.dash-cal-feed__row { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-cal-feed__row a.dash-btn { text-decoration: none; }
.dash-cal-feed__foot { padding-top: var(--dash-space-2); border-top: 1px solid var(--dash-border); }
.dash-cal__sync {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dash-axis); border-top-color: var(--dash-accent);
  flex: none; margin-left: var(--dash-space-1);
}
@media (prefers-reduced-motion: no-preference) {
  .dash-cal__sync { animation: dash-spin 800ms linear infinite; }
}
.dash-cal__notice { margin: var(--dash-space-3) var(--dash-space-4) 0; }

/* == an entry, as a chip ================================================= */
.dash-cal-chip {
  --cal-color: var(--dash-axis);
  font: inherit; display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; text-align: left;
  font-size: var(--dash-text-2xs); line-height: 1.3; color: var(--dash-ink);
  padding: 2px 6px 2px 7px; min-height: 20px; cursor: pointer;
  border: 0; border-radius: var(--dash-radius-xs);
  background: color-mix(in srgb, var(--cal-color) 13%, var(--dash-surface));
  box-shadow: inset 2px 0 0 var(--cal-color);
  transition: background var(--dash-dur-fast) var(--dash-ease);
}
.dash-cal-chip:hover { background: color-mix(in srgb, var(--cal-color) 22%, var(--dash-surface)); }
.dash-cal-chip:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-cal-chip__time { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); color: var(--dash-ink-secondary); flex: none; letter-spacing: 0.02em; }
.dash-cal-chip__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-weight: var(--dash-weight-medium); }
.dash-cal-chip__flag { color: var(--cal-color); flex: none; font-size: 10px; line-height: 1; }
/* A deadline is a marker, not a block of time: an outline in its colour. */
.dash-cal-chip[data-kind="deadline"] {
  background: var(--dash-surface);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cal-color) 55%, transparent), inset 2px 0 0 var(--cal-color);
}
/* Held but not settled: hatched, so it never reads as booked. */
.dash-cal-chip[data-status="tentative"] {
  background: repeating-linear-gradient(135deg,
    color-mix(in srgb, var(--cal-color) 16%, var(--dash-surface)) 0 5px,
    var(--dash-surface) 5px 9px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cal-color) 40%, transparent), inset 2px 0 0 var(--cal-color);
}
.dash-cal-chip[data-status="done"] { opacity: 0.62; }
.dash-cal-chip[data-status="done"] .dash-cal-chip__title,
.dash-cal-chip[data-status="cancelled"] .dash-cal-chip__title { text-decoration: line-through; text-decoration-color: var(--dash-muted); }
.dash-cal-chip[data-status="cancelled"] { opacity: 0.5; background: var(--dash-wash); box-shadow: inset 2px 0 0 var(--dash-axis); }

/* == month =============================================================== */
.dash-cal-month { display: flex; flex-direction: column; }
.dash-cal-month__weekdays {
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
  border-bottom: 1px solid var(--dash-border); background: var(--dash-surface-sunken);
}
.dash-cal-month__weekday {
  padding: 8px 10px; font-family: var(--dash-font-mono); font-size: var(--dash-text-micro);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
}
.dash-cal-month__grid {
  display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-auto-rows: minmax(118px, auto);
  gap: 1px; background: var(--dash-grid);
}
.dash-cal-month__cell {
  position: relative; background: var(--dash-surface); padding: 6px 6px 8px; min-width: 0;
  display: flex; flex-direction: column; gap: 4px;
}
.dash-cal-month__cell[data-weekend="true"] { background: color-mix(in srgb, var(--dash-surface-sunken) 60%, var(--dash-surface)); }
.dash-cal-month__cell[data-outside="true"] { background: var(--dash-surface-sunken); }
.dash-cal-month__cell[data-outside="true"] .dash-cal-month__num { color: var(--dash-axis); }
.dash-cal-month__date { display: flex; align-items: center; justify-content: space-between; padding: 0 2px; }
.dash-cal-month__num {
  font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium); color: var(--dash-ink-secondary);
  min-width: 24px; height: 24px; padding: 0 6px; border-radius: var(--dash-radius-pill);
  border: 0; background: transparent; cursor: pointer; display: inline-grid; place-items: center;
}
.dash-cal-month__num:hover { background: var(--dash-wash); color: var(--dash-ink); }
.dash-cal-month__num:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.dash-cal-month__cell[data-today="true"] .dash-cal-month__num {
  background: var(--dash-accent); color: var(--dash-accent-ink); font-weight: var(--dash-weight-semi);
}
.dash-cal-month__add {
  opacity: 0; font: inherit; font-size: var(--dash-text-sm); line-height: 1; color: var(--dash-muted);
  border: 0; background: transparent; cursor: pointer; width: 22px; height: 22px; border-radius: var(--dash-radius-xs);
  transition: opacity var(--dash-dur-fast) var(--dash-ease);
}
.dash-cal-month__cell:hover .dash-cal-month__add, .dash-cal-month__add:focus-visible { opacity: 1; }
.dash-cal-month__add:hover { background: var(--dash-wash); color: var(--dash-ink); }
.dash-cal-month__entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-cal-month__more {
  font: inherit; font-size: var(--dash-text-2xs); font-weight: var(--dash-weight-medium); color: var(--dash-ink-secondary);
  background: none; border: 0; padding: 1px 6px; text-align: left; cursor: pointer; border-radius: var(--dash-radius-xs);
}
.dash-cal-month__more:hover { background: var(--dash-wash); color: var(--dash-ink); }

/* The whole day, floated over the grid when "+N more" is pressed. */
.dash-cal-pop {
  position: absolute; z-index: 20; top: 4px; left: 4px; width: max(100%, 260px); max-height: 320px; overflow: auto;
  background: var(--dash-surface-raised); border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm);
  box-shadow: var(--dash-shadow-md); padding: var(--dash-space-2) var(--dash-space-2) var(--dash-space-3);
  display: flex; flex-direction: column; gap: 4px;
}
.dash-cal-month__cell:nth-child(7n) .dash-cal-pop, .dash-cal-month__cell:nth-child(7n-1) .dash-cal-pop { left: auto; right: 4px; }
.dash-cal-pop__head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
.dash-cal-pop__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); }

/* == week ================================================================ */
.dash-cal-week { --cal-hour: 48px; display: flex; flex-direction: column; }
.dash-cal-week__head, .dash-cal-week__allday, .dash-cal-week__body {
  display: grid; grid-template-columns: 64px repeat(7, minmax(0, 1fr));
}
.dash-cal-week__head { border-bottom: 1px solid var(--dash-border); background: var(--dash-surface-sunken); }
.dash-cal-week__day {
  display: flex; align-items: baseline; gap: 6px; padding: 8px 10px; min-width: 0;
  border-left: 1px solid var(--dash-grid);
}
.dash-cal-week__dow { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted); }
.dash-cal-week__date { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); color: var(--dash-ink-secondary); line-height: 1; }
.dash-cal-week__day[data-today="true"] .dash-cal-week__date {
  color: var(--dash-accent-ink); background: var(--dash-accent); border-radius: var(--dash-radius-pill); padding: 3px 8px;
}
.dash-cal-week__day[data-today="true"] .dash-cal-week__dow { color: var(--dash-accent); }
.dash-cal-week__allday { border-bottom: 1px solid var(--dash-border); min-height: 32px; }
.dash-cal-week__allday-label, .dash-cal-week__hour {
  font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); color: var(--dash-muted);
  text-align: right; padding: 6px 8px 0 0; letter-spacing: 0.04em;
}
.dash-cal-week__allday-cell { border-left: 1px solid var(--dash-grid); padding: 4px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-cal-week__scroll { max-height: min(68vh, 760px); overflow-y: auto; position: relative; }
.dash-cal-week__body { position: relative; }
.dash-cal-week__hours { display: flex; flex-direction: column; }
.dash-cal-week__hour { height: var(--cal-hour); box-sizing: border-box; padding-top: 0; transform: translateY(-6px); }
.dash-cal-week__col {
  position: relative; border-left: 1px solid var(--dash-grid); min-width: 0;
  background-image: linear-gradient(to bottom, var(--dash-grid) 1px, transparent 1px);
  background-size: 100% var(--cal-hour);
}
.dash-cal-week__col[data-today="true"] { background-color: color-mix(in srgb, var(--dash-accent) 3%, var(--dash-surface)); }
.dash-cal-week__slot { position: absolute; left: 0; right: 0; height: calc(var(--cal-hour) / 2); border: 0; background: transparent; cursor: pointer; padding: 0; }
.dash-cal-week__slot:hover { background: var(--dash-accent-wash); }
.dash-cal-week__slot:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-cal-week__event {
  --cal-color: var(--dash-axis);
  position: absolute; z-index: 2; box-sizing: border-box; overflow: hidden;
  font: inherit; text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 1px; padding: 3px 6px 3px 8px;
  border: 0; border-radius: var(--dash-radius-xs); color: var(--dash-ink);
  background: color-mix(in srgb, var(--cal-color) 16%, var(--dash-surface));
  box-shadow: inset 3px 0 0 var(--cal-color), 0 0 0 1px var(--dash-surface);
}
.dash-cal-week__event:hover { background: color-mix(in srgb, var(--cal-color) 24%, var(--dash-surface)); z-index: 3; }
.dash-cal-week__event:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; z-index: 3; }
.dash-cal-week__event[data-status="tentative"] {
  background: repeating-linear-gradient(135deg,
    color-mix(in srgb, var(--cal-color) 18%, var(--dash-surface)) 0 6px,
    var(--dash-surface) 6px 11px);
  box-shadow: inset 3px 0 0 var(--cal-color), inset 0 0 0 1px color-mix(in srgb, var(--cal-color) 45%, transparent);
}
.dash-cal-week__event[data-status="done"] { opacity: 0.62; }
.dash-cal-week__event[data-status="cancelled"] { opacity: 0.5; background: var(--dash-wash); box-shadow: inset 3px 0 0 var(--dash-axis); }
.dash-cal-week__event-title { font-size: var(--dash-text-2xs); font-weight: var(--dash-weight-semi); line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-cal-week__event-time { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); color: var(--dash-ink-secondary); white-space: nowrap; }
.dash-cal-week__now { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid var(--dash-critical); z-index: 4; pointer-events: none; }
.dash-cal-week__now::before {
  content: ""; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--dash-critical);
}

/* == agenda ============================================================== */
.dash-cal-agenda { display: flex; flex-direction: column; }
.dash-cal-agenda__day { border-bottom: 1px solid var(--dash-border); }
.dash-cal-agenda__day:last-child { border-bottom: 0; }
.dash-cal-agenda__dayhead {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: var(--dash-space-2);
  padding: 10px var(--dash-space-4) 8px; background: var(--dash-surface-sunken); border-bottom: 1px solid var(--dash-grid);
}
.dash-cal-agenda__dow { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted); width: 34px; }
.dash-cal-agenda__date { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-cal-agenda__count { margin-left: auto; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-cal-agenda__list { list-style: none; margin: 0; padding: var(--dash-space-1) 0; }
.dash-cal-agenda__row {
  --cal-color: var(--dash-axis);
  font: inherit; color: inherit; text-align: left; width: 100%; border: 0; background: transparent; cursor: pointer;
  display: grid; grid-template-columns: 132px 3px minmax(0, 1fr) auto; align-items: center; gap: var(--dash-space-3);
  padding: 9px var(--dash-space-4);
}
.dash-cal-agenda__row:hover { background: var(--dash-wash); }
.dash-cal-agenda__row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-cal-agenda__time { font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); white-space: nowrap; }
.dash-cal-agenda__time-end::before { content: " – "; }
.dash-cal-agenda__bar { align-self: stretch; min-height: 28px; border-radius: 2px; background: var(--cal-color); }
.dash-cal-agenda__row[data-status="tentative"] .dash-cal-agenda__bar {
  background: repeating-linear-gradient(180deg, var(--cal-color) 0 4px, transparent 4px 7px);
}
.dash-cal-agenda__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-cal-agenda__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-cal-agenda__row[data-status="done"] .dash-cal-agenda__title,
.dash-cal-agenda__row[data-status="cancelled"] .dash-cal-agenda__title { text-decoration: line-through; text-decoration-color: var(--dash-muted); color: var(--dash-ink-secondary); }
.dash-cal-agenda__meta { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; font-size: var(--dash-text-xs); color: var(--dash-muted); min-width: 0; }
.dash-cal-agenda__side { display: flex; align-items: center; gap: var(--dash-space-2); flex: none; }
.dash-cal-agenda__empty { padding: var(--dash-space-7) var(--dash-space-4); }

/* == legend ============================================================== */
.dash-cal-legend {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm); padding: var(--dash-space-4); display: flex; flex-direction: column; gap: var(--dash-space-4);
  position: sticky; top: var(--dash-space-4);
}
.dash-cal-legend__groups { display: flex; flex-direction: column; gap: var(--dash-space-4); }
.dash-cal-legend__group { display: flex; flex-direction: column; gap: 2px; }
.dash-cal-legend__group > select.dash-sched-input { width: 100%; min-width: 0; }
.dash-cal-legend__title {
  margin: 0 0 var(--dash-space-1); font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
  display: flex; align-items: center; justify-content: space-between;
}
.dash-cal-legend__reset { font: inherit; font-family: var(--dash-font); text-transform: none; letter-spacing: 0; font-size: var(--dash-text-2xs); color: var(--dash-accent); background: none; border: 0; cursor: pointer; padding: 0; }
.dash-cal-legend__reset:hover { text-decoration: underline; }
.dash-cal-legend__row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: var(--dash-space-2);
  padding: 5px 6px; border-radius: var(--dash-radius-xs); cursor: pointer; font-size: var(--dash-text-sm); color: var(--dash-ink);
}
.dash-cal-legend__row:hover { background: var(--dash-wash); }
.dash-cal-legend__row input { position: absolute; opacity: 0; pointer-events: none; }
.dash-cal-legend__box {
  width: 14px; height: 14px; border-radius: 4px; box-sizing: border-box; display: inline-grid; place-items: center;
  border: 1.5px solid var(--cal-color, var(--dash-axis)); background: var(--cal-color, var(--dash-axis)); color: var(--dash-surface);
  transition: background var(--dash-dur-fast) var(--dash-ease);
}
.dash-cal-legend__box svg { width: 10px; height: 10px; }
.dash-cal-legend__row[data-off="true"] .dash-cal-legend__box { background: transparent; }
.dash-cal-legend__row[data-off="true"] .dash-cal-legend__box svg { display: none; }
.dash-cal-legend__row[data-off="true"] .dash-cal-legend__name { color: var(--dash-muted); }
.dash-cal-legend__row:has(input:focus-visible) { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-cal-legend__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-cal-legend__count { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); color: var(--dash-muted); }
.dash-cal-legend__empty { font-size: var(--dash-text-xs); color: var(--dash-muted); margin: 0; padding: 2px 6px; }
.dash-cal-legend__stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dash-space-2); }
.dash-cal-legend__stat { background: var(--dash-surface-sunken); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); padding: 8px 10px; }
.dash-cal-legend__stat-value { display: block; font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); color: var(--dash-ink); line-height: 1.2; }
.dash-cal-legend__stat-label { font-size: var(--dash-text-2xs); color: var(--dash-muted); }

/* == an entry's sheet ==================================================== */
.dash-cal-sheet__swatch { width: 10px; height: 10px; border-radius: 3px; background: var(--cal-color, var(--dash-axis)); flex: none; }
.dash-cal-sheet__facts { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px var(--dash-space-4); margin: 0; }
.dash-cal-sheet__facts dt { font-size: var(--dash-text-xs); color: var(--dash-muted); padding-top: 1px; }
.dash-cal-sheet__facts dd { margin: 0; font-size: var(--dash-text-sm); color: var(--dash-ink); min-width: 0; display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-cal-sheet__when { font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-cal-sheet__notes { margin: 0; white-space: pre-wrap; font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); line-height: var(--dash-leading-relaxed); }
.dash-cal-sheet__link {
  font: inherit; font-size: var(--dash-text-sm); color: var(--dash-accent); background: none; border: 0; padding: 0; cursor: pointer;
  text-align: left; text-decoration: underline; text-decoration-color: var(--dash-accent-line); text-underline-offset: 2px;
}
.dash-cal-sheet__link:hover { text-decoration-color: currentColor; }
.dash-cal-sheet__link:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; border-radius: 2px; }
.dash-cal-sheet__foot {
  display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2); flex-wrap: wrap;
  padding: var(--dash-space-3) var(--dash-space-5); border-top: 1px solid var(--dash-border); background: var(--dash-surface-raised); flex: none;
}
.dash-cal-sheet__foot-group { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-cal-sheet__callout {
  display: flex; gap: var(--dash-space-2); align-items: flex-start; padding: 10px 12px; border-radius: var(--dash-radius-sm);
  background: var(--dash-accent-wash); border: 1px solid var(--dash-accent-line); font-size: var(--dash-text-xs); color: var(--dash-ink-secondary);
}

/* == the entry form ====================================================== */
.dash-cal-form { display: flex; flex-direction: column; gap: var(--dash-space-4); }
.dash-cal-form__row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--dash-space-3); }
.dash-cal-form .dash-field { margin-bottom: 0; }
.dash-cal-form__inline { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--dash-space-3); flex-wrap: wrap; }
.dash-cal-form__group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dash-cal-form__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-cal-form__inline .dash-switch { min-height: 34px; }
.dash-cal-form textarea { min-height: 96px; resize: vertical; line-height: var(--dash-leading-normal); }
.dash-cal-form__error {
  margin: 0; padding: 8px 10px; border-radius: var(--dash-radius-sm); font-size: var(--dash-text-xs);
  color: var(--dash-critical); background: color-mix(in srgb, var(--dash-critical) 8%, var(--dash-surface));
  border: 1px solid color-mix(in srgb, var(--dash-critical) 30%, transparent);
}

@media (max-width: 1080px) {
  .dash-cal { grid-template-columns: minmax(0, 1fr); }
  .dash-cal-legend { position: static; }
  .dash-cal-legend__groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--dash-space-4); }
}
@media (max-width: 720px) {
  .dash-cal-month__grid { grid-auto-rows: minmax(84px, auto); }
  .dash-cal-chip__time { display: none; }
  .dash-cal-agenda__row { grid-template-columns: 76px 3px minmax(0, 1fr); padding: 9px var(--dash-space-3); }
  .dash-cal-agenda__time { display: flex; flex-direction: column; gap: 2px; }
  .dash-cal-agenda__time-end { color: var(--dash-muted); }
  .dash-cal-agenda__time-end::before { content: none; }
  .dash-cal__toolbar { padding: var(--dash-space-3); }
  .dash-cal__period { font-size: var(--dash-text-md); margin-left: var(--dash-space-1); }
  .dash-cal-agenda__side { display: none; }
  .dash-cal-sheet__facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .dash-cal-sheet__facts dd { margin-bottom: var(--dash-space-2); }
}
`;
