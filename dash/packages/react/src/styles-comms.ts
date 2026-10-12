/**
 * Communications (`#/comms`): mailboxes on the left, the merged mail in the
 * middle, the conversation on the right; one pane at a time on a narrow
 * screen (`data-pane` says which). Built on the same tokens, inputs and
 * buttons as the Agent side.
 */
export const DASH_COMMS_STYLES = `
/* == layout ============================================================== */
.dash-comms {
  display: grid; grid-template-columns: minmax(220px, 260px) minmax(320px, 1fr) minmax(360px, 1.3fr);
  gap: 0; height: calc(100vh - 56px); min-height: 0; padding: 0; max-width: none;
}
.dash-comms > section, .dash-comms > aside { min-height: 0; overflow: auto; }
.dash-comms__boxes { border-right: 1px solid var(--dash-border); background: var(--dash-surface-sunken); padding: var(--dash-space-4) var(--dash-space-3); }
.dash-comms__mail { border-right: 1px solid var(--dash-border); display: flex; flex-direction: column; }
.dash-comms__thread { background: var(--dash-surface); }
@media (max-width: 900px) {
  .dash-comms { grid-template-columns: 1fr; height: auto; }
  .dash-comms[data-pane="list"] .dash-comms__thread { display: none; }
  .dash-comms[data-pane="thread"] .dash-comms__boxes, .dash-comms[data-pane="thread"] .dash-comms__mail { display: none; }
  .dash-comms__boxes, .dash-comms__mail { border-right: 0; border-bottom: 1px solid var(--dash-border); }
}

/* == mailboxes =========================================================== */
.dash-comms__boxes-head { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2); margin-bottom: var(--dash-space-3); }
.dash-comms__title { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); margin: 0; color: var(--dash-ink); }
.dash-comms__group {
  font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-muted);
  margin: var(--dash-space-4) 0 var(--dash-space-2);
}
.dash-comms__list { list-style: none; margin: 0 0 var(--dash-space-2); padding: 0; }
.dash-comms__agent + .dash-comms__agent { margin-top: var(--dash-space-2); }
.dash-comms__foot { margin-top: var(--dash-space-4); padding-top: var(--dash-space-2); border-top: 1px solid var(--dash-border); }
.dash-comms-area {
  font: inherit; font-size: var(--dash-text-sm); width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2);
  padding: 6px 8px; border: 1px solid transparent; border-radius: var(--dash-radius-sm); background: transparent; color: var(--dash-ink); cursor: pointer; text-align: left;
}
.dash-comms-area:hover { background: var(--dash-wash); }
.dash-comms-area[data-active="true"] { background: var(--dash-surface); border-color: var(--dash-border); box-shadow: var(--dash-shadow-sm); font-weight: var(--dash-weight-medium); }
.dash-comms-area__count { font-size: var(--dash-text-2xs); color: var(--dash-muted); font-variant-numeric: tabular-nums; }
.dash-comms-box { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-1); padding: 2px 4px 2px 12px; min-height: 30px; }
.dash-comms-box__pick { display: flex; align-items: center; gap: var(--dash-space-2); min-width: 0; cursor: pointer; font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); }
.dash-comms-box__pick input { accent-color: var(--dash-accent); margin: 0; }
.dash-comms-box__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-comms-box[data-status="needs_sign_in"] .dash-comms-box__name, .dash-comms-box[data-status="needs_app"] .dash-comms-box__name { color: var(--dash-muted); }
.dash-comms-box__more { font: inherit; border: 0; background: transparent; color: var(--dash-muted); cursor: pointer; padding: 2px 6px; border-radius: var(--dash-radius-sm); }
.dash-comms-box__more:hover { background: var(--dash-wash); color: var(--dash-ink); }

/* == mail ================================================================ */
.dash-comms__search { padding: var(--dash-space-3); border-bottom: 1px solid var(--dash-border); position: sticky; top: 0; background: var(--dash-surface); z-index: 1; }
.dash-comms__note { font-size: var(--dash-text-xs); color: var(--dash-muted); margin: var(--dash-space-2) var(--dash-space-3) 0; }
.dash-comms__messages { list-style: none; margin: 0; padding: 0; }
.dash-comms__empty { padding: var(--dash-space-4); }
.dash-comms-row {
  font: inherit; color: inherit; width: 100%; text-align: left; cursor: pointer; background: transparent; border: 0;
  border-bottom: 1px solid var(--dash-grid); padding: 10px var(--dash-space-3) 10px calc(var(--dash-space-3) + 8px); display: flex; flex-direction: column; gap: 2px;
  position: relative; transition: background var(--dash-dur-fast) var(--dash-ease);
}
.dash-comms-row:hover { background: var(--dash-wash); }
.dash-comms-row[data-active="true"] { background: var(--dash-wash); box-shadow: inset 3px 0 0 var(--dash-accent); }
.dash-comms-row:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: -2px; }
.dash-comms-row[data-unread="true"]::before { content: ""; position: absolute; left: 8px; top: 16px; width: 7px; height: 7px; border-radius: 50%; background: var(--dash-accent); }
.dash-comms-row__top { display: flex; justify-content: space-between; gap: var(--dash-space-2); }
.dash-comms-row__from { font-size: var(--dash-text-sm); color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-comms-row[data-unread="true"] .dash-comms-row__from, .dash-comms-row[data-unread="true"] .dash-comms-row__subject { font-weight: var(--dash-weight-semi); }
.dash-comms-row__when { font-size: var(--dash-text-xs); color: var(--dash-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.dash-comms-row__subject { font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-comms-row__snippet { font-size: var(--dash-text-xs); color: var(--dash-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-comms-row__tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.dash-comms-row__tags:empty { display: none; }
.dash-comms-tag { font-size: var(--dash-text-2xs); color: var(--dash-muted); padding: 1px 6px; border-radius: var(--dash-radius-pill); background: var(--dash-wash); }
.dash-comms-tag[data-tone="draft"] { color: var(--dash-accent); background: var(--dash-ring); }
.dash-comms__more { display: flex; justify-content: center; padding: var(--dash-space-3); }

/* == conversation ======================================================== */
.dash-comms-thread { padding: var(--dash-space-4); display: flex; flex-direction: column; gap: var(--dash-space-3); }
.dash-comms-thread__head { display: flex; align-items: center; gap: var(--dash-space-2); }
.dash-comms-thread__subject { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); margin: 0; color: var(--dash-ink); }
.dash-comms-thread__foot { display: flex; gap: var(--dash-space-2); }
.dash-comms-message { border: 1px solid var(--dash-border); border-radius: var(--dash-radius); padding: var(--dash-space-3); background: var(--dash-surface); box-shadow: var(--dash-shadow-sm); }
.dash-comms-message[data-sent="true"] { background: var(--dash-surface-sunken); }
.dash-comms-message__head { display: flex; justify-content: space-between; gap: var(--dash-space-2); }
.dash-comms-message__from { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-comms-message__when { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-comms-message__to { font-size: var(--dash-text-xs); color: var(--dash-muted); margin-bottom: var(--dash-space-2); }
.dash-comms-message__text { font: inherit; font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); white-space: pre-wrap; word-break: break-word; margin: 0; }
.dash-comms-draft { border: 1px dashed var(--dash-accent); border-radius: var(--dash-radius); padding: var(--dash-space-3); display: flex; flex-direction: column; gap: var(--dash-space-2); background: var(--dash-surface); }
.dash-comms-draft__head { display: flex; align-items: center; gap: var(--dash-space-2); }
.dash-comms-draft__label { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-accent); }
.dash-comms-field { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: var(--dash-space-2); font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-comms-draft__text { width: 100%; box-sizing: border-box; resize: vertical; min-height: 140px; font: inherit; font-size: var(--dash-text-sm); }
.dash-comms-draft__actions { display: flex; flex-wrap: wrap; gap: var(--dash-space-2); }
.dash-comms-review__summary { font-size: var(--dash-text-sm); color: var(--dash-ink); margin: 0; }
.dash-comms-review__rows { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-comms-review__row { display: grid; grid-template-columns: 96px 1fr; gap: var(--dash-space-2); font-size: var(--dash-text-sm); }
.dash-comms-review__row dt { color: var(--dash-muted); }
.dash-comms-review__row dd { margin: 0; color: var(--dash-ink); white-space: pre-wrap; word-break: break-word; }
.dash-comms-contact { border: 1px solid var(--dash-border); border-radius: var(--dash-radius); padding: var(--dash-space-3); background: var(--dash-surface-sunken); display: flex; flex-direction: column; gap: var(--dash-space-2); }
.dash-comms-contact__head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dash-space-2); }
.dash-comms-contact__name { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); text-decoration: none; }
.dash-comms-contact__name:hover { text-decoration: underline; }
.dash-contact-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dash-contact-messages__row { display: grid; grid-template-columns: 96px 1fr auto; gap: var(--dash-space-2); align-items: center; padding: 6px 0; border-top: 1px solid var(--dash-grid); font-size: var(--dash-text-sm); }
.dash-contact-messages__row:first-child { border-top: 0; }
.dash-contact-messages__when { color: var(--dash-muted); font-size: var(--dash-text-xs); font-variant-numeric: tabular-nums; }
.dash-contact-messages__subject { color: var(--dash-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-contact-messages__snippet { grid-column: 2 / -1; color: var(--dash-muted); font-size: var(--dash-text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-sched-panel__actions { display: inline-flex; align-items: center; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-workflow-field__picks { display: inline-flex; gap: var(--dash-space-2); margin-top: var(--dash-space-1); flex-wrap: wrap; }
.dash-comms-row[data-set-aside="true"] { opacity: 0.6; }
.dash-comms-thread__marks { margin-left: auto; display: inline-flex; gap: var(--dash-space-1); }
`;
