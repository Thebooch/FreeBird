import { isSlotHidden, settingBool, settingNumber } from "@freebirdai/dash-spec";
import { useMemo, useState } from "react";
import {
  Menu,
  Message,
  Pagination,
  SearchInput,
  StatusPill,
  Toolbar,
  pageSlice,
} from "../ui/index.js";
import {
  dominantTone,
  highlightsFor,
  isNumericColumn,
  labelOf,
  makeFormatter,
  roleColumns,
  titleFor,
} from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import {
  type SortState,
  columnTotals,
  effectiveSort,
  filterRows,
  nextSort,
  sortRows,
  visibleColumns,
} from "./tableModel.js";

/**
 * The workhorse.
 *
 * Also the relief mechanism for the three light-mode palette slots that sit
 * below 3:1 contrast — every value is readable as text here regardless of how
 * it is coloured in a chart.
 *
 * Sorting, searching and paging all act on the rows the pipeline produced,
 * never on the endpoint. Everything is off by default except sorting: a table
 * on a dashboard is usually a top-N that already fits, and a search box over
 * eight rows is furniture.
 */
export const Table = (props: WidgetRenderProps): JSX.Element => {
  const names = roleColumns(props.roles, "columns");
  const allColumns = names.length > 0 ? names : props.columns.map((column) => column.name);

  const look = props.presentation;
  const showHeader = !isSlotHidden(look, "header");
  const showPills = !isSlotHidden(look, "pills");
  const sortable = settingBool(look, "sortable", true);
  const searchable = settingBool(look, "searchable", false);
  const pickable = settingBool(look, "columnPicker", false);
  const showTotals = settingBool(look, "totals", false);
  const pageSize = Math.max(0, Math.floor(settingNumber(look, "pageSize", 0)));

  /*
   * Only the reader's own choices are state. Everything drawn is derived from
   * the current props on every render — holding the derived list instead is
   * the bug class this codebase has hit three times, where state seeded from
   * props went stale the moment the widget set changed.
   */
  const [sort, setSort] = useState<SortState | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [page, setPage] = useState(1);

  const columns = visibleColumns(allColumns, hidden);
  const activeSort = effectiveSort(sort, columns);

  const formatters = useMemo(
    // Rebuilt when the format spec or locale changes rather than caching a
    // stale currency against new rows.
    () => new Map(allColumns.map((name) => [name, makeFormatter(props, name)])),
    [props, allColumns],
  );

  const display = (row: Record<string, unknown>, column: string): string =>
    formatters.get(column)?.(row[column]) ?? "";

  const searched = searchable ? filterRows(props.rows, columns, query, display) : props.rows;
  const shaped = sortRows(searched, activeSort);

  /*
   * Highlights are index-parallel to the *original* rows, so the index has to
   * travel with the row rather than being recomputed after sorting. Without
   * this, sorting a table moves every status pill onto the wrong record.
   */
  const originalIndex = useMemo(() => {
    const map = new Map<Record<string, unknown>, number>();
    props.rows.forEach((row, index) => map.set(row, index));
    return map;
  }, [props.rows]);

  if (allColumns.length === 0) return <Message>This widget has no columns bound.</Message>;
  if (props.rows.length === 0) return <Message>No rows in this range.</Message>;

  const paged = pageSize > 0 ? pageSlice(shaped, page, pageSize) : null;
  const rows = paged ? paged.rows : shaped;
  const totals = showTotals ? columnTotals(shaped, columns, props.columns) : [];
  const totalByColumn = new Map(totals.map((total) => [total.column, total]));
  const labelCell = columns.find((name) => !totalByColumn.has(name));

  return (
    <>
      {(searchable || pickable) && (
        <Toolbar
          testId="table-toolbar"
          end={
            pickable ? (
              <Menu
                glyph="◫"
                label="Choose columns"
                testId="table-columns"
                items={allColumns.map((name) => ({
                  id: name,
                  label: labelOf(props.columns, name),
                  checked: !hidden.has(name),
                  // Picking columns is a series of choices, so the menu stays
                  // open between them.
                  keepOpen: true,
                  onSelect: () =>
                    setHidden((previous) => {
                      const next = new Set(previous);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      return next;
                    }),
                }))}
              />
            ) : undefined
          }
        >
          {searchable && (
            <SearchInput
              value={query}
              onChange={(value) => {
                setQuery(value);
                // A narrower result set makes the current page meaningless.
                setPage(1);
              }}
              label={`Search ${props.title}`}
              placeholder="Search these rows"
              testId="table-search"
            />
          )}
        </Toolbar>
      )}

      <div className="dash-table-scroll">
        <table
          className="dash-table"
          data-density={look?.density ?? "cozy"}
          data-zebra={settingBool(look, "zebra", false) ? "on" : "off"}
          data-sticky-first={settingBool(look, "stickyFirstColumn", false) ? "on" : "off"}
        >
          {showHeader && (
            <thead>
              <tr>
                {columns.map((name) => {
                  const numeric = isNumericColumn(props.columns, name);
                  const active = activeSort?.column === name;

                  if (!sortable) {
                    return (
                      <th key={name} className={numeric ? "dash-num" : undefined} title={name}>
                        {labelOf(props.columns, name)}
                      </th>
                    );
                  }

                  return (
                    <th
                      key={name}
                      className={numeric ? "dash-num" : undefined}
                      /*
                       * The name the API actually uses, one hover away.
                       *
                       * The header shows what the field is called for people
                       * reading the dashboard; somebody debugging a binding
                       * needs the other name, and hiding it entirely would
                       * trade one unreadable audience for another.
                       */
                      title={name}
                      // The cell carries the sort state for assistive tech;
                      // the button inside it is what gets activated.
                      aria-sort={
                        active
                          ? activeSort?.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        className="dash-table__sort"
                        data-active={active ? "true" : undefined}
                        data-testid={`sort-${name}`}
                        onClick={() => setSort((previous) => nextSort(previous, name))}
                      >
                        {labelOf(props.columns, name)}
                        <span className="dash-table__arrow" aria-hidden="true">
                          {active ? (activeSort?.direction === "asc" ? "↑" : "↓") : "↕"}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row) => {
              const index = originalIndex.get(row) ?? 0;
              const hits = highlightsFor(props, index);
              const rowHits = hits.filter((hit) => !hit.field);
              const tone = dominantTone(rowHits);
              // Built once. Two spreads each carrying `className` means the
              // later one silently wins, which is a trap rather than a rule.
              const className = [
                tone ? `dash-row-tone dash-row-tone--${tone}` : "",
                props.onSelectRow ? "dash-row-open" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <tr
                  key={index}
                  {...(className ? { className } : {})}
                  {...(props.onSelectRow
                    ? {
                        // Reachable by keyboard, not just by pointer. A row
                        // that opens a record is a control and behaves like one.
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
                  {columns.map((name, cell) => (
                    <td
                      key={name}
                      className={isNumericColumn(props.columns, name) ? "dash-num" : undefined}
                      // The cell shows a summary; the tooltip is where the
                      // whole value lives. `String()` renders an object as
                      // "[object Object]", which is the least useful string
                      // there is to put in front of someone.
                      title={titleFor(row[name])}
                    >
                      {display(row, name)}
                      {/* Pills ride in the first bound cell rather than a
                          column of their own: an extra column would
                          desynchronise the header from `roles.columns`,
                          changing what was approved. */}
                      {showPills &&
                        cell === 0 &&
                        rowHits.map((hit) => (
                          <span key={hit.id} className="dash-cell-pill">
                            <StatusPill tone={hit.tone} label={hit.label} />
                          </span>
                        ))}
                      {showPills &&
                        hits
                          .filter((hit) => hit.field === name)
                          .map((hit) => (
                            <span key={hit.id} className="dash-cell-pill">
                              <StatusPill tone={hit.tone} label={hit.label} />
                            </span>
                          ))}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>

          {totals.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((name) => {
                  const total = totalByColumn.get(name);
                  // The label goes in the first cell that has no sum of its
                  // own, so a row of bare numbers is never left unexplained —
                  // and it is never written over a figure.
                  if (!total) return <td key={name}>{name === labelCell ? "Total" : ""}</td>;

                  const partial = total.counted !== shaped.length;
                  return (
                    <td
                      key={name}
                      className="dash-num"
                      // A sum over rows that were not all numbers is a
                      // different fact from a sum over all of them, and saying
                      // so costs one asterisk.
                      title={
                        partial
                          ? `Summed the ${total.counted} of ${shaped.length} rows that held a number`
                          : undefined
                      }
                    >
                      {formatters.get(name)?.(total.sum) ?? ""}
                      {partial && <span className="dash-table__partial"> *</span>}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {searchable && query.trim() !== "" && shaped.length === 0 && (
        <Message>Nothing here matches “{query.trim()}”.</Message>
      )}
      {paged && (
        <Pagination
          page={paged.page}
          pageCount={paged.pageCount}
          total={paged.total}
          rangeStart={paged.rangeStart}
          rangeEnd={paged.rangeEnd}
          onChange={setPage}
        />
      )}
    </>
  );
};
