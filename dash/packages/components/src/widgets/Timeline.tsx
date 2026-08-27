import { formatValue } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import { byRecency } from "./collectionModel.js";

/**
 * Events down a rail, newest first.
 *
 * Rows whose date could not be read are kept and shown at the end under an
 * honest heading rather than dropped: they happened, and a timeline that
 * quietly omits them is under-reporting.
 */
export const Timeline = (props: WidgetRenderProps): JSX.Element => {
  const timeColumn = roleColumn(props.roles, "time");
  const titleColumn = roleColumn(props.roles, "title");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const statusColumn = roleColumn(props.roles, "status");

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);

  if (!timeColumn || !titleColumn) {
    return <Message>This widget needs a time field and a title field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing happened in this range.</Message>;

  const { dated, undated } = byRecency(props.rows, timeColumn);

  const entry = (row: Record<string, unknown>, when: string, key: string): JSX.Element => (
    <li
      className={`dash-timeline__item${props.onSelectRow ? " dash-row-open" : ""}`}
      key={key}
      {...(props.onSelectRow
        ? {
            tabIndex: 0,
            role: "button",
            onClick: () => props.onSelectRow?.(row),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              props.onSelectRow?.(row);
            },
          }
        : {})}
    >
      {/* The dot sits on the rail; the rail is a border on the list, so it
          runs continuously behind every entry rather than being segmented. */}
      <span className="dash-timeline__dot" aria-hidden="true" />
      <div className="dash-timeline__body">
        <div className="dash-timeline__when">{when}</div>
        <div className="dash-timeline__title">{formatTitle(row[titleColumn])}</div>
        {subtitleColumn && row[subtitleColumn] != null && (
          <div className="dash-timeline__subtitle">{formatSubtitle(row[subtitleColumn])}</div>
        )}
      </div>
      {statusColumn && row[statusColumn] != null && (
        <StatusPill tone={statusTone(row[statusColumn])} label={String(row[statusColumn])} />
      )}
    </li>
  );

  return (
    <div className="dash-timeline-scroll" data-density={props.presentation?.density ?? "cozy"}>
      <ol className="dash-timeline">
        {dated.map((item, index) =>
          entry(
            item.row,
            formatValue(
              item.at,
              { semantic: "relative_time" },
              { now: props.now, ...(props.timeZone ? { timeZone: props.timeZone } : {}) },
            ),
            `d${index}`,
          ),
        )}
      </ol>

      {undated.length > 0 && (
        <>
          <p className="dash-timeline__aside">
            {undated.length} {undated.length === 1 ? "entry has" : "entries have"} no readable date
          </p>
          <ol className="dash-timeline">
            {undated.map((row, index) => entry(row, "—", `u${index}`))}
          </ol>
        </>
      )}
    </div>
  );
};
