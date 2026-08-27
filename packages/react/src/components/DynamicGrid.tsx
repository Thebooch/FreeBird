import React, { useMemo } from "react";
import type { GridCell } from "@freebirdai/core";
import { useFreeBird } from "../provider.js";

export interface DynamicGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Override the layout rendered. Defaults to the one in the provider. */
  cells?: GridCell[];
  gridCols?: number;
  /**
   * If false, wrapper cells don't mark themselves with `data-freebird-locks="show"`
   * and LockToggle is expected to be hidden by CSS. Default true.
   */
  showLocks?: boolean;
  /** Extra per-cell wrapper render. Defaults to a plain `<div>` with data attrs. */
  renderCell?: (cell: GridCell, content: React.ReactNode) => React.ReactNode;
  /** Called when a component id cannot be resolved against the registry. */
  renderMissing?: (cell: GridCell) => React.ReactNode;
  rowHeightPx?: number;
  gapPx?: number;
}

/**
 * Headless grid renderer. Positions each cell on a 12-col (or configurable)
 * grid via inline CSS Grid styles. All styling of the *inner* component is
 * delegated to the component's own `render()`.
 *
 * Data attributes exposed for styling:
 *  - `data-freebird-grid=""` on the root
 *  - `data-freebird-cell=""`   on each cell wrapper
 *  - `data-locked` / `data-importance` / `data-component` on each cell
 *  - `data-freebird-locks="show"` on root iff `showLocks`
 */
export const DynamicGrid: React.FC<DynamicGridProps> = ({
  cells: cellsOverride,
  gridCols: gridColsOverride,
  showLocks = true,
  renderCell,
  renderMissing,
  rowHeightPx = 72,
  gapPx = 12,
  style,
  ...rest
}) => {
  const fb = useFreeBird();
  const layout = fb.layout;
  const cells = cellsOverride ?? layout?.cells ?? [];
  const gridCols = gridColsOverride ?? layout?.gridCols ?? 12;

  const rootStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "grid",
      gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
      gridAutoRows: `${rowHeightPx}px`,
      gap: `${gapPx}px`,
      ...style,
    }),
    [gridCols, rowHeightPx, gapPx, style],
  );

  return (
    <div
      data-freebird-grid=""
      data-freebird-locks={showLocks ? "show" : "hide"}
      style={rootStyle}
      {...rest}
    >
      {cells.map((cell) => {
        const def = fb.registry.get(cell.componentId);
        const content = def?.render
          ? def.render(cell.props)
          : renderMissing
            ? renderMissing(cell)
            : (
                <div data-freebird-cell-missing="">
                  Missing component: {cell.componentId}
                </div>
              );

        const cellStyle: React.CSSProperties = {
          gridColumn: `${cell.x + 1} / span ${cell.w}`,
          gridRow: `${cell.y + 1} / span ${cell.h}`,
        };

        const wrapped = (
          <div
            key={cell.instanceId}
            data-freebird-cell=""
            data-component={cell.componentId}
            data-locked={cell.locked ? "" : undefined}
            data-importance={cell.importance}
            data-orientation={cell.orientation}
            style={cellStyle}
          >
            {content}
          </div>
        );

        return renderCell ? <React.Fragment key={cell.instanceId}>{renderCell(cell, wrapped)}</React.Fragment> : wrapped;
      })}
    </div>
  );
};
