import { GRAINS, type Grain, type RangePreset } from "@freebirdai/dash-spec";
import { useDashboard } from "./context.jsx";

const PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "12mo", label: "12mo" },
];

const GRAIN_LABELS: Readonly<Record<Grain, string>> = {
  "1h": "Hourly",
  "1d": "Daily",
  "1w": "Weekly",
  "1mo": "Monthly",
  "1y": "Yearly",
};

/**
 * One row of controls above the charts, driving every widget at once.
 *
 * This is what makes a set of charts a dashboard. Hand-built ones almost never
 * have it, because it requires every widget to cooperate through shared state
 * rather than each fetching its own hardcoded window.
 */
export const ParamBar = (): JSX.Element => {
  const { dashboard, controls, params, setPreset, setGrain, setFilter, refreshAll } = useDashboard();

  return (
    <div className="dash-params">
      <div className="dash-segment" role="group" aria-label="Time range">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-pressed={controls.preset === preset.value}
            onClick={() => setPreset(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="dash-params__group">
        <label className="dash-params__label" htmlFor="dash-grain">
          Grain
        </label>
        <select
          id="dash-grain"
          className="dash-control"
          value={controls.grain ?? "auto"}
          onChange={(event) =>
            setGrain(event.target.value === "auto" ? undefined : (event.target.value as Grain))
          }
        >
          {/* Auto follows the range width, which is right far more often than
              a grain the user picked once and forgot about. */}
          <option value="auto">Auto ({GRAIN_LABELS[params.range.grain]})</option>
          {GRAINS.map((grain) => (
            <option key={grain} value={grain}>
              {GRAIN_LABELS[grain]}
            </option>
          ))}
        </select>
      </div>

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
