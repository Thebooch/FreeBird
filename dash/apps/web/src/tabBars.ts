/**
 * Several tab bars on the Dash side: some people keep a bar of tabs built only
 * to be sent as reports, apart from the ones they work in.
 *
 * A tab says which bar it sits on (`bar`, absent for the first). The bars
 * shown are every bar that holds a tab, in order, and one empty bar after
 * them, which is where a new bar starts: add a tab there and it becomes a bar
 * like the others, with a new empty one after it. The ↑ arrow moves toward
 * the empty bar, ↓ back toward the first.
 */

export interface BarTab {
  readonly id: string;
  readonly bar?: number | undefined;
}

export const barOf = (tab: BarTab): number => tab.bar ?? 0;

/** The bars to step through: each that holds a tab, then the empty one. */
export const barsOf = (tabs: readonly BarTab[]): number[] => {
  const used = [...new Set(tabs.map(barOf))].sort((a, b) => a - b);
  return [...used, used.length > 0 ? used[used.length - 1]! + 1 : 0];
};

/** The bar one step up (toward the empty bar) or down; the same bar at either end. */
export const stepBar = (bars: readonly number[], current: number, direction: 1 | -1): number => {
  const index = bars.indexOf(current);
  if (index < 0) return bars[0] ?? 0;
  return bars[index + direction] ?? current;
};

/** The bar to show: the open tab's, else the first. */
export const barFor = (tabs: readonly BarTab[], activeId: string | null): number => {
  const active = tabs.find((tab) => tab.id === activeId);
  return active ? barOf(active) : (barsOf(tabs)[0] ?? 0);
};
