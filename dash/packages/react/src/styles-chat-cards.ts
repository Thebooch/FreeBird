/**
 * What the chat puts in the column besides its words: the card a proposed
 * change waits on (what it does, before → after, Approve), the card for a
 * value handed over once (a link that is itself a key), and the ring a
 * citation leaves on the setting it points at.
 */
export const DASH_CHAT_CARD_STYLES = `
/* == approval card ======================================================= */
.dash-action-card {
  margin: var(--dash-space-3) 0 0; padding: var(--dash-space-4);
  background: var(--dash-surface); border: 1px solid var(--dash-border);
  border-radius: var(--dash-radius); box-shadow: var(--dash-shadow-md);
  display: flex; flex-direction: column; gap: var(--dash-space-3);
  animation: dash-msg-in var(--dash-dur-base) var(--dash-ease-out) both;
}
.dash-action-card__head { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2); min-width: 0; }
.dash-action-card__eyebrow {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--dash-font-mono); font-size: var(--dash-text-micro, 10.5px); font-weight: var(--dash-weight-medium);
  text-transform: uppercase; letter-spacing: var(--dash-tracking-label); color: var(--dash-accent);
}
.dash-action-card__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-accent-wash); flex: none; }
.dash-action-card__where {
  font-size: var(--dash-text-2xs, 11px); color: var(--dash-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding: 1px var(--dash-space-2); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-pill); background: var(--dash-surface-sunken);
}
.dash-action-card__title {
  margin: 0; font-size: var(--dash-text-md, 15px); font-weight: var(--dash-weight-semi); line-height: 1.3;
  letter-spacing: -0.01em; color: var(--dash-ink); overflow-wrap: anywhere;
}
.dash-action-card__summary { margin: calc(var(--dash-space-2) * -1) 0 0; font-size: var(--dash-text-sm); line-height: 1.5; color: var(--dash-ink-secondary); overflow-wrap: anywhere; }
.dash-action-card__rows {
  margin: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dash-border); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken);
  max-height: 320px; overflow-y: auto;
}
.dash-action-card__row {
  display: grid; grid-template-columns: minmax(84px, 38%) minmax(0, 1fr); gap: var(--dash-space-3);
  padding: 7px var(--dash-space-3); border-bottom: 1px solid var(--dash-border); font-size: var(--dash-text-xs); line-height: 1.45;
}
.dash-action-card__row:last-child { border-bottom: 0; }
.dash-action-card__row[data-multiline="true"] { grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dash-action-card__label { color: var(--dash-muted); font-weight: var(--dash-weight-medium); overflow-wrap: anywhere; }
.dash-action-card__value { margin: 0; color: var(--dash-ink); overflow-wrap: anywhere; white-space: pre-wrap; }
.dash-action-card__before { color: var(--dash-muted); text-decoration: line-through; text-decoration-color: var(--dash-border-strong); }
.dash-action-card__arrow { color: var(--dash-muted); margin: 0 6px; }
.dash-action-card__after { color: var(--dash-ink); font-weight: var(--dash-weight-medium); }
.dash-action-card__actions {
  display: flex; justify-content: flex-end; gap: var(--dash-space-2);
  padding-top: var(--dash-space-3); border-top: 1px solid var(--dash-border);
}

/* == shown-once card ===================================================== */
.dash-once {
  margin: var(--dash-space-3) 0 0; padding: var(--dash-space-3) var(--dash-space-4) var(--dash-space-4);
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-left: 3px solid var(--dash-good);
  border-radius: var(--dash-radius); box-shadow: var(--dash-shadow-sm);
  display: flex; flex-direction: column; gap: var(--dash-space-2);
  animation: dash-msg-in var(--dash-dur-base) var(--dash-ease-out) both;
}
.dash-once__head { display: flex; align-items: center; justify-content: space-between; gap: var(--dash-space-2); }
.dash-once__title { margin: 0; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.dash-once__close {
  font: inherit; font-size: 18px; line-height: 1; width: 26px; height: 26px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--dash-radius-sm); background: transparent; color: var(--dash-muted); cursor: pointer;
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease);
}
.dash-once__close:hover { background: var(--dash-wash); color: var(--dash-ink); }
.dash-once__close:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dash-ring); }
.dash-once__note { margin: 0; font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: 1.45; }
.dash-once__row { display: flex; align-items: center; gap: var(--dash-space-2); }
.dash-once__value {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box; min-height: 32px; padding: 6px 10px;
  font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-ink);
  border: 1px solid var(--dash-border-strong); border-radius: var(--dash-radius-sm); background: var(--dash-surface-sunken);
  text-overflow: ellipsis;
}
.dash-once__value:focus-visible { outline: none; border-color: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-ring); }

/* == cited setting ======================================================== */
/* A citation chip on an approved change lands on the setting it names, and
   wears the ring a cited widget wears, so "it's here" looks the same everywhere. */
[data-freebird-component] [data-cited="true"] {
  animation: dash-landed 2.4s ease-out 1; border-radius: var(--dash-radius-sm);
}
@media (prefers-reduced-motion: reduce) {
  .dash-action-card, .dash-once { animation: none; }
}
`;
