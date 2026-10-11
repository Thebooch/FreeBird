/*
 * The Reports pop-up, opened from a tab's ⋯ menu: the list of a tab's timed
 * reports, and the editor with its email preview beside it. Its own prefix
 * (`dash-reports`); the form controls are the calendar form's, so the two
 * read as one product.
 */
export const DASH_REPORTS_STYLES = `
/* == the list ============================================================ */
.dash-reports__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--dash-space-3); }
.dash-reports__item {
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius); background: var(--dash-surface);
  box-shadow: var(--dash-shadow-sm); padding: var(--dash-space-3) var(--dash-space-4);
  display: flex; flex-direction: column; gap: var(--dash-space-3);
}
.dash-reports__item[data-enabled="false"] .dash-reports__name { color: var(--dash-muted); }
.dash-reports__item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dash-space-3); }
.dash-reports__item-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dash-reports__name { font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); color: var(--dash-ink); overflow-wrap: anywhere; }
.dash-reports__meta { font-size: var(--dash-text-xs); color: var(--dash-muted); }
.dash-reports__actions { display: flex; gap: var(--dash-space-2); flex-wrap: wrap; }
.dash-reports__empty { display: flex; flex-direction: column; gap: var(--dash-space-1); padding: var(--dash-space-4) 0; }
.dash-reports__empty p { margin: 0; }
.dash-reports__notice {
  margin: 0; padding: 8px 10px; border-radius: var(--dash-radius-sm); font-size: var(--dash-text-xs);
  color: var(--dash-ink-secondary); background: var(--dash-wash); border: 1px solid var(--dash-border);
}

/* == the editor ========================================================== */
.dash-reports__editor { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: var(--dash-space-5); align-items: start; }
.dash-reports__form textarea { min-height: 64px; }
.dash-reports__widgets {
  margin: 0; padding: var(--dash-space-2) var(--dash-space-3); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm);
  display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow: auto;
}
.dash-reports__widgets legend { padding: 0 4px; }
.dash-reports__widget { display: flex; flex-direction: column; gap: 6px; }
.dash-reports__widget[data-picked="true"] { padding-bottom: 4px; }
.dash-reports__emphasis-line { margin-left: 26px; font: inherit; font-size: var(--dash-text-xs); }
.dash-reports .dash-reports__emphasis { min-height: 56px; }
.dash-reports__check { display: flex; align-items: center; gap: var(--dash-space-2); font-size: var(--dash-text-sm); color: var(--dash-ink); cursor: pointer; }
.dash-reports__preview {
  position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--dash-space-2);
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius); background: var(--dash-surface); padding: var(--dash-space-3);
}
.dash-reports__preview-head { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2); }
.dash-reports__preview-head .dash-cal-form__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-reports__frame { width: 100%; height: 560px; border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: #f3f4f6; }
.dash-reports__warnings { margin: 0; padding-left: 18px; font-size: var(--dash-text-xs); color: var(--dash-warning, var(--dash-muted)); }

@media (max-width: 860px) {
  .dash-reports__editor { grid-template-columns: minmax(0, 1fr); }
  .dash-reports__preview { position: static; }
  .dash-reports__frame { height: 420px; }
}
`;
