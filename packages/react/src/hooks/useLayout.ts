import { useCallback } from "react";
import type { GridCell, LayoutPlan } from "@freebirdai/core";
import { useFreeBird } from "../provider.js";

export interface UseLayoutReturn {
  plan: LayoutPlan | null;
  setPlan: (p: LayoutPlan | null) => void;
  lockedCells: GridCell[];
  unlockedCells: GridCell[];
  toggleLock: (instanceId: string) => void;
  lockAll: () => void;
  unlockAll: () => void;
  /** Remove a cell from the live layout (useful for manual close-buttons). */
  removeCell: (instanceId: string) => void;
}

export const useLayout = (): UseLayoutReturn => {
  const fb = useFreeBird();

  const lockAll = useCallback(() => {
    fb.setLayout(
      fb.layout
        ? { ...fb.layout, cells: fb.layout.cells.map((c) => ({ ...c, locked: true })) }
        : null,
    );
  }, [fb]);

  const unlockAll = useCallback(() => {
    fb.setLayout(
      fb.layout
        ? { ...fb.layout, cells: fb.layout.cells.map((c) => ({ ...c, locked: false })) }
        : null,
    );
  }, [fb]);

  const removeCell = useCallback(
    (instanceId: string) => {
      fb.setLayout(
        fb.layout
          ? { ...fb.layout, cells: fb.layout.cells.filter((c) => c.instanceId !== instanceId) }
          : null,
      );
    },
    [fb],
  );

  return {
    plan: fb.layout,
    setPlan: fb.setLayout,
    lockedCells: fb.lockedCells,
    unlockedCells: fb.layout ? fb.layout.cells.filter((c) => !c.locked) : [],
    toggleLock: fb.toggleLock,
    lockAll,
    unlockAll,
    removeCell,
  };
};
