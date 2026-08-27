import { isSlotHidden } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { labelOf, makeFormatter, roleColumn, roleColumns } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

/**
 * Who this record is.
 *
 * A record view without one opens on a wall of label-and-value pairs with
 * nothing at the top saying what you are looking at — you have to read the
 * fields to work out whose they are. The facts strip carries the two or three
 * worth knowing before the rest.
 */
export const RecordHeader = (props: WidgetRenderProps): JSX.Element => {
  const titleColumn = roleColumn(props.roles, "title");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const statusColumn = roleColumn(props.roles, "status");
  const factColumns = roleColumns(props.roles, "facts");

  const look = props.presentation;
  const showFacts = !isSlotHidden(look, "facts");
  const showSubtitle = !isSlotHidden(look, "subtitle");

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);
  const factFormatters = new Map(factColumns.map((name) => [name, makeFormatter(props, name)]));

  const row = props.rows[0];
  if (!row) return <Message>No record found.</Message>;

  return (
    <header className="dash-record-head" data-density={look?.density ?? "cozy"}>
      <div className="dash-record-head__identity">
        <h3 className="dash-record-head__title">
          {titleColumn ? formatTitle(row[titleColumn]) : props.title}
        </h3>
        {statusColumn && row[statusColumn] != null && (
          <StatusPill tone={statusTone(row[statusColumn])} label={String(row[statusColumn])} />
        )}
      </div>

      {showSubtitle && subtitleColumn && row[subtitleColumn] != null && (
        <p className="dash-record-head__subtitle">{formatSubtitle(row[subtitleColumn])}</p>
      )}

      {showFacts && factColumns.length > 0 && (
        <dl className="dash-record-head__facts">
          {factColumns.map((name) => (
            <div className="dash-record-head__fact" key={name}>
              <dt title={name}>{labelOf(props.columns, name)}</dt>
              <dd>{factFormatters.get(name)?.(row[name]) ?? ""}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
};
