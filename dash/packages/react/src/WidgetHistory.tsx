import { useEffect, useState } from "react";
import type { HistoryPoint, HistorySource } from "./context.jsx";

/**
 * What a number was, day by day, under the number: a small line and the day
 * its history starts. History the API does not keep is kept by the host
 * while the board is looked after, so it starts when it started — never
 * earlier, and it says which day.
 *
 * Nothing until there are two days to draw: one point is not a history.
 */
export const WidgetHistory = ({
  source,
  dashboard,
  widget,
  refreshedAt,
}: {
  source: HistorySource;
  dashboard: string;
  widget: string;
  /** Asked again when the number is. */
  refreshedAt: number | null;
}): JSX.Element | null => {
  const [points, setPoints] = useState<readonly HistoryPoint[]>([]);
  useEffect(() => {
    let live = true;
    source(dashboard, widget)
      .then((found) => {
        if (live) setPoints(found);
      })
      .catch(() => {
        /* No history is no history: the number stands on its own. */
      });
    return () => {
      live = false;
    };
  }, [source, dashboard, widget, refreshedAt]);

  if (points.length < 2) return null;
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const width = 96;
  const height = 16;
  const line = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point.value - low) / span) * (height - 2) - 1;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  /*
   * No date on screen, not even on hover. The day history starts is when
   * FreeBird began keeping this tile's value, which is bookkeeping; shown,
   * it read as how far back the records go.
   */
  const meaning = `This number, day by day (${points.length} days)`;
  return (
    <div className="dash-widget__history" data-testid={`history-${widget}`} title={meaning}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={meaning}>
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.25} />
      </svg>
    </div>
  );
};
