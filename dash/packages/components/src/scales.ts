/** Pure scale and tick maths. No React, no DOM — unit-testable on its own. */

export interface LinearScale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  invert(pixel: number): number;
}

export const linearScale = (
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale => {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number): number =>
    span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0)) as {
    (value: number): number;
    domain?: unknown;
    range?: unknown;
    invert?: unknown;
  };
  scale.domain = domain;
  scale.range = range;
  scale.invert = (pixel: number): number =>
    r1 === r0 ? d0 : d0 + ((pixel - r0) / (r1 - r0)) * span;
  return scale as LinearScale;
};

/**
 * Round a domain out to clean numbers. Axis ticks are what carry every value
 * you deliberately did not label, so they have to read as 0 / 1,000 / 2,000
 * rather than 0 / 1,037 / 2,074.
 */
export const niceTicks = (min: number, max: number, target = 5): number[] => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  // Snap to the nearest 1/2/5/10 rather than the next one up: rounding 2.07
  // to 5 would halve the tick count and leave the axis sparse.
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) {
    // Re-round to kill the float drift that accumulates over a loop.
    ticks.push(Number((Math.round(value / step) * step).toPrecision(12)));
  }
  return ticks;
};

/**
 * A y-domain for a *line* chart, which is allowed not to start at zero — over
 * a narrow band, forcing zero flattens the very variation the chart is for.
 * Zero is pulled in only when the data already sits in the bottom half of its
 * own range, where the baseline reads as meaningful.
 *
 * Bar and distribution charts do not use this: they anchor to zero directly,
 * because a truncated bar axis misstates the ratios between the bars.
 */
export const niceDomain = (
  values: readonly number[],
  options: { includeZero?: boolean } = {},
): [number, number] => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [0, 1];

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (options.includeZero !== false) {
    if (min > 0 && min <= max * 0.5) min = 0;
    if (max < 0 && max >= min * 0.5) max = 0;
  }
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.1;
    return [min - pad, max + pad];
  }
  return [min, max];
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const TIME_STEPS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  180 * DAY,
  365 * DAY,
];

/** Tick stamps on clean boundaries, in UTC. */
export const timeTicks = (min: number, max: number, target = 5): number[] => {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const rough = (max - min) / Math.max(1, target);
  const step = TIME_STEPS.find((candidate) => candidate >= rough) ?? TIME_STEPS[TIME_STEPS.length - 1]!;

  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max; value += step) ticks.push(value);
  return ticks.length > 0 ? ticks : [min, max];
};

/** Tick label detail follows the span, so a day range does not read as dates. */
export const timeTickFormatter = (
  span: number,
  locale = "en-US",
  timeZone = "UTC",
): ((stamp: number) => string) => {
  const options: Intl.DateTimeFormatOptions =
    span <= 2 * DAY
      ? { hour: "numeric", minute: "2-digit", timeZone }
      : span <= 365 * DAY
        ? { month: "short", day: "numeric", timeZone }
        : { month: "short", year: "numeric", timeZone };
  const formatter = new Intl.DateTimeFormat(locale, options);
  return (stamp: number) => formatter.format(new Date(stamp));
};

/** Evenly spaced band centres, used for categorical axes. */
export interface BandScale {
  readonly step: number;
  readonly bandWidth: number;
  center(index: number): number;
  start(index: number): number;
}

export const bandScale = (
  count: number,
  range: readonly [number, number],
  options: { maxThickness?: number; padding?: number } = {},
): BandScale => {
  const [r0, r1] = range;
  const size = r1 - r0;
  const step = count > 0 ? size / count : size;
  const padding = options.padding ?? 0.2;
  // Marks are capped rather than filling their slot — the band's leftover is
  // air, which is what keeps a dense chart from reading as a solid block.
  const bandWidth = Math.max(1, Math.min(step * (1 - padding), options.maxThickness ?? 24));
  return {
    step,
    bandWidth,
    center: (index: number) => r0 + step * (index + 0.5),
    start: (index: number) => r0 + step * (index + 0.5) - bandWidth / 2,
  };
};

/**
 * A rounded-rect path with the data end rounded and the baseline end square,
 * per the mark spec. `side` names the end the value grows toward.
 */
export const barPath = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  side: "top" | "right",
): string => {
  const r = Math.max(0, Math.min(radius, side === "top" ? height : width, side === "top" ? width / 2 : height / 2));
  if (r === 0) return `M${x},${y}h${width}v${height}h${-width}Z`;

  if (side === "top") {
    return [
      `M${x},${y + height}`,
      `V${y + r}`,
      `A${r},${r} 0 0 1 ${x + r},${y}`,
      `H${x + width - r}`,
      `A${r},${r} 0 0 1 ${x + width},${y + r}`,
      `V${y + height}`,
      "Z",
    ].join("");
  }
  return [
    `M${x},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height - r}`,
    `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
    `H${x}`,
    "Z",
  ].join("");
};

export const linePath = (points: ReadonlyArray<readonly [number, number]>): string =>
  points.length === 0
    ? ""
    : points
        .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
        .join("");
