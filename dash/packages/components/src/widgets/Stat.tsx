import { Sparkline } from "../charts/Sparkline.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, numericValues, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

const ARROWS = { up: "↑", down: "↓", flat: "→" } as const;

export const Stat = (props: WidgetRenderProps): JSX.Element => {
  const valueColumn = roleColumn(props.roles, "value");
  const compareColumn = roleColumn(props.roles, "compare");
  const seriesColumn = roleColumn(props.roles, "series");

  const formatValue = makeFormatter(props, valueColumn);

  if (!valueColumn) return <Message>This widget has no value binding.</Message>;

  // The current state is the most recent row.
  const row = props.rows[props.rows.length - 1];
  const value = row?.[valueColumn];
  if (value === null || value === undefined) return <Message>No value in this range.</Message>;

  const compare =
    compareColumn && typeof row?.[compareColumn] === "number" ? (row[compareColumn] as number) : null;
  const current = typeof value === "number" ? value : null;

  const delta =
    compare !== null && current !== null && compare !== 0
      ? ((current - compare) / Math.abs(compare)) * 100
      : null;
  const direction = delta === null ? "flat" : delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";

  const spark = seriesColumn ? numericValues(props.rows, seriesColumn) : [];

  /*
   * A fixed anatomy rather than a centred stack: the number sits directly
   * under the title, so numbers in a row of tiles line up whatever is below
   * them; the delta has a line of its own; the sparkline is pinned to the
   * foot. Centring moved each number by however much its neighbours had.
   */
  const body = (
    <>
      <div
        className={`dash-stat__value${props.hero ? " dash-stat__value--hero" : ""}`}
        title={formatValue(value)}
      >
        {formatValue(value)}
      </div>

      {delta !== null && (
        <div className={`dash-stat__delta dash-stat__delta--${direction}`}>
          {/*
            Arrow plus a signed number plus a named comparison: the direction is
            never carried by colour alone. Up reads as good by default — nothing
            in the spec declares a polarity, so the label names what it is
            compared against and lets the reader judge.
          */}
          <span aria-hidden="true">{ARROWS[direction]}</span>
          <span>
            {delta > 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </span>
          <span className="dash-stat__caption" title={`Compared against "${compareColumn}"`}>
            vs previous period
          </span>
        </div>
      )}

      {spark.length > 1 && (
        <div className="dash-stat__foot">
          <Sparkline values={spark.slice(-12)} />
        </div>
      )}
    </>
  );

  /*
   * The whole tile is the control when the number comes from rows that can be
   * listed — a target the size of the card rather than a link in a corner.
   */
  return props.drill ? (
    <button
      type="button"
      className="dash-stat dash-stat--drill"
      aria-label={props.drill.label}
      title={props.drill.label}
      onClick={props.drill.open}
      data-testid="stat-drill-open"
    >
      {body}
    </button>
  ) : (
    <div className="dash-stat">{body}</div>
  );
};
