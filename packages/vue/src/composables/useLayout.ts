import { computed, type ComputedRef } from "vue";
import type { GridCell, LayoutPlan } from "@freebirdai/core";
import { useFreeBird } from "./useFreeBird.js";

export interface UseLayoutReturn {
  plan: ComputedRef<LayoutPlan | null>;
  setPlan: (p: LayoutPlan | null) => void;
  lockedCells: ComputedRef<GridCell[]>;
  unlockedCells: ComputedRef<GridCell[]>;
  toggleLock: (instanceId: string) => void;
  lockAll: () => void;
  unlockAll: () => void;
  removeCell: (instanceId: string) => void;
}

export const useLayout = (): UseLayoutReturn => {
  const fb = useFreeBird();

  const unlockedCells = computed<GridCell[]>(() =>
    fb.layout.value ? fb.layout.value.cells.filter((c) => !c.locked) : [],
  );

  const lockAll = () => {
    const l = fb.layout.value;
    fb.setLayout(
      l ? { ...l, cells: l.cells.map((c) => ({ ...c, locked: true })) } : null,
    );
  };
  const unlockAll = () => {
    const l = fb.layout.value;
    fb.setLayout(
      l ? { ...l, cells: l.cells.map((c) => ({ ...c, locked: false })) } : null,
    );
  };
  const removeCell = (instanceId: string) => {
    const l = fb.layout.value;
    fb.setLayout(
      l
        ? { ...l, cells: l.cells.filter((c) => c.instanceId !== instanceId) }
        : null,
    );
  };

  return {
    plan: fb.layout,
    setPlan: fb.setLayout,
    lockedCells: fb.lockedCells,
    unlockedCells,
    toggleLock: fb.toggleLock,
    lockAll,
    unlockAll,
    removeCell,
  };
};
