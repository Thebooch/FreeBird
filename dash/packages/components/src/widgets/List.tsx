import { isSlotHidden } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

const SAFE_LINK = /^https?:\/\//i;

export const List = (props: WidgetRenderProps): JSX.Element => {
  const titleColumn = roleColumn(props.roles, "title");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const metaColumn = roleColumn(props.roles, "meta");
  const hrefColumn = roleColumn(props.roles, "href");
  const statusColumn = roleColumn(props.roles, "status");

  const look = props.presentation;
  const showSubtitle = !isSlotHidden(look, "subtitle");
  const showMeta = !isSlotHidden(look, "meta");

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);
  const formatMeta = makeFormatter(props, metaColumn);

  if (!titleColumn) return <Message>This widget has no title binding.</Message>;
  if (props.rows.length === 0) return <Message>Nothing here in this range.</Message>;

  return (
    <ul className="dash-list" data-density={look?.density ?? "cozy"}>
      {props.rows.map((row, index) => {
        const href = hrefColumn ? row[hrefColumn] : null;
        // Only http(s) links become anchors — a javascript: URL from an API
        // response is exactly the kind of thing that must never be clickable.
        const link = typeof href === "string" && SAFE_LINK.test(href) ? href : null;
        const title = formatTitle(row[titleColumn]);

        return (
          <li
            className={`dash-list__item${props.onSelectRow ? " dash-row-open" : ""}`}
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
            <div className="dash-list__text">
              <div className="dash-list__title" title={title}>
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer noopener"
                    // The row opens the record; the link goes to the vendor.
                    // Without this, following the link would do both.
                    onClick={(event) => event.stopPropagation()}
                  >
                    {title}
                  </a>
                ) : (
                  title
                )}
              </div>
              {showSubtitle && subtitleColumn && (
                <div className="dash-list__subtitle">{formatSubtitle(row[subtitleColumn])}</div>
              )}
            </div>

            {statusColumn && (
              <StatusPill
                tone={statusTone(row[statusColumn])}
                label={String(row[statusColumn] ?? "—")}
              />
            )}
            {showMeta && metaColumn && (
              <div className="dash-list__meta">{formatMeta(row[metaColumn])}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
