import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { seriesVar } from "./palette.js";
import { DASH_STYLES } from "./theme.js";

const STYLE_ID = "dash-styles";

/**
 * Chart plumbing: the stylesheet, the measurer, and the two pieces of chrome
 * that only a plot has. The general-purpose units live in `ui/`.
 *
 * Injects the stylesheet once per document. Shipping CSS as a string rather
 * than a `.css` import keeps the package consumable from any bundler (and
 * from none) without a build step on the host side.
 */
export const DashStyles = (): null => {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = DASH_STYLES;
    document.head.appendChild(style);
  }, []);
  return null;
};

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Measure a container. Charts are drawn to real pixels rather than a fixed
 * viewBox so text never scales with the widget — a 10px tick label stays 10px
 * whether the widget is 3 columns wide or 12.
 */
export const useMeasure = <T extends HTMLElement>(): [
  React.RefObject<T>,
  Size,
] => {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
};

export interface LegendEntry {
  readonly key: string;
  readonly label: string;
  readonly slot: number;
  readonly isOther?: boolean;
}

/**
 * A legend is always present for two or more series — identity must never rest
 * on colour-matching alone. A single series gets none: the widget title
 * already names what is plotted, and a one-swatch box just restates it.
 */
export const Legend = ({ entries }: { entries: readonly LegendEntry[] }): JSX.Element | null => {
  if (entries.length < 2) return null;
  return (
    <div className="dash-legend">
      {entries.map((entry) => (
        <span className="dash-legend__item" key={entry.key}>
          <span
            className="dash-legend__swatch"
            style={{ background: entry.isOther ? "var(--dash-muted)" : seriesVar(entry.slot) }}
          />
          <span className="dash-legend__label">{entry.label}</span>
        </span>
      ))}
    </div>
  );
};

export interface TooltipRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly slot?: number;
  readonly isOther?: boolean;
}

export const Tooltip = ({
  x,
  y,
  head,
  rows,
  width,
}: {
  x: number;
  y: number;
  head: string;
  rows: readonly TooltipRow[];
  width: number;
}): JSX.Element => {
  // Keep the card inside the plot rather than letting it clip at an edge.
  const clampedX = Math.max(70, Math.min(width - 70, x));
  return (
    <div className="dash-tooltip" style={{ left: clampedX, top: Math.max(28, y) }} role="tooltip">
      <div className="dash-tooltip__head">{head}</div>
      {rows.map((row) => (
        <div className="dash-tooltip__row" key={row.key}>
          {row.slot !== undefined && (
            <span
              className="dash-legend__swatch"
              style={{ background: row.isOther ? "var(--dash-muted)" : seriesVar(row.slot) }}
            />
          )}
          <span>{row.label}</span>
          <span className="dash-tooltip__value">{row.value}</span>
        </div>
      ))}
    </div>
  );
};

/** Shared plot margins. Left is widened by the caller when tick labels are long. */
export const PLOT_MARGIN = { top: 10, right: 14, bottom: 20, left: 40 } as const;
