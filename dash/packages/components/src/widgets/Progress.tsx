import { settingBool } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

/**
 * How far along each thing is.
 *
 * With no `max` bound, the largest row sets the scale and the bars are a
 * comparison rather than a completion — which is stated in the caption, because
 * a bar that looks full when it is merely the biggest is the classic way this
 * chart misleads.
 */
export const Progress = (props: WidgetRenderProps): JSX.Element => {
  const labelColumn = roleColumn(props.roles, "label");
  const valueColumn = roleColumn(props.roles, "value");
  const maxColumn = roleColumn(props.roles, "max");
  const statusColumn = roleColumn(props.roles, "status");

  const look = props.presentation;
  const showValue = settingBool(look, "showValue", true);
  const formatValueAt = makeFormatter(props, valueColumn);

  if (!labelColumn || !valueColumn) {
    return <Message>This widget needs a label field and a value field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing to show for this time range.</Message>;

  const numbers = props.rows
    .map((row) => row[valueColumn])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const largest = numbers.length > 0 ? Math.max(...numbers) : 0;

  return (
    <div className="dash-progress-list" data-density={look?.density ?? "cozy"}>
      {props.rows.map((row, index) => {
        const value = row[valueColumn];
        const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
        const bound = maxColumn ? row[maxColumn] : undefined;
        const scale =
          typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? bound : largest;
        const share = numeric !== null && scale > 0 ? numeric / scale : 0;

        return (
          <div className="dash-progress-row" key={index}>
            <div className="dash-progress-row__head">
              <span className="dash-progress-row__label" title={String(row[labelColumn] ?? "")}>
                {String(row[labelColumn] ?? "")}
              </span>
              {statusColumn && row[statusColumn] != null && (
                <StatusPill tone={statusTone(row[statusColumn])} label={String(row[statusColumn])} />
              )}
              {showValue && (
                <span className="dash-progress-row__value">
                  {numeric === null ? "—" : formatValueAt(value)}
                </span>
              )}
            </div>
            <div
              className="dash-progress-row__track"
              role="img"
              aria-label={`${Math.round(share * 100)}%`}
            >
              <div
                className="dash-progress-row__fill"
                // Clamped so an over-target row fills the bar rather than
                // overflowing the widget.
                style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
              />
            </div>
          </div>
        );
      })}

      {!maxColumn && (
        <p className="dash-progress-list__note">
          Relative to the largest value here, not to a target.
        </p>
      )}
    </div>
  );
};
