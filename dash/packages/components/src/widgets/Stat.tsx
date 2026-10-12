import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkline } from "../charts/Sparkline.jsx";
import { Message } from "../ui/index.js";
import { makeFormatter, numericValues, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

const ARROWS = { up: "↑", down: "↓", flat: "→" } as const;

/** Before paint in a browser, so a long value never flashes clipped; a plain effect on the server. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** How many steps down the size scale the number may go before it is clipped. */
const FIT_STEPS = 3;

/**
 * The number at the tile's one size, stepped down only when it would not fit.
 *
 * Measured rather than guessed from the digit count, so "28" and "8" are the
 * same size and only a value genuinely wider than its tile gets smaller.
 */
const useFit = (text: string): { ref: RefObject<HTMLDivElement>; fit: number } => {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [width, setWidth] = useState(0);
  const hasText = text !== "";

  /*
   * Tried on the element itself, from the full size down, until it fits: one
   * pass per value or width, so a tile that grew goes back to the full size.
   */
  useBeforePaint(() => {
    const element = ref.current;
    if (!element) return;
    let step = 0;
    for (; ; step++) {
      if (step === 0) delete element.dataset["fit"];
      else element.dataset["fit"] = String(step);
      if (step === FIT_STEPS || element.scrollWidth <= element.clientWidth + 1) break;
    }
    setFit(step);
  }, [text, width]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Once there is a number to watch: a tile that first said "No value" has none.
  }, [hasText]);

  return { ref, fit };
};

export const Stat = (props: WidgetRenderProps): JSX.Element => {
  const valueColumn = roleColumn(props.roles, "value");
  const compareColumn = roleColumn(props.roles, "compare");
  const seriesColumn = roleColumn(props.roles, "series");

  const formatValue = makeFormatter(props, valueColumn);
  const row = props.rows[props.rows.length - 1];
  const shown = valueColumn && row ? formatValue(row[valueColumn]) : "";
  const { ref, fit } = useFit(shown);

  if (!valueColumn) return <Message>This widget has no value binding.</Message>;

  // The current state is the most recent row.
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
      {/*
        One size whatever the tile: a "hero" tile used to draw its number
        larger, which put a 28 beside an 8 at two different sizes in one row.
      */}
      <div
        ref={ref}
        className="dash-stat__value"
        {...(fit > 0 ? { "data-fit": String(fit) } : {})}
        title={shown}
      >
        {shown}
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
