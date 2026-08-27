import { useMemo, useState } from "react";
import { seriesVar } from "../palette.js";
import { Tooltip, useMeasure } from "../primitives.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import { barPath, bandScale, linearScale, niceTicks } from "../scales.js";
import type { WidgetRenderProps } from "../types.js";

const SURFACE_GAP = 2;

/**
 * Columns, one per bucket, in the single sequential hue. A distribution is one
 * measure — giving each bucket its own categorical colour would imply an
 * identity the data does not have.
 */
export const Distribution = (props: WidgetRenderProps): JSX.Element => {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const bucketColumn = roleColumn(props.roles, "bucket");
  const countColumn = roleColumn(props.roles, "count");

  const formatBucket = makeFormatter(props, bucketColumn);
  const formatCount = makeFormatter(props, countColumn);
  const formatAxis = makeFormatter(props, countColumn, { compact: true });

  const bars = useMemo(() => {
    if (!bucketColumn || !countColumn) return [];
    return props.rows.map((row) => ({
      raw: row[bucketColumn],
      label: formatBucket(row[bucketColumn]),
      value: typeof row[countColumn] === "number" ? (row[countColumn] as number) : 0,
    }));
    // formatBucket is derived from props and stable enough for this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.rows, bucketColumn, countColumn]);

  if (!bucketColumn || !countColumn) return <Message>This widget has no bucket and count binding.</Message>;
  if (bars.length === 0) return <Message>No distribution to show in this range.</Message>;

  const width = size.width || 480;
  const height = size.height || 220;
  const margin = { top: 12, right: 12, bottom: 22, left: 44 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);

  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const y = linearScale([0, max], [margin.top + plotHeight, margin.top]);
  const band = bandScale(bars.length, [margin.left, margin.left + plotWidth], {
    maxThickness: 32,
    padding: 0,
  });
  const thickness = Math.max(1, band.step - SURFACE_GAP);
  const ticks = niceTicks(0, max, Math.max(2, Math.floor(plotHeight / 44)));
  // Only label as many buckets as will fit without overlapping.
  const labelEvery = Math.max(1, Math.ceil((bars.length * 46) / plotWidth));

  return (
    <div className="dash-chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`${props.title}: ${bars.length} buckets`}>
        {ticks.map((tick) => (
          <g key={tick}>
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

        {bars.map((bar, index) => {
          const barHeight = Math.max(0, margin.top + plotHeight - y(bar.value));
          const left = band.center(index) - thickness / 2;
          return (
            <g key={`${bar.label}-${index}`} onPointerEnter={() => setHover(index)} onPointerLeave={() => setHover(null)}>
              <rect x={left} y={margin.top} width={thickness} height={plotHeight} fill="transparent" />
              <path
                d={barPath(left, y(bar.value), thickness, barHeight, 4, "top")}
                fill={seriesVar(0)}
                opacity={hover === null || hover === index ? 1 : 0.55}
              />
              {index % labelEvery === 0 && (
                <text
                  className="dash-tick"
                  x={band.center(index)}
                  y={margin.top + plotHeight + 14}
                  textAnchor="middle"
                >
                  {bar.label.length > 8 ? `${bar.label.slice(0, 7)}…` : bar.label}
                </text>
              )}
            </g>
          );
        })}

        <line
          className="dash-axis-line"
          x1={margin.left}
          x2={margin.left + plotWidth}
          y1={margin.top + plotHeight}
          y2={margin.top + plotHeight}
        />
      </svg>

      {hover !== null && bars[hover] && (
        <Tooltip
          width={width}
          x={band.center(hover)}
          y={y(bars[hover]!.value) - 6}
          head={bars[hover]!.label}
          rows={[{ key: "count", label: countColumn, value: formatCount(bars[hover]!.value), slot: 0 }]}
        />
      )}
    </div>
  );
};
