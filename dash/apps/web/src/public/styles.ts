/**
 * The public pages' own rules, on top of Dash's theme tokens (`DASH_STYLES`).
 * Every color, size, radius and duration is a `--dash-*` token, so dark mode
 * and reduced motion come from the theme; the workspace's brand color is
 * written over `--dash-accent` (`brandCss`).
 */

const hex = (value: string): [number, number, number] => {
  const clean = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "0f4d52";
  return [0, 2, 4].map((at) => parseInt(clean.slice(at, at + 2), 16)) as [number, number, number];
};
const mix = (value: string, toward: number, amount: number): string =>
  `#${hex(value)
    .map((channel) => Math.round(channel + (toward - channel) * amount))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
const rgba = (value: string, alpha: number): string => `rgba(${hex(value).join(", ")}, ${alpha})`;
const luminance = (value: string): number => {
  const [r, g, b] = hex(value).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The brand color over the theme's accent, light and dark. */
export const brandCss = (accent: string): string => {
  const dark = luminance(accent) < 0.18 ? mix(accent, 255, 0.38) : accent;
  const ink = (color: string) => (luminance(color) > 0.45 ? "#111316" : "#ffffff");
  const block = (color: string, washAlpha: number) => `
    --dash-accent: ${color};
    --dash-accent-strong: ${mix(color, 255, 0.1)};
    --dash-accent-ink: ${ink(color)};
    --dash-accent-wash: ${rgba(color, washAlpha)};
    --dash-accent-line: ${rgba(color, 0.3)};
    --dash-ring: ${rgba(color, 0.3)};`;
  /* Above the theme's own dark block, which is ":root … .dash-root". */
  return `:root .dash-root.pub {${block(accent, 0.08)}\n}
