import { isSlotHidden, settingBool, settingNumber } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import { bucketBy } from "./collectionModel.js";

/**
 * Records in columns, grouped by a status.
 *
 * Read-only, and that is a property of the product rather than an omission:
 * every spec this runs is GET-only by construction, so a card that could be
 * dragged into another column would be promising a write nothing can perform.
 * The cards therefore carry no drag affordance at all — the same rule the rest
 * of the library follows about never advertising an interaction that will not
 * happen.
 */
export const Board = (props: WidgetRenderProps): JSX.Element => {
  const groupColumn = roleColumn(props.roles, "group");
  const titleColumn = roleColumn(props.roles, "title");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const metaColumn = roleColumn(props.roles, "meta");
  const statusColumn = roleColumn(props.roles, "status");

  const look = props.presentation;
  const showSubtitle = !isSlotHidden(look, "subtitle");
  const showCounts = settingBool(look, "counts", true);
  const columnWidth = Math.round(settingNumber(look, "columnWidth", 210));

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);
  const formatMeta = makeFormatter(props, metaColumn);

  if (!groupColumn || !titleColumn) {
    return <Message>This widget needs a column to group by and a title field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing to show for this time range.</Message>;

  const columns = bucketBy(props.rows, groupColumn);

  return (
    <div className="dash-board" data-density={look?.density ?? "cozy"}>
      {columns.map((column) => (
        <section
          className="dash-board__column"
          key={column.key}
          style={{ minWidth: columnWidth, maxWidth: columnWidth }}
        >
          <header className="dash-board__head">
            <span className="dash-board__name" title={column.key}>
              {column.key}
            </span>
            {showCounts && <span className="dash-board__count">{column.rows.length}</span>}
          </header>

          <div className="dash-board__cards">
            {column.rows.map((row, index) => (
              <article
                className={`dash-board__card${props.onSelectRow ? " dash-row-open" : ""}`}
                key={index}
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
                <div className="dash-board__title">{formatTitle(row[titleColumn])}</div>
                {showSubtitle && subtitleColumn && row[subtitleColumn] != null && (
                  <div className="dash-board__subtitle">{formatSubtitle(row[subtitleColumn])}</div>
                )}
                {(metaColumn || statusColumn) && (
                  <div className="dash-board__foot">
                    {/* Only when the pill would say something the column does
                        not already: repeating the group on every card in it is
                        noise. */}
                    {statusColumn && statusColumn !== groupColumn && row[statusColumn] != null && (
                      <StatusPill
                        tone={statusTone(row[statusColumn])}
                        label={String(row[statusColumn])}
                      />
                    )}
                    {metaColumn && row[metaColumn] != null && (
                      <span className="dash-board__meta">{formatMeta(row[metaColumn])}</span>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};
