import type { Row } from "@freebirdai/dash-runtime";
import type { RowAction } from "../types.js";
import { Menu } from "./Menu.jsx";

/**
 * What can be done to the record behind one row — edit it, act on it,
 * delete it — as a small menu at the row's end.
 *
 * Every list-shaped component draws the same one, so a record can be changed
 * from wherever it is shown, and the host alone decides what each row offers:
 * no actions, no control. It never opens the row: a click or a key press on
 * it stops here, so choosing "Delete" does not also navigate to the record.
 */
export const RowActions = ({
  row,
  actions,
  label,
  testId = "row-actions",
}: {
  readonly row: Row;
  readonly actions: ((row: Row) => readonly RowAction[]) | undefined;
  /** What the row is, for the announced label: "Changes to Maple Court". */
  readonly label?: string;
  readonly testId?: string;
}): JSX.Element | null => {
  if (!actions) return null;
  const offered = actions(row);
  if (offered.length === 0) return null;
  return (
    <span
      className="dash-row-actions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Menu
        floating
        label={label ? `Changes to ${label}` : "Change this record"}
        testId={testId}
        items={offered.map((action, index) => ({
          id: action.id,
          label: action.label,
          onSelect: action.onSelect,
          ...(action.icon ? { icon: action.icon } : {}),
          ...(action.tone ? { tone: action.tone } : {}),
          // The one that cannot be taken back sits apart from the rest.
          ...(action.tone === "danger" && index > 0 ? { separated: true } : {}),
        }))}
      />
    </span>
  );
};