@media (prefers-color-scheme: dark) { :root .dash-root.pub {${block(dark, 0.16)}\n} }`;
};

export const PUBLIC_STYLES = `
.pub {
  min-height: 100vh; display: flex; flex-direction: column;
  background: var(--dash-plane); color: var(--dash-ink);
  font-size: var(--dash-text-md); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
.pub *, .pub *::before, .pub *::after { box-sizing: border-box; }
.pub h1, .pub h2, .pub h3, .pub p { margin: 0; }
.pub a { color: var(--dash-accent); text-underline-offset: 2px; }
.pub a.dash-btn { color: var(--dash-ink); text-decoration: none; }

/* ── frame ─────────────────────────────────────────────────────────────── */
.pub-top { width: 100%; max-width: 1080px; margin: 0 auto; padding: 22px 24px 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pub-brand { display: inline-flex; align-items: center; gap: 10px; font-weight: var(--dash-weight-semi); font-size: 15px; letter-spacing: -0.01em; color: var(--dash-ink); }
.pub-brand__mark {
  width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; flex: none;
  background: linear-gradient(180deg, var(--dash-accent-strong), var(--dash-accent)); color: var(--dash-accent-ink);
  font-size: 13px; font-weight: var(--dash-weight-bold); box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 6px -2px var(--dash-ring);
}
.pub-secure { display: inline-flex; align-items: center; gap: 6px; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.pub-main { width: 100%; max-width: 1080px; margin: 0 auto; padding: 24px 24px 48px; flex: 1; }
.pub-main[data-width="narrow"] { max-width: 680px; }
.pub-foot { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 24px 32px; font-size: var(--dash-text-xs); color: var(--dash-muted); text-align: center; line-height: 1.6; }

.pub-card {
  background: var(--dash-surface); border: 1px solid var(--dash-border); border-radius: var(--dash-radius-lg);
  box-shadow: var(--dash-shadow-sm);
}
.pub-card__body { padding: 32px; }
.pub-card__section + .pub-card__section { border-top: 1px solid var(--dash-border); }

.pub-eyebrow { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); letter-spacing: var(--dash-tracking-label); text-transform: uppercase; color: var(--dash-muted); }
.pub-title { font-size: var(--dash-text-2xl); line-height: 1.2; font-weight: var(--dash-weight-semi); letter-spacing: -0.02em; color: var(--dash-ink); }
.pub-title[data-size="sm"] { font-size: var(--dash-text-xl); }
.pub-subtitle { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); letter-spacing: -0.01em; color: var(--dash-ink); }
.pub-lead { font-size: var(--dash-text-md); line-height: var(--dash-leading-relaxed); color: var(--dash-ink-secondary); }
.pub-muted { color: var(--dash-muted); font-size: var(--dash-text-sm); line-height: 1.55; }
.pub-stack { display: flex; flex-direction: column; gap: 16px; }
.pub-stack[data-gap="sm"] { gap: 8px; }
.pub-stack[data-gap="lg"] { gap: 24px; }
.pub-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pub-row[data-justify="end"] { justify-content: flex-end; }
.pub-row[data-justify="between"] { justify-content: space-between; }
.pub-divider { height: 1px; background: var(--dash-border); border: 0; margin: 0; }

/* ── facts about the appointment ───────────────────────────────────────── */
.pub-meta { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.pub-meta__item { display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: start; color: var(--dash-ink-secondary); font-size: var(--dash-text-md); line-height: 1.45; }
.pub-meta__item svg { margin-top: 2px; color: var(--dash-muted); }
.pub-meta__item strong { color: var(--dash-ink); font-weight: var(--dash-weight-medium); }

.pub-details { display: grid; grid-template-columns: 96px 1fr; margin: 0; border: 1px solid var(--dash-border); border-radius: var(--dash-radius); overflow: hidden; background: var(--dash-surface-sunken); }
.pub-details dt, .pub-details dd { margin: 0; padding: 12px 16px; border-top: 1px solid var(--dash-border); }
.pub-details dt:first-of-type, .pub-details dt:first-of-type + dd { border-top: 0; }
.pub-details dt { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); letter-spacing: var(--dash-tracking-label); text-transform: uppercase; color: var(--dash-muted); padding-top: 15px; }
.pub-details dd { color: var(--dash-ink); font-size: var(--dash-text-md); line-height: 1.45; min-width: 0; overflow-wrap: anywhere; }
.pub-details dd small { display: block; color: var(--dash-muted); font-size: var(--dash-text-sm); margin-top: 2px; }

/* ── buttons ───────────────────────────────────────────────────────────── */
.pub .dash-btn { min-height: 40px; padding: 8px 16px; font-size: var(--dash-text-md); border-radius: 10px; justify-content: center; }
.pub .dash-btn[data-size="lg"] { min-height: 46px; padding: 10px 20px; font-size: 15px; }
.pub .dash-btn[data-size="sm"] { min-height: 32px; padding: 4px 12px; font-size: var(--dash-text-sm); }
.pub .dash-btn[data-block="true"] { width: 100%; }
.pub .dash-btn[data-tone="danger-solid"] { background: var(--dash-critical); border-color: transparent; color: #fff; font-weight: 600; }
.pub .dash-btn[data-tone="danger-solid"]:hover:not(:disabled) { filter: brightness(1.08); background: var(--dash-critical); }
.pub-link { font: inherit; border: 0; background: none; padding: 0; color: var(--dash-accent); cursor: pointer; font-weight: var(--dash-weight-medium); display: inline-flex; align-items: center; gap: 6px; }
.pub-link:hover { text-decoration: underline; text-underline-offset: 3px; }
.pub-link:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 2px; border-radius: 4px; }

/* ── forms ─────────────────────────────────────────────────────────────── */
.pub-form { display: flex; flex-direction: column; gap: 18px; }
.pub-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.pub-grid3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; }
.pub-form fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.pub-form legend { padding: 0; margin-bottom: 6px; }
.pub-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pub-field__label { font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); color: var(--dash-ink); }
.pub-field__label em { font-style: normal; color: var(--dash-muted); font-weight: var(--dash-weight-normal); margin-left: 4px; }
.pub-field__hint { font-size: var(--dash-text-xs); color: var(--dash-muted); line-height: 1.5; }
.pub-field__error { font-size: var(--dash-text-xs); color: var(--dash-critical); line-height: 1.5; }
.pub-input, .pub-select, .pub-textarea {
  font: inherit; font-size: var(--dash-text-md); color: var(--dash-ink); width: 100%;
  background: var(--dash-surface); border: 1px solid var(--dash-border-strong); border-radius: 10px;
  padding: 10px 12px; min-height: 42px;
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.pub-textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
.pub-select { appearance: none; padding-right: 34px; background-image: linear-gradient(45deg, transparent 50%, var(--dash-muted) 50%), linear-gradient(135deg, var(--dash-muted) 50%, transparent 50%); background-position: calc(100% - 17px) 18px, calc(100% - 12px) 18px; background-size: 5px 5px; background-repeat: no-repeat; }
.pub-input:hover, .pub-select:hover, .pub-textarea:hover { border-color: var(--dash-axis); }
.pub-input:focus, .pub-select:focus, .pub-textarea:focus { outline: none; border-color: var(--dash-accent); box-shadow: 0 0 0 3px var(--dash-ring); }
.pub-input[aria-invalid="true"] { border-color: var(--dash-critical); }
.pub-input::placeholder, .pub-textarea::placeholder { color: var(--dash-muted); }
/* The field only scripts fill in. */
.pub-trap { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }

/* ── notices ───────────────────────────────────────────────────────────── */
.pub-alert { display: grid; grid-template-columns: 20px 1fr; gap: 10px; padding: 12px 14px; border-radius: 12px; font-size: var(--dash-text-sm); line-height: 1.55; border: 1px solid var(--dash-border); background: var(--dash-surface-sunken); color: var(--dash-ink-secondary); }
.pub-alert svg { margin-top: 1px; }
.pub-alert strong { color: var(--dash-ink); font-weight: var(--dash-weight-semi); display: block; margin-bottom: 1px; }
.pub-alert[data-tone="info"] { background: var(--dash-accent-wash); border-color: var(--dash-accent-line); }
.pub-alert[data-tone="info"] svg { color: var(--dash-accent); }
.pub-alert[data-tone="warn"] { background: rgba(250, 178, 25, 0.1); border-color: rgba(250, 178, 25, 0.35); }
.pub-alert[data-tone="warn"] svg { color: #b97f00; }
.pub-alert[data-tone="danger"] { background: rgba(208, 59, 59, 0.07); border-color: rgba(208, 59, 59, 0.3); }
.pub-alert[data-tone="danger"] svg { color: var(--dash-critical); }
.pub-alert[data-tone="success"] { background: rgba(22, 117, 27, 0.07); border-color: rgba(22, 117, 27, 0.25); }
.pub-alert[data-tone="success"] svg { color: var(--dash-good); }

.pub-quote { border-left: 3px solid var(--dash-accent); padding: 4px 0 4px 14px; color: var(--dash-ink); font-size: var(--dash-text-md); line-height: 1.6; white-space: pre-wrap; }
.pub-quote__by { display: block; margin-top: 6px; font-size: var(--dash-text-xs); color: var(--dash-muted); }

.pub-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--dash-radius-pill); font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium); background: var(--dash-wash); color: var(--dash-ink-secondary); box-shadow: inset 0 0 0 1px var(--dash-border); white-space: nowrap; }
.pub-pill[data-tone="accent"] { background: var(--dash-accent-wash); color: var(--dash-accent); box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.pub-pill[data-tone="good"] { background: rgba(22, 117, 27, 0.08); color: var(--dash-good); box-shadow: inset 0 0 0 1px rgba(22, 117, 27, 0.22); }
.pub-pill[data-tone="warn"] { background: rgba(250, 178, 25, 0.12); color: #9a6a00; box-shadow: inset 0 0 0 1px rgba(250, 178, 25, 0.35); }
.pub-pill[data-tone="danger"] { background: rgba(208, 59, 59, 0.08); color: var(--dash-critical); box-shadow: inset 0 0 0 1px rgba(208, 59, 59, 0.25); }

/* ── booking: the two panes ────────────────────────────────────────────── */
.pub-book { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; overflow: hidden; }
.pub-book__about { padding: 32px; border-right: 1px solid var(--dash-border); display: flex; flex-direction: column; gap: 20px; background: var(--dash-surface); }
.pub-book__work { padding: 32px; min-width: 0; }
.pub-book__desc { white-space: pre-wrap; }

.pub-steps { list-style: none; padding: 0; margin: 0 0 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--dash-text-xs); color: var(--dash-muted); }
.pub-steps__one { display: inline-flex; align-items: center; gap: 8px; }
.pub-steps__num { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: var(--dash-weight-semi); background: var(--dash-wash); color: var(--dash-muted); box-shadow: inset 0 0 0 1px var(--dash-border); }
.pub-steps__one[data-state="now"] { color: var(--dash-ink); font-weight: var(--dash-weight-medium); }
.pub-steps__one[data-state="now"] .pub-steps__num { background: var(--dash-accent); color: var(--dash-accent-ink); box-shadow: none; }
.pub-steps__one[data-state="done"] .pub-steps__num { background: var(--dash-accent-wash); color: var(--dash-accent); box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.pub-steps__sep { width: 18px; height: 1px; background: var(--dash-border-strong); }

.pub-picker { display: grid; grid-template-columns: minmax(0, 1fr) 236px; gap: 28px; align-items: start; }

/* ── the month ─────────────────────────────────────────────────────────── */
.pub-cal__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.pub-cal__title { font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); letter-spacing: -0.01em; }
.pub-cal__nav { display: inline-flex; gap: 4px; }
.pub-icon-btn {
  width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--dash-border); background: var(--dash-surface); color: var(--dash-ink-secondary);
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease);
}
.pub-icon-btn:hover:not(:disabled) { background: var(--dash-wash); color: var(--dash-ink); }
.pub-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pub-icon-btn:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.pub-cal__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.pub-cal__dow { text-align: center; font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dash-muted); padding: 2px 0 8px; }
.pub-cal__day {
  position: relative; aspect-ratio: 1 / 1; max-height: 52px; width: 100%; border: 0; border-radius: 12px;
  font: inherit; font-size: var(--dash-text-md); font-variant-numeric: tabular-nums;
  background: transparent; color: var(--dash-muted); opacity: 0.55; cursor: default;
}
.pub-cal__day[data-outside="true"] { visibility: hidden; }
.pub-cal__day[data-open="true"] {
  opacity: 1; cursor: pointer; color: var(--dash-accent); font-weight: var(--dash-weight-semi);
  background: var(--dash-accent-wash);
  transition: background var(--dash-dur-fast) var(--dash-ease), color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease);
}
.pub-cal__day[data-open="true"]:hover { box-shadow: inset 0 0 0 1.5px var(--dash-accent); }
.pub-cal__day[aria-pressed="true"] { background: var(--dash-accent); color: var(--dash-accent-ink); box-shadow: 0 4px 12px -4px var(--dash-ring); }
.pub-cal__day[data-today="true"]::after { content: ""; position: absolute; left: 50%; bottom: 7px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: currentColor; }
.pub-cal__day:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.pub-cal__loading { position: relative; }
.pub-cal__loading::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, var(--dash-wash), transparent); background-size: 200% 100%; }
@media (prefers-reduced-motion: no-preference) { .pub-cal__loading::after { animation: pub-shimmer 1.2s linear infinite; } }
@keyframes pub-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.pub-zone { margin-top: 18px; display: flex; flex-direction: column; gap: 6px; }
.pub-zone__label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--dash-text-xs); font-weight: var(--dash-weight-medium); color: var(--dash-ink-secondary); }

