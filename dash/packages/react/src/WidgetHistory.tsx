import { useEffect, useState } from "react";
import type { HistoryPoint, HistorySource } from "./context.jsx";

/**
 * What a number was, day by day, under the number: a small line and the day
 * its history starts. History the API does not keep is kept by the host
 * while the board is looked after, so it starts when it started — never
 * earlier, and it says which day (plan, track D).
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
  const width = 120;
  const height = 24;
  const line = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point.value - low) / span) * (height - 2) - 1;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = points[0]!;
  return (
    <div className="dash-widget__history" data-testid={`history-${widget}`}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${points.length} days of history, from ${first.day}`}
      >
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} />
      </svg>
      <span className="dash-widget__history-since">History starts {first.day}</span>
    </div>
  );
};
