import { seriesVar } from "../palette.js";
import { useMeasure } from "../primitives.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

const polar = (cx: number, cy: number, r: number, angle: number): [number, number] => [
  cx + r * Math.cos(angle),
  cy + r * Math.sin(angle),
];

/** A semicircular sweep from due west round to due east. */
const arc = (cx: number, cy: number, r: number, from: number, to: number): string => {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
};

export const Gauge = (props: WidgetRenderProps): JSX.Element => {
  const [ref, size] = useMeasure<HTMLDivElement>();

  const valueColumn = roleColumn(props.roles, "value");
  const maxColumn = roleColumn(props.roles, "max");
  const targetColumn = roleColumn(props.roles, "target");

  const formatValue = makeFormatter(props, valueColumn);

  if (!valueColumn) return <Message>This widget has no value binding.</Message>;

  // A gauge shows one number; with several rows the latest is the current state.
  const row = props.rows[props.rows.length - 1];
  const value = typeof row?.[valueColumn] === "number" ? (row[valueColumn] as number) : null;
  if (value === null) return <Message>No current value to show.</Message>;

  const target = maxColumn && typeof row?.[maxColumn] === "number" ? (row[maxColumn] as number) : null;
  const marker =
    targetColumn && typeof row?.[targetColumn] === "number" ? (row[targetColumn] as number) : null;
  // With no declared max, leave headroom above whatever the value reached.
  const headroom = Math.max(value, marker ?? 0) * 1.25;
  const ceiling = target ?? (headroom > 0 ? headroom : 1);
  const ratio = ceiling === 0 ? 0 : Math.max(0, Math.min(1, value / ceiling));

  const width = size.width || 200;
  const height = size.height || 160;
  const radius = Math.max(20, Math.min(width / 2 - 16, height - 44));
  const cx = width / 2;
  const cy = Math.min(height - 26, radius + 16);
  const stroke = Math.max(8, Math.min(16, radius * 0.2));

  const START = Math.PI;
  const END = 2 * Math.PI;

  return (
    <div className="dash-gauge" ref={ref} style={{ width: "100%" }}>
      <svg width={width} height={height} role="img" aria-label={`${props.title}: ${formatValue(value)}`}>
        {/* The unfilled track is a lighter step of the fill's own ramp. */}
        <path className="dash-gauge__track" strokeWidth={stroke} d={arc(cx, cy, radius, START, END)} />
        {ratio > 0 && (
          <path
            className="dash-gauge__fill"
            strokeWidth={stroke}
            stroke={seriesVar(0)}
            d={arc(cx, cy, radius, START, START + (END - START) * ratio)}
          />
        )}

        {/*
          The fill stays the accent hue rather than shifting to warning/danger:
          nothing in the spec declares whether higher is better, and colouring
          by an assumed polarity would tell the reader something untrue.
          The target rides the track as a tick instead.
        */}
        {marker !== null && ceiling > 0 && (
          <line
            stroke="var(--dash-ink)"
            strokeWidth={2}
            {...(() => {
              const angle = START + (END - START) * Math.max(0, Math.min(1, marker / ceiling));
              const [x1, y1] = polar(cx, cy, radius - stroke / 2 - 2, angle);
              const [x2, y2] = polar(cx, cy, radius + stroke / 2 + 2, angle);
              return { x1, y1, x2, y2 };
            })()}
          />
        )}

        <text className="dash-gauge__value" x={cx} y={cy - 6} textAnchor="middle">
          {formatValue(value)}
        </text>
        {target !== null && (
          <text className="dash-gauge__caption" x={cx} y={cy + 14} textAnchor="middle">
            of {formatValue(target)}
          </text>
        )}
      </svg>
    </div>
  );
};
