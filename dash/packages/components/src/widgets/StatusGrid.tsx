import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

export const StatusGrid = (props: WidgetRenderProps): JSX.Element => {
  const labelColumn = roleColumn(props.roles, "label");
  const statusColumn = roleColumn(props.roles, "status");
  const metaColumn = roleColumn(props.roles, "meta");

  const formatLabel = makeFormatter(props, labelColumn);
  const formatMeta = makeFormatter(props, metaColumn);

  if (!labelColumn || !statusColumn) {
    return <Message>This widget has no label and status binding.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing to report in this range.</Message>;

  return (
    <div className="dash-status-grid">
      {props.rows.map((row, index) => {
        const label = formatLabel(row[labelColumn]);
        return (
          <div className="dash-status-tile" key={index}>
            <div className="dash-status-tile__label" title={label}>
              {label}
            </div>
            <StatusPill
              tone={statusTone(row[statusColumn])}
              label={String(row[statusColumn] ?? "—")}
            />
            {metaColumn && (
              <div className="dash-status-tile__meta">{formatMeta(row[metaColumn])}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};