/* ── times in a day ────────────────────────────────────────────────────── */
.pub-times { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pub-times__day { font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); letter-spacing: -0.01em; }
.pub-times__list {
  display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; padding: 2px 4px 20px 2px; margin: -2px -4px -2px -2px;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
}
.pub-time {
  font: inherit; display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
  padding: 11px 14px; border-radius: 10px; cursor: pointer; text-align: left;
  border: 1px solid var(--dash-accent-line); background: var(--dash-surface); color: var(--dash-accent);
  font-size: var(--dash-text-md); font-weight: var(--dash-weight-semi); font-variant-numeric: tabular-nums;
  transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease), background var(--dash-dur-fast) var(--dash-ease);
}
.pub-time:hover { border-color: var(--dash-accent); box-shadow: inset 0 0 0 1px var(--dash-accent); }
.pub-time:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.pub-time[aria-pressed="true"] { background: var(--dash-accent); color: var(--dash-accent-ink); border-color: var(--dash-accent); }
.pub-time__tag { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); letter-spacing: 0.06em; text-transform: uppercase; font-weight: var(--dash-weight-medium); padding: 2px 6px; border-radius: 6px; background: var(--dash-accent-wash); }
.pub-time[aria-pressed="true"] .pub-time__tag { background: rgba(255,255,255,0.18); }
.pub-times__empty { padding: 28px 16px; text-align: center; border: 1px dashed var(--dash-border-strong); border-radius: 12px; color: var(--dash-muted); font-size: var(--dash-text-sm); line-height: 1.55; }

