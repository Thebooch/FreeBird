/*
 * Scheduling's setup screens (the Calendar section's Appointment types,
 * Blocks, People & pools and Settings tabs), and the block bands behind the
 * week view. Prefix `dash-sched-`. Colours are tokens; a thing's own colour
 * arrives as `--cal-color`, a series slot, and is mixed against the surface.
 */
export const DASH_SCHEDULING_STYLES = `
/* == tabs and panels ===================================================== */
.dash-sched-tab { display: flex; flex-direction: column; gap: var(--dash-space-4); }
.dash-sched-tab__head { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-3); flex-wrap: wrap; }
.dash-sched-columns { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--dash-space-4); align-items: start; }
.dash-sched-panel {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm); padding: var(--dash-space-4); display: flex; flex-direction: column; gap: var(--dash-space-3); min-width: 0;
}
.dash-sched-panel__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dash-space-3); }
.dash-sched-panel__title { margin: 0; font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-sched-panel__lede { margin: 2px 0 0; font-size: var(--dash-text-sm); color: var(--dash-muted); max-width: 70ch; }
.dash-sched-empty { margin: 0; padding: var(--dash-space-4); border: 1px dashed var(--dash-border-strong); border-radius: var(--dash-radius-sm); font-size: var(--dash-text-sm); color: var(--dash-muted); text-align: center; }

/* A list of people or pools: one row each, the whole row the button. */
.dash-sched-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dash-sched-item {
  font: inherit; color: inherit; width: 100%; text-align: left; cursor: pointer;
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--dash-space-3);
  padding: 10px 12px; border: 1px solid transparent; border-radius: var(--dash-radius-sm); background: transparent;
}
button.dash-sched-item:hover { background: var(--dash-wash); }
button.dash-sched-item:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-sched-item[data-muted="true"] { cursor: default; background: var(--dash-surface-sunken); border-color: var(--dash-border); border-style: dashed; }
.dash-sched-item__main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-sched-item__title { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-sched-item__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-sched-item__aside { font-size: var(--dash-text-xs); color: var(--dash-muted); white-space: nowrap; }
.dash-sched-avatar {
  --cal-color: var(--dash-axis);
  width: 32px; height: 32px; border-radius: 50%; display: inline-grid; place-items: center; flex: none;
  font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink);
  background: color-mix(in srgb, var(--cal-color) 24%, var(--dash-surface)); box-shadow: inset 0 0 0 2px var(--cal-color);
}
.dash-sched-swatch { --cal-color: var(--dash-axis); width: 12px; height: 12px; border-radius: 4px; background: var(--cal-color); flex: none; }

/* == appointment type cards ============================================== */
.dash-sched-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--dash-space-3); }
.dash-sched-card {
  --cal-color: var(--dash-axis);
  font: inherit; color: inherit; text-align: left; cursor: pointer; position: relative; overflow: hidden;
  display: flex; flex-direction: column; gap: 6px; padding: var(--dash-space-4) var(--dash-space-4) var(--dash-space-4) calc(var(--dash-space-4) + 4px);
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius); box-shadow: var(--dash-shadow-sm);
  transition: box-shadow var(--dash-dur-fast) var(--dash-ease), border-color var(--dash-dur-fast) var(--dash-ease);
}
.dash-sched-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--cal-color); }
.dash-sched-card:hover { border-color: var(--dash-border-strong); box-shadow: var(--dash-shadow-hover); }
.dash-sched-card:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-sched-card__title { display: flex; align-items: center; gap: var(--dash-space-2); font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-sched-card__meta { font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); }
.dash-sched-card__badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }

/* == blocks ============================================================== */
.dash-sched-blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: var(--dash-space-3); align-items: start; }
.dash-sched-block {
  --cal-color: var(--dash-axis);
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius); box-shadow: var(--dash-shadow-sm);
  display: flex; flex-direction: column; overflow: hidden;
}
.dash-sched-block__head {
  font: inherit; color: inherit; text-align: left; cursor: pointer; border: 0; width: 100%;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px var(--dash-space-2); align-items: center;
  padding: var(--dash-space-4); background: color-mix(in srgb, var(--cal-color) 9%, var(--dash-surface));
  border-bottom: 1px solid var(--dash-border); box-shadow: inset 4px 0 0 var(--cal-color);
}
.dash-sched-block[data-kind="blank"] .dash-sched-block__head { background: var(--dash-surface-sunken); box-shadow: inset 4px 0 0 var(--dash-axis); }
.dash-sched-block[data-kind="closed"] .dash-sched-block__head {
  background: repeating-linear-gradient(135deg, var(--dash-surface-sunken) 0 6px, var(--dash-surface) 6px 12px); box-shadow: inset 4px 0 0 var(--dash-axis);
}
.dash-sched-block__head:hover { filter: brightness(0.985); }
.dash-sched-block__head:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-sched-block__name { font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-sched-block__summary { grid-column: 1 / -1; font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); }
.dash-sched-block__placements { list-style: none; margin: 0; padding: var(--dash-space-2) var(--dash-space-3); display: flex; flex-direction: column; gap: 2px; }
.dash-sched-block__placements > .dash-hint { padding: 6px 4px; }
.dash-sched-placement {
  font: inherit; color: inherit; text-align: left; width: 100%; cursor: pointer; border: 0; background: transparent;
  display: flex; flex-direction: column; gap: 1px; padding: 7px 8px; border-radius: var(--dash-radius-xs);
}
.dash-sched-placement:hover { background: var(--dash-wash); }
.dash-sched-placement:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-sched-placement__who { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.dash-sched-placement__when { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-sched-block__foot { padding: 0 var(--dash-space-3) var(--dash-space-3); }

/* == setup sheets ======================================================== */
.dash-sched-sheet { width: min(640px, 100%); }
.dash-sched-sheet[data-wide="true"] { width: min(820px, 100%); }
.dash-sched-section { gap: var(--dash-space-3); }
.dash-sched-section__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dash-space-3); }
.dash-sched-section__title { margin: 0; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-sched-section__desc { margin: 2px 0 0; font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: var(--dash-leading-normal); max-width: 68ch; }
.dash-sched-section__body { display: flex; flex-direction: column; gap: 2px; }
.dash-sched-section__actions { flex: none; }

.dash-sched-row {
  display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: var(--dash-space-2) var(--dash-space-4);
  padding: 10px 0; border-top: 1px solid var(--dash-grid); align-items: start;
}
.dash-sched-section__body > .dash-sched-row:first-child, .dash-sched-settings > .dash-sched-row:first-child { border-top: 0; }
.dash-sched-row__label { display: flex; flex-direction: column; gap: 2px; padding-top: 7px; min-width: 0; }
.dash-sched-row__label label { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.dash-sched-row__hint { font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: 1.45; }
.dash-sched-row__control { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.dash-sched-row__aside { font-size: var(--dash-text-xs); }
.dash-sched-row[data-wide="true"] { grid-template-columns: minmax(0, 1fr); gap: var(--dash-space-2); }
.dash-sched-row[data-wide="true"] .dash-sched-row__label { padding-top: 0; }

.dash-sched-input {
  font: inherit; font-size: var(--dash-text-sm); color: var(--dash-ink); background: var(--dash-surface);
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm); padding: 6px 10px; min-height: 34px;
  box-sizing: border-box; max-width: 100%;
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
input.dash-sched-input:not([type="checkbox"]), textarea.dash-sched-input { width: 100%; }
input.dash-sched-input[type="date"] { width: 168px; }
input.dash-sched-input[type="time"] { width: 128px; }
select.dash-sched-input { width: auto; min-width: 180px; cursor: pointer; }
.dash-sched-input:hover { border-color: var(--dash-axis); }
.dash-sched-input:focus-visible { outline: none; border-color: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-ring); }
.dash-sched-input--number { width: 96px !important; font-variant-numeric: tabular-nums; }
.dash-sched-textarea { min-height: 84px; resize: vertical; line-height: var(--dash-leading-normal); width: 100% !important; }
.dash-sched-duration { display: inline-flex; gap: 6px; align-items: center; }
.dash-sched-duration select.dash-sched-input { min-width: 112px; }
.dash-sched-setting { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; width: 100%; }
.dash-sched-setting > .dash-sched-rules, .dash-sched-setting > .dash-sched-consolidate, .dash-sched-setting > .dash-sched-chips { align-self: stretch; }
.dash-sched-setting[data-inherited="true"] .dash-sched-input,
.dash-sched-setting[data-inherited="true"] .dash-segmented { opacity: 0.72; }
.dash-sched-setting[data-inherited="true"]:focus-within .dash-sched-input,
.dash-sched-setting[data-inherited="true"]:hover .dash-sched-input { opacity: 1; }
.dash-sched-link {
  font: inherit; font-size: var(--dash-text-xs); color: var(--dash-accent); background: none; border: 0; padding: 0; cursor: pointer; text-align: left;
}
.dash-sched-link:hover:not(:disabled) { text-decoration: underline; }
.dash-sched-link:disabled { color: var(--dash-axis); cursor: default; }
.dash-sched-link:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; border-radius: 2px; }
.dash-sched-error { font-size: var(--dash-text-xs); color: var(--dash-critical); max-width: 46ch; }
.dash-sched-inline { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-sched-stack { display: flex; flex-direction: column; gap: var(--dash-space-2); width: 100%; }
.dash-sched-checks { display: flex; flex-direction: column; gap: 8px; }
.dash-sched-tab--narrow { max-width: 920px; }
.dash-sched-settings-page { display: flex; flex-direction: column; gap: var(--dash-space-4); }

/* Chips: values in a rule, fields to group by, skipped dates. */
.dash-sched-chips {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px; min-height: 34px; box-sizing: border-box;
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm); background: var(--dash-surface); width: 100%;
}
.dash-sched-chips:focus-within { border-color: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-ring); }
.dash-sched-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border-radius: var(--dash-radius-pill);
  background: var(--dash-accent-wash); color: var(--dash-ink); font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium);
  box-shadow: inset 0 0 0 1px var(--dash-accent-line);
}
.dash-sched-chip__remove { font: inherit; font-size: 10px; border: 0; background: transparent; color: var(--dash-muted); cursor: pointer; padding: 2px 5px; border-radius: 50%; }
.dash-sched-chip__remove:hover { color: var(--dash-ink); background: var(--dash-wash); }
.dash-sched-chips__input { font: inherit; font-size: var(--dash-text-sm); border: 0; outline: none; background: transparent; color: var(--dash-ink); flex: 1 1 64px; min-width: 48px; padding: 3px 4px; }

/* == rules =============================================================== */
.dash-sched-rules { display: flex; flex-direction: column; gap: var(--dash-space-3); width: 100%; }
.dash-sched-rules__group { display: flex; flex-direction: column; gap: 6px; padding: var(--dash-space-3); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken); }
.dash-sched-rules__group-head { display: flex; align-items: baseline; gap: var(--dash-space-2); }
.dash-sched-rules__group-title { font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi); color: var(--dash-ink); text-transform: uppercase; letter-spacing: 0.06em; }
.dash-sched-rules__empty { margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-sched-rule { display: grid; grid-template-columns: minmax(190px, 1.4fr) minmax(130px, auto) minmax(150px, 1.2fr) auto auto; gap: 6px; align-items: center; }
.dash-sched-rule .dash-sched-input, .dash-sched-rule .dash-sched-chips { width: 100% !important; min-width: 0; }
.dash-sched-rule__op { min-width: 130px !important; }
.dash-sched-rule__trust { display: inline-flex; align-items: center; gap: 5px; font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); white-space: nowrap; cursor: pointer; }
.dash-sched-rule__trust input { accent-color: var(--dash-accent); }
.dash-sched-rule__remove {
  font: inherit; font-size: 11px; border: 0; background: transparent; color: var(--dash-muted); cursor: pointer;
  width: 28px; height: 28px; border-radius: var(--dash-radius-xs); flex: none;
}
.dash-sched-rule__remove:hover { background: var(--dash-wash); color: var(--dash-critical); }
.dash-sched-rule__remove:focus-visible { outline: 2px solid var(--dash-accent); }

/* == consolidation ======================================================= */
.dash-sched-consolidate { display: flex; flex-direction: column; gap: var(--dash-space-3); width: 100%; }
.dash-sched-consolidate__body { display: flex; flex-direction: column; gap: var(--dash-space-2); padding: var(--dash-space-3); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken); }
.dash-sched-consolidate__line { display: grid; grid-template-columns: 76px minmax(0, 1fr); align-items: center; gap: var(--dash-space-2); }
.dash-sched-consolidate__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }

/* == working hours ======================================================= */
.dash-sched-hours { display: flex; flex-direction: column; width: 100%; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); overflow: hidden; }
.dash-sched-hours__day {
  display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; align-items: center; gap: var(--dash-space-2);
  padding: 8px 10px; border-top: 1px solid var(--dash-grid); background: var(--dash-surface);
}
.dash-sched-hours__day:first-child { border-top: 0; }
.dash-sched-hours__day[data-off="true"] { background: var(--dash-surface-sunken); }
.dash-sched-hours__ranges { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; min-width: 0; }
.dash-sched-hours__range { display: inline-flex; align-items: center; gap: 6px; }
.dash-sched-hours__range .dash-sched-input { width: 128px !important; padding: 4px 8px; min-height: 30px; font-variant-numeric: tabular-nums; }
.dash-sched-hours__foot { padding: 8px 10px; border-top: 1px solid var(--dash-grid); background: var(--dash-surface-sunken); }

/* == pools, questions, facts, order ====================================== */
.dash-sched-members { display: flex; flex-direction: column; gap: 4px; }
.dash-sched-members__row { display: flex; align-items: center; gap: var(--dash-space-4); flex-wrap: wrap; padding: 6px 0; border-top: 1px solid var(--dash-grid); }
.dash-sched-members__row:first-child { border-top: 0; }
.dash-sched-members__row > .dash-switch:first-child { min-width: 180px; }
.dash-sched-members__field { display: inline-flex; align-items: center; gap: 6px; }
.dash-sched-question { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 6px 0; }
.dash-sched-question .dash-sched-input { width: 100% !important; }
.dash-sched-facts { display: flex; flex-direction: column; gap: 6px; }
.dash-sched-facts__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; }
.dash-sched-facts__row .dash-sched-input { width: 100% !important; }
.dash-sched-order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dash-sched-order__row { display: grid; grid-template-columns: 22px auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--dash-space-2); padding: 8px 10px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface); }
.dash-sched-order__n { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); color: var(--dash-muted); }
.dash-sched-order__name { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); }
.dash-sched-daychips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.dash-sched-daychip {
  font: inherit; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium); min-width: 44px; padding: 6px 8px; cursor: pointer;
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm); background: var(--dash-surface); color: var(--dash-ink-secondary);
}
.dash-sched-daychip[aria-pressed="true"] { background: var(--dash-accent); border-color: var(--dash-accent); color: var(--dash-accent-ink); }
.dash-sched-daychip:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

/* == preview ============================================================= */
.dash-sched-preview { display: flex; flex-direction: column; gap: var(--dash-space-2); margin-top: var(--dash-space-2); }
.dash-sched-preview__day { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: var(--dash-space-2); align-items: start; padding: 6px 0; border-top: 1px solid var(--dash-grid); }
.dash-sched-preview__date { font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi); color: var(--dash-ink-secondary); padding-top: 4px; }
.dash-sched-preview__slots { display: flex; flex-wrap: wrap; gap: 4px; }
.dash-sched-slot {
  display: inline-flex; align-items: center; padding: 3px 8px; border-radius: var(--dash-radius-xs);
  font-size: var(--dash-text-xs); font-variant-numeric: tabular-nums; color: var(--dash-ink);
  background: var(--dash-surface); box-shadow: inset 0 0 0 1px var(--dash-border-strong);
}
.dash-sched-slot[data-consolidated="true"] { background: var(--dash-accent-wash); box-shadow: inset 0 0 0 1px var(--dash-accent-line); color: var(--dash-accent); font-weight: var(--dash-weight-semi); }
.dash-sched-slot[data-approval="true"] { background: repeating-linear-gradient(135deg, var(--dash-wash) 0 4px, var(--dash-surface) 4px 8px); }
.dash-sched-legend { margin: var(--dash-space-2) 0 0; font-size: var(--dash-text-xs); color: var(--dash-muted); }

/* == block bands behind the week ======================================== */
.dash-cal-week__band {
  --cal-color: var(--dash-axis);
  position: absolute; left: 0; right: 0; z-index: 1; pointer-events: none; box-sizing: border-box;
  background: color-mix(in srgb, var(--cal-color) 9%, transparent);
  border-top: 2px solid color-mix(in srgb, var(--cal-color) 55%, transparent);
}
.dash-cal-week__band[data-kind="blank"]:not([data-set="true"]) {
  background: repeating-linear-gradient(135deg, var(--dash-wash) 0 6px, transparent 6px 12px);
  border-top: 2px dashed var(--dash-axis);
}
.dash-cal-week__band[data-kind="closed"] {
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--dash-ink) 7%, transparent) 0 5px, transparent 5px 10px);
  border-top: 2px solid var(--dash-axis);
}
.dash-cal-week__band-label {
  position: absolute; top: 2px; right: 4px; max-width: calc(100% - 8px);
  font-size: var(--dash-text-micro); font-weight: var(--dash-weight-semi); letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--cal-color) 70%, var(--dash-ink)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-cal-week__band[data-kind="blank"]:not([data-set="true"]) .dash-cal-week__band-label,
.dash-cal-week__band[data-kind="closed"] .dash-cal-week__band-label { color: var(--dash-muted); }

@media (max-width: 960px) {
  .dash-sched-columns { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .dash-sched-row { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .dash-sched-row__label { padding-top: 0; }
  .dash-sched-rule { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .dash-sched-hours__day { grid-template-columns: minmax(0, 1fr); }
  .dash-sched-question { grid-template-columns: minmax(0, 1fr); }
  .dash-sched-item { grid-template-columns: auto minmax(0, 1fr); }
  .dash-sched-item__aside { display: none; }
}

/* == a workflow's booking trigger ======================================== */
.dash-trigger-group { border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); padding: 8px 12px 10px; margin: 0; min-width: 0; background: var(--dash-surface); }
.dash-trigger-group__title { padding: 0 4px; font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted); }
.dash-trigger-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 14px; padding-top: 4px; }
.dash-trigger-check { display: inline-flex; align-items: center; gap: 7px; font-size: var(--dash-text-sm); color: var(--dash-ink); cursor: pointer; line-height: 1.3; }
.dash-trigger-check input { accent-color: var(--dash-accent); width: 15px; height: 15px; flex: none; }

/* == the booking sheet =================================================== */
.dash-booking-sheet { width: min(640px, 100%); }
.dash-booking-status {
  display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap;
  padding: 10px 12px; border-radius: var(--dash-radius-sm); border: 1px solid var(--dash-border); background: var(--dash-surface-sunken);
}
.dash-booking-status[data-status="pending"], .dash-booking-status[data-status="suggested"] { background: color-mix(in srgb, var(--dash-warning) 8%, var(--dash-surface)); border-color: color-mix(in srgb, var(--dash-warning) 30%, transparent); }
.dash-booking-status[data-status="confirmed"] { background: var(--dash-accent-wash); border-color: var(--dash-accent-line); }
.dash-booking-status__words { font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); }
.dash-booking-when, .dash-booking-who { flex-direction: column; align-items: flex-start !important; gap: 2px !important; }
.dash-booking-host { display: inline-flex; align-items: center; gap: 8px; }
.dash-booking-host__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--cal-color, var(--dash-accent)); }
.dash-booking-answer { display: contents; }
.dash-booking-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dash-booking-list__row { display: flex; justify-content: space-between; gap: var(--dash-space-3); flex-wrap: wrap; padding: 8px 10px; border: 1px dashed var(--dash-border-strong); border-radius: var(--dash-radius-sm); font-size: var(--dash-text-sm); }
.dash-booking-change { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-3); flex-wrap: wrap; }
.dash-booking-panel { border: 1px solid var(--dash-accent-line); border-radius: var(--dash-radius-sm); padding: var(--dash-space-3) !important; background: var(--dash-surface); display: flex; flex-direction: column; gap: var(--dash-space-2); }
.dash-booking-panel .dash-field { margin-bottom: 0; }
.dash-booking-panel .dash-field__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-booking-slot { font: inherit; cursor: pointer; border: 0; }
.dash-booking-slot:hover { box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.dash-booking-slot[data-selected="true"] { background: var(--dash-accent); color: var(--dash-accent-ink, #fff); box-shadow: none; }
.dash-booking-slot:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; }
.dash-booking-history { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; }
.dash-booking-history__row { position: relative; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: var(--dash-space-2); align-items: baseline; padding: 6px 0; font-size: var(--dash-text-sm); }
.dash-booking-history__row:not(:last-child)::after { content: ""; position: absolute; left: 4px; top: 20px; bottom: -6px; width: 1px; background: var(--dash-border); }
.dash-booking-history__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dash-axis); transform: translateY(1px); }
.dash-booking-history__row[data-status="confirmed"] .dash-booking-history__dot, .dash-booking-history__row[data-status="completed"] .dash-booking-history__dot { background: var(--dash-accent); }
.dash-booking-history__row[data-status="pending"] .dash-booking-history__dot, .dash-booking-history__row[data-status="suggested"] .dash-booking-history__dot { background: var(--dash-warning); }
.dash-booking-history__row[data-status="denied"] .dash-booking-history__dot, .dash-booking-history__row[data-status="no_show"] .dash-booking-history__dot { background: var(--dash-critical); }
.dash-booking-history__what { display: flex; flex-direction: column; gap: 2px; color: var(--dash-ink); }
.dash-booking-history__note { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-booking-history__when { font-size: var(--dash-text-xs); color: var(--dash-muted); white-space: nowrap; }

/* A link made and copied: the button, then what happened. */
.dash-copylink { display: inline-flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; min-width: 0; }
.dash-copylink__done { font-size: var(--dash-text-xs); color: var(--dash-good); }
.dash-copylink__error { font-size: var(--dash-text-xs); color: var(--dash-critical); }
.dash-copylink__field {
  font: inherit; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-ink);
  min-width: 0; width: min(360px, 100%); padding: 5px 8px; border-radius: var(--dash-radius-xs);
  border: 1px solid var(--dash-accent-line); background: var(--dash-accent-wash);
}

/* A contact's booking links, on the contact sheet. */
.dash-booklinks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--dash-space-2); }
.dash-booklink {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--dash-space-3);
  padding: 10px 12px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface);
}
.dash-booklink[data-state="withdrawn"], .dash-booklink[data-state="expired"] { background: var(--dash-surface-sunken); }
.dash-booklink__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-booklink__title { display: inline-flex; align-items: center; gap: var(--dash-space-2); font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.dash-booklink__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-booklinks__make { display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; margin-top: var(--dash-space-3); }
.dash-booklinks__make select { max-width: 260px; }
.dash-booklinks__made { margin-top: var(--dash-space-3); display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: var(--dash-radius-sm); background: var(--dash-accent-wash); border: 1px solid var(--dash-accent-line); }
.dash-booklinks__made-row { display: flex; align-items: center; gap: var(--dash-space-2); }
.dash-booklinks__made input { flex: 1; min-width: 0; font: inherit; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); padding: 6px 8px; border-radius: var(--dash-radius-xs); border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink); }
.dash-booklinks__made .dash-hint { margin: 0; }
`;
