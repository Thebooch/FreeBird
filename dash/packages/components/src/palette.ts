import type { StatusTone } from "@freebirdai/dash-spec";
/**
 * The validated palette.
 *
 * Slot ORDER is the colourblind-safety mechanism, not a style choice — these
 * eight hues in this sequence clear every adjacent-pair gate in both modes
 * (worst adjacent CVD ΔE 9.1 light / 8.4 dark; worst normal-vision ΔE 19.6
 * light / 19.3 dark). Never cycle past slot 8 and never generate a hue: a
 * ninth series folds into "Other".
 *
 * Three light-mode slots (aqua, yellow, magenta) sit below 3:1 against the
 * light surface. That is legal under the relief rule and this library pays it
 * two ways: a legend is always rendered for two or more series, and every
 * widget has a table view in its inspector.
 */
export const SERIES_SLOTS = 8;

export const SERIES_LIGHT = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
] as const;

export const SERIES_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

/**
 * Colour follows the entity, never its rank: the slot is chosen from a stable
 * ordering of the series names, so filtering a series out never repaints the
 * survivors.
 */
export const seriesVar = (index: number): string => `var(--dash-series-${(index % SERIES_SLOTS) + 1})`;

/*
 * The vocabulary itself now lives in `@freebirdai/dash-spec`, because deciding what a
 * word means is a judgement about a value rather than about how one is drawn —
 * and the server needs it too, without pulling in React. What stays here is
 * how a tone is rendered.
 */
export type { StatusTone } from "@freebirdai/dash-spec";
export { statusTone } from "@freebirdai/dash-spec";

/** Reserved. A status colour is never reused as "series 4". */
export const STATUS_TONES: Readonly<Record<StatusTone, string>> = {
  good: "var(--dash-good)",
  warning: "var(--dash-warning)",
  serious: "var(--dash-serious)",
  critical: "var(--dash-critical)",
  neutral: "var(--dash-muted)",
};

/** Paired with the colour so state never rests on hue alone. */
export const STATUS_ICONS: Readonly<Record<StatusTone, string>> = {
  good: "●",
  warning: "▲",
  serious: "▲",
  critical: "■",
  neutral: "○",
};



