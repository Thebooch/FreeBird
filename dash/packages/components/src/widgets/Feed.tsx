import { formatValue, isSlotHidden, settingBool } from "@freebirdai/dash-spec";
import { statusTone } from "../palette.js";
import { Avatar, Message, StatusPill } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import { byRecency, groupByDay } from "./collectionModel.js";

const SAFE_LINK = /^https?:\/\//i;

/**
 * The heading over a day's entries.
 *
 * Deliberately not the timestamp formatter. That renders an instant in the
 * dashboard's timezone, and the group's instant is *local* midnight — so the
 * heading came out as "Nov 20, 2025, 8:00 AM", which is both the wrong
 * granularity for a day heading and a different day for anyone far enough
 * east. A calendar day is a date, so it is formatted as one.
 */
const dayHeading = (at: number, locale: string | undefined): string =>
  new Date(at).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * What happened lately, under a heading per day.
 *
 * The day heading is what makes a feed readable at a glance: without it every
 * entry carries its own date and the eye has to compare timestamps to work out
 * where yesterday ended.
 */
export const Feed = (props: WidgetRenderProps): JSX.Element => {
  const timeColumn = roleColumn(props.roles, "time");
  const titleColumn = roleColumn(props.roles, "title");
  const actorColumn = roleColumn(props.roles, "actor");
  const subtitleColumn = roleColumn(props.roles, "subtitle");
  const metaColumn = roleColumn(props.roles, "meta");
  const hrefColumn = roleColumn(props.roles, "href");
  const statusColumn = roleColumn(props.roles, "status");

  const look = props.presentation;
  const showSubtitle = !isSlotHidden(look, "subtitle");
  const grouped = settingBool(look, "groupByDay", true);
  const showAvatars = settingBool(look, "avatars", true);

  const formatTitle = makeFormatter(props, titleColumn);
  const formatSubtitle = makeFormatter(props, subtitleColumn);
  const formatMeta = makeFormatter(props, metaColumn);

  if (!timeColumn || !titleColumn) {
    return <Message>This widget needs a time field and a title field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing happened in this range.</Message>;

  const { dated, undated } = byRecency(props.rows, timeColumn);
  const clock = { now: props.now, ...(props.timeZone ? { timeZone: props.timeZone } : {}) };

  const entry = (row: Record<string, unknown>, at: number | null, key: string): JSX.Element => {
    const href = hrefColumn ? row[hrefColumn] : null;
    const link = typeof href === "string" && SAFE_LINK.test(href) ? href : null;
    const title = formatTitle(row[titleColumn]);
    const actor = actorColumn ? row[actorColumn] : null;

    return (
      <li
        className={`dash-feed__item${props.onSelectRow ? " dash-row-open" : ""}`}
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
        {showAvatars && actor != null && String(actor) !== "" && (
          <Avatar name={String(actor)} size="sm" />
        )}
        <div className="dash-feed__body">
          <div className="dash-feed__line">
            {actor != null && String(actor) !== "" && (
              <span className="dash-feed__actor">{String(actor)}</span>
            )}
            <span className="dash-feed__title">
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                  // The row opens the record; the link goes to the vendor.
                  onClick={(event) => event.stopPropagation()}
                >
                  {title}
                </a>
              ) : (
                title
              )}
            </span>
          </div>
          {showSubtitle && subtitleColumn && row[subtitleColumn] != null && (
            <div className="dash-feed__subtitle">{formatSubtitle(row[subtitleColumn])}</div>
          )}
        </div>

        <div className="dash-feed__side">
          {statusColumn && row[statusColumn] != null && (
            <StatusPill tone={statusTone(row[statusColumn])} label={String(row[statusColumn])} />
          )}
          <span className="dash-feed__when">
            {at === null ? "—" : formatValue(at, { semantic: "relative_time" }, clock)}
          </span>
          {metaColumn && row[metaColumn] != null && (
            <span className="dash-feed__meta">{formatMeta(row[metaColumn])}</span>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="dash-feed-scroll" data-density={look?.density ?? "cozy"}>
      {grouped ? (
        groupByDay(dated).map((day) => (
          <section className="dash-feed__day" key={day.key}>
            <h4 className="dash-feed__date">{dayHeading(day.at, props.locale)}</h4>
            <ul className="dash-feed">
              {day.rows.map((item, index) => entry(item.row, item.at, `${day.key}-${index}`))}
            </ul>
          </section>
        ))
      ) : (
        <ul className="dash-feed">
          {dated.map((item, index) => entry(item.row, item.at, `d${index}`))}
        </ul>
      )}

      {undated.length > 0 && (
        <section className="dash-feed__day">
          {/* Kept and labelled rather than dropped: they happened. */}
          <h4 className="dash-feed__date">No readable date</h4>
          <ul className="dash-feed">
            {undated.map((row, index) => entry(row, null, `u${index}`))}
          </ul>
        </section>
      )}
    </div>
  );
};
