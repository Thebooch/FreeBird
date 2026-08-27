import { isSlotHidden, settingBool, settingString } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

/**
 * The strip of numbers a dashboard opens with.
 *
 * `stat` shows one figure and reads only the last row, so a board wanting five
 * headline numbers needed five widgets, five queries and five tiles to place.
 * This is one widget over one result set: a row becomes a tile.
 */
export const MetricRow = (props: WidgetRenderProps): JSX.Element => {
  const labelColumn = roleColumn(props.roles, "label");
  const valueColumn = roleColumn(props.roles, "value");
  const compareColumn = roleColumn(props.roles, "compare");
  const targetColumn = roleColumn(props.roles, "target");
  const statusColumn = roleColumn(props.roles, "status");
  const captionColumn = roleColumn(props.roles, "caption");

  const look = props.presentation;
  const showDelta = !isSlotHidden(look, "delta");
  const showCaption = !isSlotHidden(look, "caption");
  const showTrack = !isSlotHidden(look, "track");
  const align = settingString(look, "align", "start");
  const dividers = settingBool(look, "dividers", true);

  const formatValue = makeFormatter(props, valueColumn);
  const formatCaption = makeFormatter(props, captionColumn);

  if (!labelColumn || !valueColumn) {
    return <Message>This widget needs a label field and a value field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing to show for this time range.</Message>;

  return (
    <div
      className="dash-metrics"
      data-align={align}
      data-dividers={dividers ? "on" : "off"}
      data-density={look?.density ?? "cozy"}
    >
      {props.rows.map((row, index) => {
        const value = row[valueColumn];
        const compare = compareColumn ? row[compareColumn] : undefined;
        const target = targetColumn ? row[targetColumn] : undefined;
        const delta = deltaOf(value, compare);
        const progress = progressOf(value, target);

        return (
          <div className="dash-metric" key={index}>
            <div className="dash-metric__label">
              <span className="dash-metric__name" title={String(row[labelColumn] ?? "")}>
                {String(row[labelColumn] ?? "")}
              </span>
              {statusColumn && row[statusColumn] != null && (
                <StatusPill
                  tone={statusTone(row[statusColumn])}
                  label={String(row[statusColumn])}
                />
              )}
            </div>

            <div className="dash-metric__value">{formatValue(value)}</div>

            {showDelta && delta && (
              <div className={`dash-metric__delta dash-metric__delta--${delta.direction}`}>
                {/*
                 * Arrow and sign both, never colour alone. Red-green is the
                 * one pairing a large minority of readers cannot separate, and
                 * "down" is the whole content of this line.
                 */}
                <span aria-hidden="true">
                  {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "—"}
                </span>
                {delta.text}
              </div>
            )}

            {showTrack && progress !== null && (
              <div
                className="dash-metric__track"
                role="img"
                aria-label={`${Math.round(progress * 100)}% of target`}
              >
                <div
                  className="dash-metric__fill"
                  // Clamped so an over-target value fills the bar rather than
                  // overflowing the tile.
                  style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                />
              </div>
            )}

            {showCaption && captionColumn && row[captionColumn] != null && (
              <div className="dash-metric__caption">{formatCaption(row[captionColumn])}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

interface Delta {
  readonly direction: "up" | "down" | "flat";
  readonly text: string;
}

/**
 * The change against the comparison value.
 *
 * A percentage needs a non-zero base: going from 0 to 40 is not "infinity
 * percent", it is a number appearing where there was none, so the absolute
 * change is shown instead of a symbol nobody can act on.
 */
const deltaOf = (value: unknown, compare: unknown): Delta | null => {
  if (typeof value !== "number" || typeof compare !== "number") return null;
  if (!Number.isFinite(value) || !Number.isFinite(compare)) return null;

  const change = value - compare;
  if (change === 0) return { direction: "flat", text: "no change" };

  const direction = change > 0 ? "up" : "down";
  if (compare === 0) {
    return { direction, text: `${change > 0 ? "+" : ""}${change.toLocaleString()}` };
  }

  const percent = (change / Math.abs(compare)) * 100;
  return {
    direction,
    text: `${percent > 0 ? "+" : ""}${percent.toFixed(percent >= 10 || percent <= -10 ? 0 : 1)}%`,
  };
};

const progressOf = (value: unknown, target: unknown): number | null => {
  if (typeof value !== "number" || typeof target !== "number") return null;
  if (!Number.isFinite(value) || !Number.isFinite(target) || target === 0) return null;
  return value / target;
};
