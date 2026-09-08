import { STATUS_ICONS, STATUS_TONES } from "../palette.js";
import type { FacetView } from "../widgets/facetModel.js";

/**
 * A row of counts that are also the filter.
 *
 * Two things at once, and that is the point: the number tells you how much is
 * in each category, and clicking it narrows the widget to that category. A
 * separate dropdown would say neither until it was opened.
 *
 * Deliberately **not** built on `Tabs`. A tab strip is a roving tabindex with
 * exactly one `aria-selected` member, which is wrong here twice over — a facet
 * can have several tiles lit at once, and it can have none, meaning "show
 * everything". These are toggle buttons carrying `aria-pressed`, which says
 * what is actually true.
 */

const variantOf = (variant: string | undefined): "tiles" | "chips" =>
  variant === "chips" ? "chips" : "tiles";

export const FacetBar = ({
  views,
  onToggle,
  onClear,
  variant,
  showCounts = true,
}: {
  readonly views: readonly FacetView[];
  readonly onToggle: (view: FacetView, key: string) => void;
  /** Absent when nothing is selected; drawn as a way back to everything. */
  readonly onClear?: () => void;
  readonly variant?: string | undefined;
  readonly showCounts?: boolean;
}): JSX.Element | null => {
  const drawable = views.filter((view) => view.tiles.length > 0);
  if (drawable.length === 0) return null;

  const anySelected = drawable.some((view) => view.selected.length > 0);

  return (
    <div className="dash-facets" data-variant={variantOf(variant)}>
      {drawable.map((view) => (
        <div
          className="dash-facets__group"
          key={view.field}
          role="group"
          aria-label={`Filter by ${view.label}`}
        >
          <span className="dash-facets__label">{view.label}</span>
          {view.tiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              className="dash-facets__tile"
              data-tone={tile.tone}
              data-selected={tile.selected ? "true" : undefined}
              /*
               * The state, said out loud. A pressed toggle is the only
               * accessible shape for "this filter is on and can be turned
               * off"; `aria-selected` would claim membership of a tab set
               * that does not exist.
               */
              aria-pressed={tile.selected}
              data-testid={`facet-${view.field}-${tile.key}`}
              onClick={() => onToggle(view, tile.key)}
            >
              {/*
               * Colour is never the only channel. The same glyph the status
               * pills use rides along, so a tile survives a monochrome print
               * and forced-colours mode with its meaning intact.
               */}
              {tile.tone !== "neutral" && (
                <span
                  className="dash-facets__icon"
                  style={{ color: STATUS_TONES[tile.tone] }}
                  aria-hidden="true"
                >
                  {STATUS_ICONS[tile.tone]}
                </span>
              )}
              <span className="dash-facets__name">{tile.label}</span>
              {showCounts && (
                <span className="dash-facets__count">{tile.count.toLocaleString()}</span>
              )}
            </button>
          ))}
        </div>
      ))}

      {anySelected && onClear && (
        <button type="button" className="dash-facets__clear" onClick={onClear} data-testid="facet-clear">
          Clear
        </button>
      )}
    </div>
  );
};
