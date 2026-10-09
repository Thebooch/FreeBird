/**
 * The Contacts section: the list with its search, the contact sheet (where
 * each value came from, linked records, activity), and the field and
 * matching setup. Built on the calendar page's header and scheduling's
 * panels and sheets, so the Agent side reads as one product.
 */
export const DASH_CONTACTS_STYLES = `
/* == list ================================================================ */
.dash-contacts-toolbar { display: flex; align-items: center; gap: var(--dash-space-3); flex-wrap: wrap; }
.dash-contacts-toolbar__count { font-size: var(--dash-text-xs); color: var(--dash-muted); font-variant-numeric: tabular-nums; margin-left: auto; }
.dash-contacts-search {
  position: relative; display: flex; align-items: center; flex: 1 1 320px; max-width: 460px;
}
.dash-contacts-search__icon { position: absolute; left: 11px; width: 15px; height: 15px; color: var(--dash-muted); pointer-events: none; }
.dash-contacts-search__input {
  font: inherit; font-size: var(--dash-text-sm); color: var(--dash-ink); width: 100%; box-sizing: border-box;
  padding: 8px 12px 8px 34px; min-height: 38px; border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm);
  background: var(--dash-surface); box-shadow: var(--dash-shadow-sm);
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.dash-contacts-search__input:hover { border-color: var(--dash-axis); }
.dash-contacts-search__input:focus-visible { outline: none; border-color: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-ring); }
.dash-contacts-search__input::-webkit-search-cancel-button { cursor: pointer; }

.dash-contacts-empty { background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius); box-shadow: var(--dash-shadow-sm); padding: var(--dash-space-6) var(--dash-space-4); }

.dash-contacts-table {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius);
  box-shadow: var(--dash-shadow-sm); overflow: hidden;
}
.dash-contacts-table__head, .dash-contacts-row {
  display: grid; grid-template-columns: minmax(220px, 2.2fr) minmax(160px, 1.6fr) minmax(130px, 1fr) minmax(120px, 1fr) 96px;
  align-items: center; gap: var(--dash-space-3); padding: 0 var(--dash-space-4);
}
.dash-contacts-table__head {
  min-height: 36px; background: var(--dash-surface-sunken); border-bottom: 1px solid var(--dash-border);
  font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
}
.dash-contacts-table__right { text-align: right; justify-self: end; }
.dash-contacts-row {
  font: inherit; color: inherit; width: 100%; text-align: left; cursor: pointer; background: transparent; border: 0;
  border-top: 1px solid var(--dash-grid); min-height: 58px; padding-top: 8px; padding-bottom: 8px;
  transition: background var(--dash-dur-fast) var(--dash-ease);
}
.dash-contacts-table__head + .dash-contacts-row { border-top: 0; }
.dash-contacts-row:hover { background: var(--dash-wash); }
.dash-contacts-row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-contacts-row__name { display: flex; align-items: center; gap: var(--dash-space-3); min-width: 0; }
.dash-contacts-row__who { display: flex; flex-direction: column; min-width: 0; }
.dash-contacts-row__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-contacts-row__sub { display: none; font-size: var(--dash-text-xs); color: var(--dash-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-contacts-row__cell { font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-contacts-row__mono { font-variant-numeric: tabular-nums; }
.dash-contacts-muted { color: var(--dash-muted); font-size: var(--dash-text-xs); }
.dash-contacts-more {
  margin-left: 6px; font-size: var(--dash-text-2xs); color: var(--dash-muted); padding: 1px 6px; border-radius: var(--dash-radius-pill);
  background: var(--dash-wash); font-variant-numeric: tabular-nums;
}
.dash-contacts-table__foot { display: flex; justify-content: center; padding: var(--dash-space-2); border-top: 1px solid var(--dash-grid); }

.dash-contacts-avatar {
  --cal-color: var(--dash-accent);
  flex: none; width: 34px; height: 34px; border-radius: 50%; display: inline-grid; place-items: center;
  font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi); letter-spacing: 0.02em;
  color: var(--cal-color); background: color-mix(in srgb, var(--cal-color) 14%, var(--dash-surface));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cal-color) 36%, transparent);
}
.dash-contacts-avatar--large { width: 48px; height: 48px; font-size: var(--dash-text-md); }

/* == contact sheet ======================================================= */
.dash-contact-hero { display: flex; align-items: center; gap: var(--dash-space-3); padding: 2px 2px var(--dash-space-1); }
.dash-contact-hero__who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-contact-hero__name { font-size: var(--dash-text-md); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.dash-contact-hero__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }

.dash-contacts-check { display: inline-flex; align-items: center; gap: 6px; font-size: var(--dash-text-sm); color: var(--dash-ink); cursor: pointer; margin-right: var(--dash-space-3); }
.dash-contacts-check input { accent-color: var(--dash-accent); width: 15px; height: 15px; }
.dash-contacts-note { margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: var(--dash-leading-normal); padding: 6px 0; }

.dash-contact-field { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
.dash-contact-field select.dash-sched-input { min-width: 220px; }
.dash-contact-provenance { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); overflow: hidden; }
.dash-contact-provenance__row {
  display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: var(--dash-space-2); align-items: center;
  padding: 6px 10px; border-top: 1px solid var(--dash-grid); background: var(--dash-surface-sunken); font-size: var(--dash-text-xs);
}
.dash-contact-provenance__row:first-child { border-top: 0; }
.dash-contact-provenance__row[data-winning="true"] { background: var(--dash-surface); }
.dash-contact-provenance__from { font-weight: var(--dash-weight-medium); color: var(--dash-ink-secondary); display: inline-flex; align-items: center; gap: 6px; }
.dash-contact-provenance__from::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--dash-axis); flex: none; }
.dash-contact-provenance__row[data-from="record"] .dash-contact-provenance__from::before { background: var(--dash-accent); }
.dash-contact-provenance__row[data-from="member"] .dash-contact-provenance__from::before { background: var(--dash-good); }
.dash-contact-provenance__row[data-from="person"] .dash-contact-provenance__from::before { background: var(--dash-warning); }
.dash-contact-provenance__row:not([data-winning="true"]) .dash-contact-provenance__value { color: var(--dash-muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--dash-muted) 60%, transparent); }
.dash-contact-provenance__value { color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-contact-provenance__when { color: var(--dash-muted); white-space: nowrap; }

.dash-contact-match {
  display: flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap;
  padding: 8px 10px; border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken); border: 1px solid var(--dash-border);
}
.dash-contact-match__detail { font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); flex: 1 1 240px; line-height: var(--dash-leading-normal); }
.dash-contact-match__when { font-size: var(--dash-text-2xs); color: var(--dash-muted); }
.dash-contact-links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dash-contact-link {
  display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-3);
  padding: 10px 12px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface);
}
.dash-contact-link[data-linked="true"] { box-shadow: inset 3px 0 0 var(--dash-accent); }
.dash-contact-link__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-contact-link__title { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.dash-contact-link__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }

.dash-contacts-callout {
  display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-3);
  padding: 10px 12px; border-radius: var(--dash-radius-sm); font-size: var(--dash-text-sm);
  background: var(--dash-accent-wash); border: 1px solid var(--dash-accent-line); color: var(--dash-ink);
}
.dash-contacts-callout[data-tone="warn"] {
  background: color-mix(in srgb, var(--dash-warning) 10%, var(--dash-surface)); border-color: color-mix(in srgb, var(--dash-warning) 40%, transparent);
  font-size: var(--dash-text-xs); line-height: var(--dash-leading-normal);
}

.dash-contact-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--dash-space-2); }
.dash-contact-stat {
  display: flex; flex-direction: column; gap: 2px; padding: 10px 12px;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken);
}
.dash-contact-stat__value { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); color: var(--dash-ink); font-variant-numeric: tabular-nums; }
.dash-contact-stat__label { font-size: var(--dash-text-xs); color: var(--dash-muted); }

/* == fields and matching ================================================= */
.dash-contacts-kind {
  flex: none; width: 32px; height: 32px; border-radius: var(--dash-radius-sm); display: inline-grid; place-items: center;
  font-size: var(--dash-text-xs); font-weight: var(--dash-weight-semi); color: var(--dash-accent);
  background: var(--dash-accent-wash); box-shadow: inset 0 0 0 1px var(--dash-accent-line);
}
.dash-contacts-key {
  font-family: var(--dash-font-mono); font-size: var(--dash-text-2xs); font-weight: var(--dash-weight-normal); color: var(--dash-ink-secondary);
  padding: 1px 6px; border-radius: var(--dash-radius-xs); background: var(--dash-wash); border: 1px solid var(--dash-border);
  margin-left: var(--dash-space-2); white-space: nowrap;
}
.dash-contacts-key--large { font-size: var(--dash-text-xs); margin-left: 0; padding: 5px 8px; }
.dash-contacts-badges { display: inline-flex; gap: 6px; align-items: center; }
.dash-contacts-keyinput { display: flex; align-items: stretch; width: 100%; }
.dash-contacts-keyinput__prefix {
  display: inline-flex; align-items: center; padding: 0 10px; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-muted);
  background: var(--dash-surface-sunken); border: 1px solid var(--dash-border-strong); border-right: 0;
  border-radius: var(--dash-radius-sm) 0 0 var(--dash-radius-sm);
}
.dash-contacts-keyinput .dash-sched-input { border-radius: 0 var(--dash-radius-sm) var(--dash-radius-sm) 0; font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); }

.dash-contact-source { display: flex; flex-direction: column; gap: var(--dash-space-2); padding: var(--dash-space-3); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken); }
.dash-contact-source + .dash-contact-source { margin-top: var(--dash-space-2); }
.dash-contact-source__pick { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr) auto; gap: 6px; align-items: center; }
.dash-contact-source__pick select.dash-sched-input { width: 100%; min-width: 0; }
.dash-contact-source__map { display: flex; flex-direction: column; gap: 6px; }
.dash-contact-source__map-title { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted); }
.dash-contact-source__map-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 6px var(--dash-space-3); }
.dash-contact-source__map-row { display: grid; grid-template-columns: minmax(70px, auto) auto minmax(0, 1fr); align-items: center; gap: 8px; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-contact-source__map-row .dash-contacts-key { margin-left: 0; justify-self: start; }
.dash-contact-source__map-row select.dash-sched-input { width: 100%; min-width: 0; }
.dash-contact-source__samples { font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); }

.dash-contact-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.3fr) auto; gap: var(--dash-space-2); align-items: center; padding: 4px 0; }
.dash-contact-pair select.dash-sched-input { width: 100%; min-width: 0; }
.dash-contact-pair__equals { font-family: var(--dash-font-mono); color: var(--dash-muted); }

@media (max-width: 900px) {
  .dash-contacts-table__head, .dash-contacts-row { grid-template-columns: minmax(0, 1fr) auto; }
  .dash-contacts-table__head > :not(:first-child), .dash-contacts-row [data-column="email"], .dash-contacts-row [data-column="phone"], .dash-contacts-row [data-column="updated"] { display: none; }
  .dash-contacts-row__sub { display: block; }
}
@media (max-width: 640px) {
  .dash-contacts-search { max-width: none; }
  .dash-contacts-toolbar__count { order: 3; margin-left: 0; }
  .dash-contact-provenance__row { grid-template-columns: minmax(0, 1fr) auto; }
  .dash-contact-provenance__when { grid-column: 1 / -1; }
  .dash-contact-source__pick, .dash-contact-pair { grid-template-columns: minmax(0, 1fr) auto; }
  .dash-contact-source__pick > select, .dash-contact-pair > select { grid-column: 1; }
  .dash-contact-pair__equals { display: none; }
}
`;
