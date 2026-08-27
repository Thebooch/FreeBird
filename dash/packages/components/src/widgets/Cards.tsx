import { isSlotHidden, settingNumber } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Message, StatusPill } from "../ui/index.js";
import { labelOf, makeFormatter, roleColumn, roleColumns } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

/** Only http(s) becomes a link or an image source. */
const SAFE_URL = /^https:\/\//i;
const SAFE_LINK = /^https?:\/\//i;

/**
 * A card per record.
 *
 * The shape for browsing entities rather than reading a grid: when a row is a
 * person or a property rather than a measurement, a table makes you read
 * across to reassemble what a card shows at a glance.
 */
export const Cards = (props: WidgetRenderProps): JSX.Element => {
  const titleColumn = roleColumn(props.roles, "title");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const statusColumn = roleColumn(props.roles, "status");
  const imageColumn = roleColumn(props.roles, "image");
  const hrefColumn = roleColumn(props.roles, "href");
  const metaColumns = roleColumns(props.roles, "meta");

  const look = props.presentation;
  const showImage = !isSlotHidden(look, "image");
  const showSubtitle = !isSlotHidden(look, "subtitle");
  const showMeta = !isSlotHidden(look, "meta");
  const minWidth = Math.round(settingNumber(look, "minWidth", 200));

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);
  const metaFormatters = new Map(metaColumns.map((name) => [name, makeFormatter(props, name)]));

  if (!titleColumn) return <Message>This widget has no title binding.</Message>;
  if (props.rows.length === 0) return <Message>Nothing here in this range.</Message>;

  return (
    <div
      className="dash-cards-grid"
      data-density={look?.density ?? "cozy"}
      // The column count follows from the widget's width rather than a fixed
      // number, so the same card set works at 4 columns and at 12.
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }}
    >
      {props.rows.map((row, index) => {
        const title = formatTitle(row[titleColumn]);
        const href = hrefColumn ? row[hrefColumn] : null;
        const link = typeof href === "string" && SAFE_LINK.test(href) ? href : null;
        const image = imageColumn ? row[imageColumn] : null;
        // https only for an image: an http source on an https page is blocked
        // anyway, and a broken frame is worse than no frame.
        const src = typeof image === "string" && SAFE_URL.test(image) ? image : null;

        return (
          <article
            className={`dash-card-tile${props.onSelectRow ? " dash-row-open" : ""}`}
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
            {showImage && src && (
              <img
                className="dash-card-tile__image"
                src={src}
                alt=""
                loading="lazy"
                // The card already names the record, so the image is
                // decorative and an alt text would just repeat the heading.
                aria-hidden="true"
              />
            )}

            <div className="dash-card-tile__head">
              <h4 className="dash-card-tile__title" title={title}>
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer noopener"
                    // The card opens the record; the link goes to the vendor.
                    // Without this, following the link would do both.
                    onClick={(event) => event.stopPropagation()}
                  >
                    {title}
                  </a>
                ) : (
                  title
                )}
              </h4>
              {statusColumn && row[statusColumn] != null && (
                <StatusPill tone={statusTone(row[statusColumn])} label={String(row[statusColumn])} />
              )}
            </div>

            {showSubtitle && subtitleColumn && row[subtitleColumn] != null && (
              <p className="dash-card-tile__subtitle">{formatSubtitle(row[subtitleColumn])}</p>
            )}

            {showMeta && metaColumns.length > 0 && (
              <dl className="dash-card-tile__meta">
                {metaColumns.map((name) => (
                  <div className="dash-card-tile__fact" key={name}>
                    <dt title={name}>{labelOf(props.columns, name)}</dt>
                    <dd>{metaFormatters.get(name)?.(row[name]) ?? ""}</dd>
                  </div>
                ))}
              </dl>
            )}
          </article>
        );
      })}
    </div>
  );
};
