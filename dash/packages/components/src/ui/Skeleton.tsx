/**
 * One skeleton, six shapes.
 *
 * A per-component skeleton file is how a component library ends up with
 * fifteen slightly different grey rectangles. The shape a widget is *about* to
 * show is the only thing that varies, so it is the only thing this takes.
 *
 * The widths are a fixed array rather than `Math.random()`: a skeleton should
 * look organic and render identically every time, or a re-render reshuffles
 * the bars and the loading state visibly twitches.
 */

export type SkeletonShape = "list" | "bars" | "chart" | "sparkline" | "grid" | "funnel";

const LINE_WIDTHS = [78, 62, 85, 55, 71, 66, 90, 58] as const;
const BAR_HEIGHTS = [46, 72, 38, 88, 60, 52, 76, 44] as const;
const FUNNEL_WIDTHS = [96, 78, 61, 44, 30] as const;

export interface SkeletonProps {
  readonly shape?: SkeletonShape;
  /** Rows, bars or tiles, depending on the shape. Clamped to what fits. */
  readonly count?: number;
}

export const Skeleton = ({ shape = "list", count }: SkeletonProps): JSX.Element => (
  <div className="dash-skeleton" data-shape={shape} aria-hidden="true">
    {/*
     * `aria-hidden` plus a live status elsewhere, not `role="progressbar"`:
     * this has no value to report, and a bar that never announces a number is
     * noise in a screen reader rather than information.
     */}
    {renderShape(shape, count)}
  </div>
);

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const renderShape = (shape: SkeletonShape, count?: number): JSX.Element => {
  switch (shape) {
    case "bars":
    case "chart": {
      const bars = clamp(count ?? 8, 3, BAR_HEIGHTS.length);
      return (
        <div className="dash-skeleton__plot">
          {BAR_HEIGHTS.slice(0, bars).map((height, index) => (
            <div
              className="dash-skeleton__col"
              key={index}
              style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }}
            />
          ))}
        </div>
      );
    }

    case "sparkline":
      return <div className="dash-skeleton__spark" />;

    case "grid": {
      const tiles = clamp(count ?? 6, 2, 12);
      return (
        <div className="dash-skeleton__grid">
          {Array.from({ length: tiles }, (_, index) => (
            <div
              className="dash-skeleton__tile"
              key={index}
              style={{ animationDelay: `${index * 60}ms` }}
            />
          ))}
        </div>
      );
    }

    case "funnel":
      return (
        <div className="dash-skeleton__funnel">
          {FUNNEL_WIDTHS.map((width, index) => (
            <div
              className="dash-skeleton__stage"
              key={index}
              style={{ width: `${width}%`, animationDelay: `${index * 70}ms` }}
            />
          ))}
        </div>
      );

    case "list":
    default: {
      const lines = clamp(count ?? 5, 2, LINE_WIDTHS.length);
      return (
        <>
          {LINE_WIDTHS.slice(0, lines).map((width, index) => (
            <div
              className="dash-skeleton__bar"
              key={index}
              style={{ width: `${width}%`, animationDelay: `${index * 70}ms` }}
            />
          ))}
        </>
      );
    }
  }
};

/**
 * The shape a component's loading state should wear.
 *
 * Lives here rather than on the contract because it is a fact about how the
 * component draws, not about what data it needs — and an unknown component
 * gets the list shape, which is the least wrong thing to guess.
 */
export const skeletonShapeFor = (component: string): SkeletonShape => {
  switch (component) {
    case "bar":
    case "distribution":
      return "bars";
    case "timeseries":
      return "chart";
    case "stat":
      return "sparkline";
    case "statusGrid":
    case "cards":
    case "board":
    case "calendar":
      return "grid";
    case "funnel":
      return "funnel";
    case "progress":
    case "metricRow":
      return "bars";
    default:
      return "list";
  }
};
