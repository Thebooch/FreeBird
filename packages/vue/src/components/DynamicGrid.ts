import {
  defineComponent,
  computed,
  h,
  type PropType,
  type VNodeChild,
} from "vue";
import type { ComponentDefinition, GridCell } from "@freebirdai/core";
import { useFreeBird } from "../composables/useFreeBird.js";

/**
 * Headless grid renderer. Positions each cell on a 12-col grid via inline
 * CSS Grid styles. The inner component is rendered by the `render()`
 * function configured on its `ComponentDefinition` in the registry — for
 * Vue that `render()` should return a `VNodeChild`.
 *
 * Matches the React `DynamicGrid` API and data attributes 1:1.
 */
export const DynamicGrid = defineComponent({
  name: "FreeBirdDynamicGrid",
  props: {
    cells: { type: Array as PropType<GridCell[]>, default: undefined },
    gridCols: { type: Number, default: undefined },
    showLocks: { type: Boolean, default: true },
    rowHeightPx: { type: Number, default: 72 },
    gapPx: { type: Number, default: 12 },
    /**
     * Extra per-cell wrapper render. Receives `(cell, wrapped, inner)` —
     * `wrapped` is the default `<div data-freebird-cell>` with inline
     * grid placement styles, `inner` is the component's rendered output
     * prior to wrapping so you can rebuild the cell with extra children
     * (like absolute-positioned overlays). Use this prop or the `cell`
     * scoped slot.
     */
    renderCell: {
      type: Function as PropType<
        (cell: GridCell, wrapped: VNodeChild, inner: VNodeChild) => VNodeChild
      >,
      default: undefined,
    },
    renderMissing: {
      type: Function as PropType<(cell: GridCell) => VNodeChild>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const fb = useFreeBird();
    const effectiveCells = computed<GridCell[]>(
      () => props.cells ?? fb.layout.value?.cells ?? [],
    );
    const gridCols = computed<number>(
      () => props.gridCols ?? fb.layout.value?.gridCols ?? 12,
    );

    return () => {
      const rootStyle = {
        display: "grid",
        gridTemplateColumns: `repeat(${gridCols.value}, 1fr)`,
        gridAutoRows: `${props.rowHeightPx}px`,
        gap: `${props.gapPx}px`,
      };

      return h(
        "div",
        {
          "data-freebird-grid": "",
          "data-freebird-locks": props.showLocks ? "show" : "hide",
          style: rootStyle,
        },
        effectiveCells.value.map((cell) => {
          const def = fb.registry.get(cell.componentId) as
            | ComponentDefinition<Record<string, unknown>, VNodeChild, unknown>
            | undefined;

          let content: VNodeChild;
          if (def?.render) {
            content = def.render(cell.props as Record<string, unknown>);
          } else if (props.renderMissing) {
            content = props.renderMissing(cell);
          } else {
            content = h(
              "div",
              { "data-freebird-cell-missing": "" },
              `Missing component: ${cell.componentId}`,
            );
          }

          const cellStyle = {
            gridColumn: `${cell.x + 1} / span ${cell.w}`,
            gridRow: `${cell.y + 1} / span ${cell.h}`,
          };

          const wrapped = h(
            "div",
            {
              key: cell.instanceId,
              "data-freebird-cell": "",
              "data-component": cell.componentId,
              "data-locked": cell.locked ? "" : undefined,
              "data-importance": cell.importance,
              "data-orientation": cell.orientation,
              style: cellStyle,
            },
            // `h()` wants `RawChildren` for its third arg; a lone
            // `VNodeChild` doesn't match directly because it includes
            // `null`. Wrapping in an array always satisfies the overload.
            [content],
          );

          if (props.renderCell) return props.renderCell(cell, wrapped, content);
          if (slots.cell)
            return slots.cell({ cell, content: wrapped, wrapped, inner: content });
          return wrapped;
        }),
      );
    };
  },
});