/* ── the review ────────────────────────────────────────────────────────── */
.pub-chosen { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 14px; background: var(--dash-accent-wash); box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.pub-chosen__icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--dash-accent); color: var(--dash-accent-ink); flex: none; }
.pub-chosen__what { font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.pub-chosen__when { color: var(--dash-ink-secondary); font-size: var(--dash-text-sm); margin-top: 2px; }

/* ── status ────────────────────────────────────────────────────────────── */
.pub-status { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 8px 0 4px; }
.pub-status__icon { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--dash-wash); color: var(--dash-muted); box-shadow: inset 0 0 0 1px var(--dash-border); }
.pub-status__icon[data-tone="good"] { background: rgba(22, 117, 27, 0.1); color: var(--dash-good); box-shadow: inset 0 0 0 1px rgba(22, 117, 27, 0.2); }
.pub-status__icon[data-tone="warn"] { background: rgba(250, 178, 25, 0.14); color: #a87300; box-shadow: inset 0 0 0 1px rgba(250, 178, 25, 0.35); }
.pub-status__icon[data-tone="accent"] { background: var(--dash-accent-wash); color: var(--dash-accent); box-shadow: inset 0 0 0 1px var(--dash-accent-line); }
.pub-status__icon[data-tone="danger"] { background: rgba(208, 59, 59, 0.08); color: var(--dash-critical); box-shadow: inset 0 0 0 1px rgba(208, 59, 59, 0.22); }
.pub-status .pub-lead { max-width: 460px; }

.pub-offer { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; border: 1px solid var(--dash-border); border-radius: 12px; background: var(--dash-surface); }
.pub-offer + .pub-offer { margin-top: 8px; }
.pub-offer__when { font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.pub-offer__held { font-size: var(--dash-text-xs); color: var(--dash-muted); margin-top: 2px; }

.pub-confirm { padding: 16px; border-radius: 12px; border: 1px solid rgba(208, 59, 59, 0.28); background: rgba(208, 59, 59, 0.05); display: flex; flex-direction: column; gap: 12px; }

.pub-types { display: grid; gap: 10px; }
.pub-type { font: inherit; text-align: left; width: 100%; padding: 16px 18px; border: 1px solid var(--dash-border); border-radius: 14px; background: var(--dash-surface); cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; transition: border-color var(--dash-dur-fast) var(--dash-ease), box-shadow var(--dash-dur-fast) var(--dash-ease); }
.pub-type:hover { border-color: var(--dash-accent); box-shadow: var(--dash-shadow-hover); }
.pub-type__name { font-weight: var(--dash-weight-semi); color: var(--dash-ink); }
.pub-type__meta { grid-column: 1; font-size: var(--dash-text-sm); color: var(--dash-muted); }
.pub-type svg { grid-row: 1 / span 2; grid-column: 2; color: var(--dash-muted); }

/* ── loading and failure ───────────────────────────────────────────────── */
.pub-skeleton { border-radius: 8px; background: linear-gradient(90deg, var(--dash-wash), var(--dash-track), var(--dash-wash)); background-size: 200% 100%; }
@media (prefers-reduced-motion: no-preference) { .pub-skeleton { animation: pub-shimmer 1.4s ease-in-out infinite; } }
.pub-center { display: grid; place-items: center; min-height: 52vh; }
.pub-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--dash-border-strong); border-top-color: var(--dash-accent); }
@media (prefers-reduced-motion: no-preference) { .pub-spinner { animation: dash-spin 700ms linear infinite; } }

