import { useDashboard } from "./context.jsx";

/**
 * One row of controls above the charts, driving every widget at once.
 *
 * This is what makes a set of charts a dashboard. Hand-built ones almost never
 * have it, because it requires every widget to cooperate through shared state
 * rather than each fetching its own hardcoded window.
 *
 * The range presets and the grain picker used to lead this row. They are gone
 * from the UI — most boards bind endpoints that ignore the window, so the
 * controls read as promises the data does not keep. `setPreset`/`setGrain` are
 * still on the context and the assistant still calls them; what was removed is
 * the chrome, not the capability.
 */
export const ParamBar = (): JSX.Element => {
  const { dashboard, controls, setFilter, refreshAll } = useDashboard();

  return (
    <div className="dash-params">
      {dashboard.params.filters.map((filter) => (
        <div className="dash-params__group" key={filter.key}>
          <label className="dash-params__label" htmlFor={`dash-filter-${filter.key}`}>
            {filter.label}
          </label>
          {filter.type === "select" ? (
            <select
              id={`dash-filter-${filter.key}`}
              className="dash-control"
              value={String(controls.filters[filter.key] ?? "")}
              onChange={(event) => setFilter(filter.key, event.target.value)}
            >
              <option value="">All</option>
              {(filter.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`dash-filter-${filter.key}`}
              className="dash-control"
              type={filter.type === "number" ? "number" : "text"}
              value={String(controls.filters[filter.key] ?? "")}
              onChange={(event) =>
                setFilter(
                  filter.key,
                  filter.type === "number" ? Number(event.target.value) : event.target.value,
                )
              }
            />
          )}
        </div>
      ))}

      <button className="dash-control" style={{ marginLeft: "auto" }} onClick={refreshAll}>
        ↻ Refresh all
      </button>
    </div>
  );
};
