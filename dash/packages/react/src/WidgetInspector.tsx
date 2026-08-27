import { formatValue, widgetSources } from "@freebirdai/dash-spec";
import { Fragment, useEffect, useMemo } from "react";
import type { FetchMeta } from "@freebirdai/dash-adapters";
import type { WidgetData } from "./useWidgetData.js";

const truncate = (value: unknown, limit = 4_000): string => {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return text.length > limit ? `${text.slice(0, limit)}\n… truncated` : text;
};

/**
 * Shows a widget's work: the endpoint, the resolved params, how many rows
 * survived each pipeline step, the warnings, and the raw payload.
 *
 * This is the trust story. A dashboard that is subtly wrong is worse than no
 * dashboard, because people make decisions on it — being able to answer "where
 * did this number come from" in two clicks is the difference. It doubles as
 * the table view that the light-mode palette's contrast relief rule requires.
 */
/** What a cache outcome meant for the user's rate limit. */
const cachePhrase = (outcome: NonNullable<FetchMeta["cache"]>): string => {
  switch (outcome) {
    case "hit":
      return "served from cache — no API call";
    case "revalidating":
      return "served from cache while refreshing behind it";
    case "stale":
      return "served from cache because the API could not be reached";
    case "miss":
      return "called the API";
  }
};

