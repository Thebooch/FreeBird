import { IconButton } from "./Button.jsx";

/**
 * Which slice of the rows is on screen.
 *
 * The count is the point, not the arrows. "Showing 1–25 of 1,284" is the
 * sentence that tells someone their filter did or did not do what they meant;
 * a bare pair of chevrons tells them nothing about the size of what they are
 * looking at.
 */
export const Pagination = ({
  page,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onChange,
  noun = "rows",
}: {
  /** 1-based, because it is shown to a person. */
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly onChange: (page: number) => void;
  readonly noun?: string;
}): JSX.Element => {
  const format = (value: number): string => value.toLocaleString();

  return (
    <div className="dash-pager">
      <span className="dash-pager__count">
        {total === 0
          ? `No ${noun}`
          : `Showing ${format(rangeStart)}–${format(rangeEnd)} of ${format(total)} ${noun}`}
      </span>
      {pageCount > 1 && (
        <span className="dash-pager__controls">
          <IconButton label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
            ‹
          </IconButton>
          <span className="dash-pager__page">
            {format(page)} / {format(pageCount)}
          </span>
          <IconButton
            label="Next page"
            disabled={page >= pageCount}
            onClick={() => onChange(page + 1)}
          >
            ›
          </IconButton>
        </span>
      )}
    </div>
  );
};

export interface PageSlice<T> {
  readonly rows: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly total: number;
}

/**
 * Cut a page out of the rows.
 *
 * Clamps rather than trusting the requested page: a filter that shrinks the
 * result set leaves the page number pointing past the end, and an empty table
 * with rows in it is a bug people report as "the search is broken".
 */
export const pageSlice = <T,>(rows: readonly T[], page: number, size: number): PageSlice<T> => {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, size)));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (current - 1) * size;

  return {
    rows: rows.slice(start, start + size),
    page: current,
    pageCount,
    total,
    rangeStart: total === 0 ? 0 : start + 1,
    rangeEnd: Math.min(start + size, total),
  };
};
