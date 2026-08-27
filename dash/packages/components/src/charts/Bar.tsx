import { useMemo, useState } from "react";
import { seriesVar } from "../palette.js";
import { Legend, Tooltip, useMeasure } from "../primitives.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import { barPath, bandScale, linearScale, niceTicks } from "../scales.js";
import { buildCategories } from "../series.js";
import type { WidgetRenderProps } from "../types.js";

/** The 2px of surface that separates touching marks. */
const SURFACE_GAP = 2;
const MAX_THICKNESS = 24;

export const Bar = (props: WidgetRenderProps): JSX.Element => {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const categoryColumn = roleColumn(props.roles, "category");
  const valueColumn = roleColumn(props.roles, "value");
  const seriesColumn = roleColumn(props.roles, "series");

  const { data, keys } = useMemo(
    () =>
      categoryColumn && valueColumn
        ? buildCategories({
            rows: props.rows,
            category: categoryColumn,
            value: valueColumn,
            series: seriesColumn,
            seriesOrder: props.seriesOrder,
          })
        : { data: [], keys: [] },
    [props.rows, props.seriesOrder, categoryColumn, valueColumn, seriesColumn],
  );

  const formatValue = makeFormatter(props, valueColumn);
  const formatAxis = makeFormatter(props, valueColumn, { compact: true });

  if (!categoryColumn || !valueColumn) return <Message>This widget has no category and value binding.</Message>;
  if (data.length === 0) return <Message>Nothing to compare in this range.</Message>;

  const width = size.width || 480;
  const height = size.height || 220;

  const longest = data.reduce((max, datum) => Math.max(max, datum.label.length), 0);
  const labelWidth = Math.min(Math.max(60, longest * 6.4), width * 0.38);
  const margin = { top: 8, right: 52, bottom: 20, left: labelWidth + 8 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);

  const max = Math.max(0, ...data.map((datum) => datum.value));
  const x = linearScale([0, max === 0 ? 1 : max], [margin.left, margin.left + plotWidth]);
  const band = bandScale(data.length, [margin.top, margin.top + plotHeight], {
    maxThickness: MAX_THICKNESS,
  });
  const ticks = niceTicks(0, max === 0 ? 1 : max, Math.max(2, Math.floor(plotWidth / 90)));
  const stacked = Boolean(seriesColumn);

  return (
    <>
      <div className="dash-chart" ref={ref}>
        <svg width={width} height={height} role="img" aria-label={`${props.title}: ${data.length} categories`}>
          {ticks.map((tick) => (
            <line
              className="dash-grid-line"
              key={`g${tick}`}
              x1={x(tick)}
              x2={x(tick)}
              y1={margin.top}
              y2={margin.top + plotHeight}
            />
          ))}

          {data.map((datum, index) => {
            const top = band.start(index);
            let cursor = margin.left;
            const showValue = band.bandWidth >= 12;

            return (
              <g
                key={datum.label}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover(null)}
              >
                <rect
                  x={0}
                  y={top - (band.step - band.bandWidth) / 2}
                  width={width}
                  height={band.step}
                  fill="transparent"
                />
                <text
                  className="dash-tick"
                  x={margin.left - 10}
                  y={top + band.bandWidth / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {datum.label.length > labelWidth / 6.2
                    ? `${datum.label.slice(0, Math.max(1, Math.floor(labelWidth / 6.2) - 1))}…`
                    : datum.label}
                </text>

                {datum.segments.map((segment, segmentIndex) => {
                  const segmentWidth = Math.max(0, x(segment.value) - margin.left);
                  const isLast = segmentIndex === datum.segments.length - 1;
                  // A 2px surface gap separates touching segments; never a stroke.
                  const drawn = Math.max(
                    1,
                    segmentWidth - (stacked && !isLast ? SURFACE_GAP : 0),
                  );
                  const left = cursor;
                  cursor += segmentWidth;
                  return (
                    <path
                      key={segment.key}
                      className="dash-bar"
                      d={barPath(left, top, drawn, band.bandWidth, 4, isLast ? "right" : "top")}
                      fill={segment.isOther ? "var(--dash-muted)" : seriesVar(segment.slot)}
                    />
                  );
                })}

                {showValue && (
                  <text
                    className="dash-label"
                    x={x(datum.value) + 6}
                    y={top + band.bandWidth / 2}
                    dominantBaseline="middle"
                  >
                    {formatValue(datum.value)}
                  </text>
                )}
              </g>
            );
          })}

          <line
            className="dash-axis-line"
            x1={margin.left}
            x2={margin.left}
            y1={margin.top}
            y2={margin.top + plotHeight}
          />

          {ticks.map((tick) => (
            <text
              className="dash-tick"
              key={`t${tick}`}
              x={x(tick)}
              y={margin.top + plotHeight + 14}
              textAnchor="middle"
            >
              {formatAxis(tick)}
            </text>
          ))}
        </svg>

        {hover !== null && data[hover] && (
          <Tooltip
            width={width}
            x={Math.min(width - 20, x(data[hover]!.value) + 20)}
            y={band.start(hover) + band.bandWidth}
            head={data[hover]!.label}
            rows={
              stacked
                ? data[hover]!.segments.map((segment) => ({
                    key: segment.key,
                    label: segment.label,
                    value: formatValue(segment.value),
                    slot: segment.slot,
                    isOther: segment.isOther,
                  }))
                : [
                    {
                      key: "value",
                      label: valueColumn,
                      value: formatValue(data[hover]!.value),
                      slot: 0,
                    },
                  ]
            }
          />
        )}
      </div>
      {stacked && <Legend entries={keys} />}
    </>
  );
};