/* ── approval ──────────────────────────────────────────────────────────── */
.pub-approve { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 20px; align-items: start; }
.pub-approve__side { position: sticky; top: 20px; }
.pub-as { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; background: var(--dash-surface); border: 1px solid var(--dash-border); font-size: var(--dash-text-sm); color: var(--dash-ink-secondary); margin-bottom: 16px; }
.pub-as__avatar { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--dash-accent-wash); color: var(--dash-accent); font-weight: var(--dash-weight-semi); font-size: 12px; flex: none; }
.pub-as strong { color: var(--dash-ink); font-weight: var(--dash-weight-semi); }
.pub-person { display: flex; align-items: center; gap: 14px; }
.pub-person__avatar { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; flex: none; background: linear-gradient(180deg, var(--dash-accent-strong), var(--dash-accent)); color: var(--dash-accent-ink); font-weight: var(--dash-weight-semi); font-size: 17px; }
.pub-person__name { font-size: var(--dash-text-lg); font-weight: var(--dash-weight-semi); letter-spacing: -0.01em; }
.pub-person__reach { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 3px; font-size: var(--dash-text-sm); color: var(--dash-muted); }
.pub-person__reach span { display: inline-flex; align-items: center; gap: 5px; }
.pub-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.pub-dayline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pub-dayline__item { display: grid; grid-template-columns: 148px 1fr auto; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dash-border); background: var(--dash-surface-sunken); font-size: var(--dash-text-sm); }
.pub-dayline__time { font-family: var(--dash-font-mono); font-size: var(--dash-text-xs); color: var(--dash-ink-secondary); font-variant-numeric: tabular-nums; }
.pub-dayline__item[data-current="true"] { background: var(--dash-accent-wash); border-color: var(--dash-accent-line); }
.pub-dayline__item[data-current="true"] .pub-dayline__label { color: var(--dash-accent); font-weight: var(--dash-weight-semi); }

