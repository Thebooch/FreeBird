import { useState } from "react";
import type { DashboardSpec } from "@freebirdai/dash-spec";
import { groupOf, groupWidgets, setGroupDisplay, ungroupWidget } from "./editing.js";

/**
 * Which widgets are shown together, and how.
 *
 * Grouping used to be something only a setup could decide: two widgets built
 * in one breath arrived in a frame and stayed there for good. There was no way
 * to take one out, add a third, or change how they sat — the schema supported
 * all three and nothing offered them, so the only fix for a frame you did not
 * want was deleting both widgets.
 *
 * One panel for all three, because they are one question — *what is this shown
 * with?* — and splitting them across menu items would have made the answer
 * depend on which widget you happened to open it from.
 */

const DISPLAYS = [
  { id: "tabs" as const, label: "One at a time", help: "Behind a strip. Both are read either way." },
  { id: "row" as const, label: "Side by side", help: "Both at once. Narrow screens stack them." },
  { id: "stack" as const, label: "One above the other", help: "In one frame, full width each." },
];

export const FramePanel = ({
  dashboard,
  widgetId,
  onSave,
  onClose,
}: {
  readonly dashboard: DashboardSpec;
  readonly widgetId: string;
  readonly onSave: (next: DashboardSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const widget = dashboard.widgets.find((one) => one.id === widgetId);
  const frame = groupOf(dashboard, widgetId);
  const members = frame
    ? dashboard.layout.cells.filter((cell) => cell.group === frame.id).map((cell) => cell.widgetId)
    : [];
  const others = dashboard.widgets.filter(
    (one) => one.id !== widgetId && !members.includes(one.id),
  );

  const apply = (next: DashboardSpec): void => {
    setBusy(true);
    setError(null);
    void onSave(next)
      .then(onClose)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "That change could not be saved."),
      )
      .finally(() => setBusy(false));
  };

  const titleFor = (ids: readonly string[]): string =>
    ids
      .map((id) => dashboard.widgets.find((one) => one.id === id)?.title ?? id)
      .join(" and ")
      .slice(0, 120);

  return (
    <div className="dash-sheet" role="dialog" aria-label="Shown with" data-testid="frame-panel">
      <div className="dash-sheet__head">
        <h3>Shown with “{widget?.title ?? widgetId}”</h3>
        <button type="button" className="dash-iconbtn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {error && <p className="dash-callout dash-callout--bad">{error}</p>}

      {frame ? (
        <>
          <p className="dash-hint">
            In a frame with{" "}
            {members
              .filter((id) => id !== widgetId)
              .map((id) => dashboard.widgets.find((one) => one.id === id)?.title ?? id)
              .join(", ")}
            .
          </p>

          <section className="dash-sheet__section">
            <h4 className="dash-sheet__sub">How they sit</h4>
            {DISPLAYS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="dash-control"
                disabled={busy}
                data-on={frame.display === option.id}
                data-testid={`frame-${option.id}`}
                onClick={() => apply(setGroupDisplay(dashboard, frame.id, option.id))}
              >
                {option.label}
                <span className="dash-hint"> — {option.help}</span>
              </button>
            ))}
          </section>

          <button
            type="button"
            className="dash-control"
            disabled={busy}
            data-testid="frame-leave"
            onClick={() => apply(ungroupWidget(dashboard, widgetId))}
          >
            Take it out of the frame
          </button>
          {members.length <= 2 && (
            <p className="dash-hint">
              The other one goes back to being an ordinary tile: a frame holds two or more.
            </p>
          )}
        </>
      ) : others.length === 0 ? (
        <p className="dash-hint">There is nothing else on this tab to show it with.</p>
      ) : (
        <section className="dash-sheet__section">
          <h4 className="dash-sheet__sub">Show it with</h4>
          <p className="dash-hint">
            They stay two widgets — two datasets, two refresh clocks — drawn in one frame.
          </p>
          {others.map((one) => (
            <button
              key={one.id}
              type="button"
              className="dash-control"
              disabled={busy}
              data-testid={`frame-with-${one.id}`}
              onClick={() =>
                apply(
                  groupWidgets(dashboard, [widgetId, one.id], {
                    title: titleFor([widgetId, one.id]),
                  }),
                )
              }
            >
              {one.title}
            </button>
          ))}
        </section>
      )}
    </div>
  );
};