export const WidgetInspector = ({
  data,
  onClose,
}: {
  data: WidgetData;
  onClose: () => void;
}): JSX.Element => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { widget, runMeta, fetchMeta, rows, columns, binding } = data;
  const sources = useMemo(() => widgetSources(widget), [widget]);

  return (
    <div
      className="dash-inspector-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dash-inspector" role="dialog" aria-modal="true" aria-label={`${widget.title} details`}>
        <div className="dash-inspector__head">
          <h3 className="dash-inspector__title">{widget.title}</h3>
          <button className="dash-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dash-inspector__body">
          <h4>{sources.length > 1 ? `Sources (${sources.length})` : "Source"}</h4>
          <dl className="dash-inspector__kv">
            {/*
              Every endpoint, not just the first. A widget that reads two APIs
              and shows one number is precisely the case where "where did this
              come from" has to be answerable.
            */}
            {sources.map((source) => (
              <Fragment key={source.as}>
                <dt>{sources.length > 1 ? source.as : "Connection"}</dt>
                <dd>
                  {source.connection} · {source.op}
                  {source.fanOut ? ` · one call per ${source.fanOut.from} row` : ""}
                </dd>
              </Fragment>
            ))}
            {widget.combine?.op === "join" && (
              <>
                <dt>Join</dt>
                <dd>
                  {widget.combine.left}.{widget.combine.on.left} = {widget.combine.right}.
                  {widget.combine.on.right} ({widget.combine.kind})
                </dd>
              </>
            )}
            {widget.combine?.op === "union" && (
              <>
                <dt>Combined</dt>
                <dd>
                  {/* Each source measured on its own, stacked, and told apart
                      by the column named here. Nothing is matched row to row,
                      which is the thing worth being able to see. */}
                  {widget.sources.map((source) => source.label ?? source.as).join(" + ")} — tagged
                  in “{widget.combine.as}”
                </dd>
              </>
            )}
            {/*
             * Which model designed this binding.
             *
             * Shown because the AI actions no longer share one model: two
             * widgets on the same board can have been built by different ones,
             * and the first question about a field bound wrongly is which
             * model bound it. Absent on a widget somebody answered by hand,
             * which is the truthful answer rather than a blank.
             */}
            {widget.producedBy && (
              <>
                <dt>Designed by</dt>
                <dd>
                  {widget.producedBy.model} ·{" "}
                  {formatValue(
                    widget.producedBy.at,
                    { semantic: "relative_time" },
                    { now: Date.now() },
                  )}
                </dd>
              </>
            )}
            <dt>Request</dt>
            <dd>{fetchMeta?.url ?? "—"}</dd>
            <dt>Params</dt>
            <dd>
              {sources.every((source) => Object.keys(source.params).length === 0)
                ? "none"
                : truncate(sources.map((source) => source.params), 400)}
            </dd>
            <dt>Fetched</dt>
            <dd>
              {data.lastFetchedAt
                ? formatValue(data.lastFetchedAt, { semantic: "relative_time" }, { now: Date.now() })
                : "—"}
              {fetchMeta ? ` · ${fetchMeta.pages} page(s) · ${fetchMeta.durationMs}ms` : ""}
              {fetchMeta?.truncated ? " · truncated at the page cap" : ""}
            </dd>

            {/*
             * Whether this widget actually spent one of the user's API calls.
             * "Refreshing costs you rate limit" is advice; this is the fact.
             */}
            {fetchMeta?.cache && (
              <>
                <dt>Cost</dt>
                <dd>
                  {cachePhrase(fetchMeta.cache)}
                  {fetchMeta.ageMs !== undefined && fetchMeta.ageMs > 0
                    ? ` · ${Math.round(fetchMeta.ageMs / 1000)}s old`
                    : ""}
                </dd>
              </>
            )}
          </dl>

          {runMeta && runMeta.steps.length > 0 && (
            <>
              <h4>Pipeline</h4>
              <table className="dash-steps">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Detail</th>
                    <th className="dash-num">In</th>
                    <th className="dash-num">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {runMeta.steps.map((step, index) => (
                    <tr key={index}>
                      <td>{step.op}</td>
                      <td>
                        <code>{step.note ?? ""}</code>
                      </td>
                      <td className="dash-num">{step.rowsIn}</td>
                      <td className="dash-num">{step.rowsOut}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {runMeta?.highlightCounts && (
            <>
              <h4>Highlights</h4>
              <ul className="dash-warnlist">
                {Object.entries(runMeta.highlightCounts).map(([id, count]) => (
                  /*
                   * A rule matching nothing is the case worth seeing. A
                   * predicate naming a column that does not exist evaluates to
                   * false rather than throwing, so a typo is invisible until
                   * someone notices the colour never appears. "0 of 42" is the
                   * whole mitigation.
                   */
                  <li key={id}>
                    {id}: {count} of {runMeta.rowsOut} row(s)
                    {count === 0 ? " — check the field name in its condition" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}

          {runMeta && runMeta.coercionFailures > 0 && (
            <>
              <h4>Data loss</h4>
              <ul className="dash-warnlist">
                <li>
                  {runMeta.coercionFailures} value(s) could not be converted and became empty.
                </li>
              </ul>
            </>
          )}

          {runMeta && runMeta.warnings.length > 0 && (
            <>
              <h4>Warnings</h4>
              <ul className="dash-warnlist">
                {runMeta.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </>
          )}

          {binding && binding.warnings.length > 0 && (
            <>
              <h4>Binding notes</h4>
              <ul className="dash-warnlist">
                {binding.warnings.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </>
          )}

          {data.errors.length > 0 && (
            <>
              <h4>Errors</h4>
              <ul className="dash-errlist">
                {data.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </>
          )}

          <h4>Columns</h4>
          <table className="dash-steps">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Meaning</th>
                <th className="dash-num">Empty</th>
                <th className="dash-num">Distinct</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column.name}>
                  <td>{column.name}</td>
                  <td>{column.valueType}</td>
                  <td>{column.semantic ?? "—"}</td>
                  <td className="dash-num">{column.nullCount ?? 0}</td>
                  <td className="dash-num">{column.distinctCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Rows ({rows.length})</h4>
          <pre className="dash-payload">{truncate(rows.slice(0, 50))}</pre>

          <h4>Raw response</h4>
          <pre className="dash-payload">
            {data.state === "error"
              ? (data.userMessage ?? "no response")
              : data.raw === undefined
                ? "not fetched yet"
                : truncate(data.raw)}
          </pre>
        </div>
      </div>
    </div>
  );
};