.pub-tabs { display: grid; grid-template-columns: repeat(var(--pub-tabs, 3), 1fr); gap: 4px; padding: 4px; border-radius: 12px; background: var(--dash-wash); box-shadow: inset 0 0 0 1px var(--dash-border); }
.pub-tab { font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); padding: 8px 10px; border: 0; border-radius: 9px; background: transparent; color: var(--dash-ink-secondary); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.pub-tab:hover { color: var(--dash-ink); }
.pub-tab[aria-selected="true"] { background: var(--dash-surface); color: var(--dash-ink); box-shadow: var(--dash-shadow-sm), inset 0 0 0 1px var(--dash-border); }
.pub-tab:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }

.pub-pick { display: flex; flex-direction: column; gap: 14px; max-height: 340px; overflow-y: auto; padding-right: 4px; }
.pub-pick__day { font-family: var(--dash-font-mono); font-size: var(--dash-text-micro); letter-spacing: var(--dash-tracking-label); text-transform: uppercase; color: var(--dash-muted); margin-bottom: 6px; }
.pub-pick__times { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.pub-chip { font: inherit; font-size: var(--dash-text-sm); font-weight: var(--dash-weight-medium); font-variant-numeric: tabular-nums; padding: 8px 6px; border-radius: 9px; border: 1px solid var(--dash-border-strong); background: var(--dash-surface); color: var(--dash-ink); cursor: pointer; }
.pub-chip:hover:not(:disabled) { border-color: var(--dash-accent); color: var(--dash-accent); }
.pub-chip[aria-pressed="true"] { background: var(--dash-accent); border-color: var(--dash-accent); color: var(--dash-accent-ink); }
.pub-chip:disabled { opacity: 0.4; cursor: not-allowed; }
.pub-chip:focus-visible { outline: 2px solid var(--dash-accent); outline-offset: 1px; }
.pub-picked { display: flex; flex-wrap: wrap; gap: 6px; }

@media (max-width: 920px) {
  .pub-approve { grid-template-columns: 1fr; }
  .pub-approve__side { position: static; }
}
@media (max-width: 860px) {
  .pub-book { grid-template-columns: 1fr; }
  .pub-book__about { border-right: 0; border-bottom: 1px solid var(--dash-border); }
  .pub-picker { grid-template-columns: 1fr; }
  .pub-times__list { max-height: none; }
}
@media (max-width: 560px) {
  .pub-top { padding: 16px 16px 0; }
  .pub-main { padding: 16px 12px 32px; }
  .pub-card__body, .pub-book__about, .pub-book__work { padding: 22px 18px; }
  .pub-title { font-size: var(--dash-text-xl); }
  .pub-grid2, .pub-grid3 { grid-template-columns: 1fr; }
  .pub-details { grid-template-columns: 78px 1fr; }
  .pub-dayline__item { grid-template-columns: 1fr auto; }
  .pub-dayline__time { grid-column: 1 / -1; }
  .pub-secure span { display: none; }
}
`;
