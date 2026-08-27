import { seriesVar } from "../palette.js";
import { linePath, linearScale, niceDomain } from "../scales.js";

/**
 * The 12-point trend that rides a stat tile. No axes, no labels, no hover —
 * it carries shape, and the tile's value carries the number.
 */
export const Sparkline = ({
  values,
  width = 160,
  height = 34,
  slot = 0,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  slot?: number;
}): JSX.Element | null => {
  if (values.length < 2) return null;

  const domain = niceDomain(values, { includeZero: false });
  const x = linearScale([0, values.length - 1], [1, width - 1]);
  const y = linearScale(domain, [height - 3, 3]);
  const points = values.map((value, index) => [x(index), y(value)] as const);
  const last = points[points.length - 1]!;

  return (
    <svg
      className="dash-stat__spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        className="dash-area"
        fill={seriesVar(slot)}
        d={`${linePath(points)}L${last[0]},${height}L${points[0]![0]},${height}Z`}
      />
      <path className="dash-line" stroke={seriesVar(slot)} d={linePath(points)} />
      <circle className="dash-dot" cx={last[0]} cy={last[1]} r={3} fill={seriesVar(slot)} />
    </svg>
  );
};
