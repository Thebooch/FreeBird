import { useMemo, useState } from "react";
import { seriesVar } from "../palette.js";
import { Legend, PLOT_MARGIN, Tooltip, useMeasure } from "../primitives.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import {
  linePath,
  linearScale,
  niceDomain,
  niceTicks,
  timeTickFormatter,
  timeTicks,
} from "../scales.js";
import { type BuiltSeries, type SeriesPoint, buildSeries } from "../series.js";
import type { WidgetRenderProps } from "../types.js";

/** Split on nulls so a gap in the data reads as a gap, not a straight line across it. */
const segments = (points: readonly SeriesPoint[]): SeriesPoint[][] => {
  const runs: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
};

const lastDefined = (series: BuiltSeries): SeriesPoint | undefined => {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const point = series.points[i]!;
    if (point.y !== null) return point;
  }
  return undefined;
};

export const TimeSeries = (props: WidgetRenderProps): JSX.Element => {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const timeColumn = roleColumn(props.roles, "time");
  const valueColumn = roleColumn(props.roles, "value");
  const seriesColumn = roleColumn(props.roles, "series");

  const built = useMemo(
    () =>
      timeColumn && valueColumn
        ? buildSeries({
            rows: props.rows,
            x: timeColumn,
            y: valueColumn,
            series: seriesColumn,
            seriesOrder: props.seriesOrder,
          })
        : [],
    [props.rows, props.seriesOrder, timeColumn, valueColumn, seriesColumn],
  );

  const formatValue = makeFormatter(props, valueColumn);
  const formatAxis = makeFormatter(props, valueColumn, { compact: true });

  const xs = useMemo(() => {
    const stamps = new Set<number>();
    for (const series of built) for (const point of series.points) stamps.add(point.x);
    return [...stamps].sort((a, b) => a - b);
  }, [built]);

  if (!timeColumn || !valueColumn) return <Message>This widget has no time and value binding.</Message>;
  if (xs.length === 0) return <Message>Nothing to plot in this range.</Message>;

  const width = size.width || 480;
  const height = size.height || 220;
  const margin = { ...PLOT_MARGIN, left: 48 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);

  const values = built.flatMap((series) =>
    series.points.map((point) => point.y).filter((y): y is number => y !== null),
  );
  const yDomain = niceDomain(values);
  const xDomain: [number, number] = [xs[0]!, xs[xs.length - 1]!];

  const x = linearScale(xDomain, [margin.left, margin.left + plotWidth]);
  const y = linearScale(yDomain, [margin.top + plotHeight, margin.top]);

  const yTickValues = niceTicks(yDomain[0], yDomain[1], Math.max(2, Math.floor(plotHeight / 44)));
  const xTickValues = timeTicks(xDomain[0], xDomain[1], Math.max(2, Math.floor(plotWidth / 90)));
  const formatTime = timeTickFormatter(xDomain[1] - xDomain[0], props.locale, props.timeZone ?? "UTC");
  const formatStamp = makeFormatter(props, timeColumn);

  const single = built.length === 1;
  const hoverStamp = hover === null ? null : xs[hover];

  return (
    <>
      <div className="dash-chart" ref={ref}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${props.title}: ${built.length} series over time`}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const stamp = x.invert(event.clientX - bounds.left);
            let nearest = 0;
            for (let i = 1; i < xs.length; i++) {
              if (Math.abs(xs[i]! - stamp) < Math.abs(xs[nearest]! - stamp)) nearest = i;
            }
            setHover(nearest);
          }}
        >
          {yTickValues.map((tick) => (
            <g key={`y${tick}`}>
              <line
                className="dash-grid-line"
                x1={margin.left}
                x2={margin.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="dash-tick" x={margin.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                {formatAxis(tick)}
              </text>
            </g>
          ))}

          <line
            className="dash-axis-line"
            x1={margin.left}
            x2={margin.left + plotWidth}
            y1={margin.top + plotHeight}
            y2={margin.top + plotHeight}
          />

          {xTickValues.map((tick) => (
            <text
              className="dash-tick"
              key={`x${tick}`}
              x={x(tick)}
              y={margin.top + plotHeight + 14}
              textAnchor="middle"
            >
              {formatTime(tick)}
            </text>
          ))}

          {/* A single series gets a 10% wash under it; several would muddy. */}
          {single &&
            segments(built[0]!.points).map((run, index) => (
              <path
                key={`area${index}`}
                className="dash-area"
                fill={seriesVar(built[0]!.slot)}
                d={`${linePath(run.map((point) => [x(point.x), y(point.y!)] as const))}L${x(
                  run[run.length - 1]!.x,
                )},${margin.top + plotHeight}L${x(run[0]!.x)},${margin.top + plotHeight}Z`}
              />
            ))}

          {built.map((series) =>
            segments(series.points).map((run, index) => (
              <path
                key={`${series.key}-${index}`}
                className="dash-line"
                /* Normalised so the draw-in can dash it without measuring. */
                pathLength={1}
                stroke={series.isOther ? "var(--dash-muted)" : seriesVar(series.slot)}
                d={linePath(run.map((point) => [x(point.x), y(point.y!)] as const))}
              />
            )),
          )}

          {hoverStamp !== undefined && hoverStamp !== null && (
            <line
              className="dash-crosshair"
              x1={x(hoverStamp)}
              x2={x(hoverStamp)}
              y1={margin.top}
              y2={margin.top + plotHeight}
            />
          )}

          {built.map((series) => {
            const point = lastDefined(series);
            if (!point) return null;
            return (
              <circle
                key={`dot-${series.key}`}
                className="dash-dot"
                cx={x(point.x)}
                cy={y(point.y!)}
                r={4}
                fill={series.isOther ? "var(--dash-muted)" : seriesVar(series.slot)}
              />
            );
          })}

          {/* Label the endpoint only, and only while labels cannot collide. */}
          {built.length <= 4 &&
            built.map((series) => {
              const point = lastDefined(series);
              if (!point) return null;
              const collides = built.some((other) => {
                if (other.key === series.key) return false;
                const otherPoint = lastDefined(other);
                return otherPoint ? Math.abs(y(otherPoint.y!) - y(point.y!)) < 14 : false;
              });
              if (collides) return null;
              return (
                <text
                  key={`label-${series.key}`}
                  className="dash-label"
                  x={x(point.x) - 8}
                  y={y(point.y!) - 10}
                  textAnchor="end"
                >
                  {formatValue(point.y)}
                </text>
              );
            })}
        </svg>

        {hoverStamp !== undefined && hoverStamp !== null && (
          <Tooltip
            width={width}
            x={x(hoverStamp)}
            y={margin.top + plotHeight - 8}
            head={formatStamp(hoverStamp)}
            rows={built
              .map((series) => {
                const point = series.points.find((candidate) => candidate.x === hoverStamp);
                return {
                  key: series.key,
                  label: seriesColumn ? series.label : (valueColumn ?? "value"),
                  value: formatValue(point?.y ?? null),
                  slot: series.slot,
                  isOther: series.isOther,
                };
              })
              .slice(0, 9)}
          />
        )}
      </div>
      <Legend entries={built} />
    </>
  );
};
