import { settingBool } from "@freebirdai/dash-spec";
import { seriesVar } from "../palette.js";
import { Message } from "../ui/index.js";
import { makeFormatter, roleColumn } from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";
import { funnelStages } from "./collectionModel.js";

/**
 * Stages narrowing toward an outcome.
 *
 * The bar is measured against the first stage and the percentage against the
 * previous one, because those answer different questions — how much of the
 * intake reached here, and how much of the last step survived. Showing one
 * while labelling it the other is the usual way a funnel misleads, so both are
 * on screen and each says which it is.
 */
export const Funnel = (props: WidgetRenderProps): JSX.Element => {
  const stageColumn = roleColumn(props.roles, "stage");
  const valueColumn = roleColumn(props.roles, "value");

  const look = props.presentation;
  const showDropOff = settingBool(look, "showDropOff", true);
  const format = makeFormatter(props, valueColumn);

  if (!stageColumn || !valueColumn) {
    return <Message>This widget needs a stage field and a value field.</Message>;
  }
  if (props.rows.length === 0) return <Message>Nothing to show for this time range.</Message>;

  const stages = funnelStages(props.rows, stageColumn, valueColumn);

  return (
    <div className="dash-funnel" data-density={look?.density ?? "cozy"}>
      {stages.map((stage, index) => (
        <div className="dash-funnel__stage" key={`${stage.label}-${index}`}>
          <div className="dash-funnel__head">
            <span className="dash-funnel__label" title={stage.label}>
              {stage.label}
            </span>
            <span className="dash-funnel__value">{format(stage.value)}</span>
          </div>

          <div className="dash-funnel__track">
            <div
              className="dash-funnel__bar"
              style={{
                width: `${Math.min(100, Math.max(0, stage.ofFirst * 100))}%`,
                // One hue down the whole funnel: the stages are steps in a
                // sequence, not separate categories, so giving each its own
                // colour would imply a distinction that is not there.
                background: seriesVar(1),
              }}
            />
          </div>

          {showDropOff && stage.ofPrevious !== null && (
            <div className="dash-funnel__drop">
              {/*
               * A stage bigger than the one before it happens in real data —
               * a record entering late — so it is reported rather than
               * clamped into a shape that would be a lie.
               */}
              {stage.dropped !== null && stage.dropped > 0
                ? `${Math.round(stage.ofPrevious * 100)}% of the step before · ${format(stage.dropped)} lost`
                : `${Math.round(stage.ofPrevious * 100)}% of the step before`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
