import { Button } from "@freebirdai/dash-components";
import { BOOKING_EVENTS, BOOKING_EVENT_WORDS, WORKFLOW_EVERY, describeCron, type WorkflowInputDef, type WorkflowTrigger } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api, type ConnectionSummary } from "../../api";
import type { Entities } from "../entities.js";
import { TRIGGER_CHOICES, blankTrigger } from "./draft.js";

/**
 * The editing pieces the workflow editor and the step panel share: a record
 * type picker, a trigger, an agent trigger's inputs, and field/value pairs.
 */

const EVERY_LABEL: Readonly<Record<(typeof WORKFLOW_EVERY)[number], string>> = {
  "5m": "every 5 minutes",
  "15m": "every 15 minutes",
  "1h": "every hour",
  "6h": "every 6 hours",
  "1d": "every day",
};

export const RecordPicker = ({
  connection,
  record,
  connections,
  entities,
  loadEntities,
  onChange,
  allowNone,
}: {
  connection: string;
  record: string;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
  onChange: (next: { connection: string; record: string }) => void;
  allowNone?: string;
}): JSX.Element => (
  <div className="dash-reach__add">
    <select
      aria-label="Connection"
      value={connection}
      onChange={(event) => {
        if (event.target.value) loadEntities(event.target.value);
        onChange({ connection: event.target.value, record: "" });
      }}
    >
      <option value="">{allowNone ?? "Pick a connection"}</option>
      {connections.map((one) => (
        <option key={one.id} value={one.id}>
          {one.title}
        </option>
      ))}
    </select>
    <select
      aria-label="Record type"
      value={record}
      disabled={!connection}
      onFocus={() => connection && loadEntities(connection)}
      onChange={(event) => onChange({ connection, record: event.target.value })}
    >
      <option value="">Pick a record type</option>
      {(entities[connection] ?? []).map((one) => (
        <option key={one.entity} value={one.entity}>
          {one.name}
        </option>
      ))}
      {record && !(entities[connection] ?? []).some((one) => one.entity === record) && <option value={record}>{record}</option>}
    </select>
  </div>
);

export const InputsEditor = ({ inputs, onChange }: { inputs: readonly WorkflowInputDef[]; onChange: (next: WorkflowInputDef[]) => void }): JSX.Element => (
  <div className="dash-tools">
    <span className="dash-hint">
      What the agent asks the person for before it can start this. Steps read each one as {"{{ input.name }}"}.
    </span>
    {inputs.map((one, index) => (
      <div key={index} className="dash-reach__add">
        <input
          className="dash-tool__when dash-workflow__short"
          aria-label="Input name"
          placeholder="name"
          value={one.name}
          onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, name: event.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : each)))}
        />
        <input
          className="dash-tool__when"
          aria-label="What to ask for"
          placeholder="What to ask for, e.g. Which unit is moving out"
          value={one.description}
          onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, description: event.target.value } : each)))}
        />
        <label className="dash-reach__check">
          <input
            type="checkbox"
            checked={one.required}
            onChange={(event) => onChange(inputs.map((each, at) => (at === index ? { ...each, required: event.target.checked } : each)))}
          />
          Required
        </label>
        <button type="button" className="dash-reach__remove" aria-label="Remove this input" onClick={() => onChange(inputs.filter((_, at) => at !== index))}>
          ✕
        </button>
      </div>
    ))}
    <div>
      <Button size="sm" disabled={inputs.length >= 12} onClick={() => onChange([...inputs, { name: "", description: "", required: true }])}>
        Add input
      </Button>
    </div>
  </div>
);

export const TriggerEditor = ({
  trigger,
  onChange,
  connections,
  entities,
  loadEntities,
}: {
  trigger: WorkflowTrigger;
  onChange: (next: WorkflowTrigger) => void;
  connections: readonly ConnectionSummary[];
  entities: Entities;
  loadEntities: (connection: string) => void;
}): JSX.Element => (
  <div className="dash-tools" data-testid="workflow-trigger">
    <select aria-label="Trigger" value={trigger.kind} onChange={(event) => onChange(blankTrigger(event.target.value as WorkflowTrigger["kind"], trigger))}>
      {TRIGGER_CHOICES.map((one) => (
        <option key={one.kind} value={one.kind}>
          {one.label}
        </option>
      ))}
    </select>
    {(trigger.kind === "record_created" || trigger.kind === "record_changed") && (
      <>
        <RecordPicker
          connection={trigger.connection}
          record={trigger.record}
          connections={connections}
          entities={entities}
          loadEntities={loadEntities}
          onChange={(where) => onChange({ ...trigger, ...where })}
        />
        {trigger.kind === "record_changed" && (
          <input
            className="dash-tool__when"
            aria-label="Fields to watch"
            placeholder="Fields to watch, comma separated (leave empty for any change)"
            value={(trigger.fields ?? []).join(", ")}
            onChange={(event) => {
              const fields = event.target.value.split(",").map((one) => one.trim()).filter(Boolean);
              const { fields: _old, ...rest } = trigger;
              onChange(fields.length > 0 ? { ...rest, fields } : rest);
            }}
          />
        )}
        <label className="dash-hint">
          Checked{" "}
          <select aria-label="How often to check" value={trigger.every} onChange={(event) => onChange({ ...trigger, every: event.target.value as typeof trigger.every })}>
            {WORKFLOW_EVERY.map((one) => (
              <option key={one} value={one}>
                {EVERY_LABEL[one]}
              </option>
            ))}
          </select>
          . The first check only takes note of what is already there.
        </label>
      </>
    )}
    {trigger.kind === "schedule" && (
      <>
        <div className="dash-reach__add">
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Schedule"
            value={trigger.cron}
            onChange={(event) => onChange({ ...trigger, cron: event.target.value })}
            placeholder="0 7 * * 1-5"
          />
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Time zone"
            value={trigger.timezone}
            onChange={(event) => onChange({ ...trigger, timezone: event.target.value })}
            placeholder="America/Chicago"
          />
        </div>
        <span className="dash-hint">
          {describeCron(trigger.cron)}. Minute, hour, day of month, month, day of week, in the time zone beside it.
        </span>
      </>
    )}
    {trigger.kind === "every" && (
      <select aria-label="How often" value={trigger.every} onChange={(event) => onChange({ ...trigger, every: event.target.value as typeof trigger.every })}>
        {WORKFLOW_EVERY.map((one) => (
          <option key={one} value={one}>
            {EVERY_LABEL[one]}
          </option>
        ))}
      </select>
    )}
    {trigger.kind === "agent" && <InputsEditor inputs={trigger.inputs} onChange={(inputs) => onChange({ ...trigger, inputs })} />}
    {trigger.kind === "agent" && (
      <span className="dash-hint">Give an agent a “Run a workflow” tool for this on its Tools tab. That tool decides whether it starts on its own or asks the team.</span>
    )}
    {trigger.kind === "manual" && <span className="dash-hint">Runs when someone presses Run now.</span>}
    {trigger.kind === "booking" && <BookingTriggerEditor trigger={trigger} onChange={onChange} />}
  </div>
);

/** Which booking events start it, for which appointment types, and whether cancelling the booking ends it. */
const BookingTriggerEditor = ({
  trigger,
  onChange,
}: {
  trigger: Extract<WorkflowTrigger, { kind: "booking" }>;
  onChange: (next: WorkflowTrigger) => void;
}): JSX.Element => {
  const [types, setTypes] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api.scheduling().then((setup) => setTypes(setup.types.map((one) => ({ id: one.id, name: one.name }))), () => undefined);
  }, []);
  const toggle = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);
  return (
    <>
      <fieldset className="dash-trigger-group">
        <legend className="dash-trigger-group__title">When a booking</legend>
        <div className="dash-trigger-checks">
          {BOOKING_EVENTS.map((event) => (
            <label key={event} className="dash-trigger-check">
              <input
                type="checkbox"
                checked={trigger.events.includes(event)}
                onChange={() => {
                  const events = toggle(trigger.events, event);
                  if (events.length > 0) onChange({ ...trigger, events });
                }}
              />
              {BOOKING_EVENT_WORDS[event]}
            </label>
          ))}
        </div>
        {trigger.events.includes("turned_away") && (
          <span className="dash-hint">
            Turned away: someone a type's Who can book rules don't take, once a day per person and type. There's no booking, so its steps read the person, the type and their answers (contact, type, request, answersText, reason, viaWords), and steps that change a booking don't apply.
          </span>
        )}
      </fieldset>
      <fieldset className="dash-trigger-group">
        <legend className="dash-trigger-group__title">For</legend>
        {types.length === 0 ? (
          <span className="dash-hint">Every appointment type. Add types on the Calendar's Appointment types tab.</span>
        ) : (
          <div className="dash-trigger-checks">
            <label className="dash-trigger-check">
              <input type="checkbox" checked={trigger.types.length === 0} onChange={() => onChange({ ...trigger, types: [] })} />
              Every type
            </label>
            {types.map((type) => (
              <label key={type.id} className="dash-trigger-check">
                <input type="checkbox" checked={trigger.types.includes(type.id)} onChange={() => onChange({ ...trigger, types: toggle(trigger.types, type.id) })} />
                {type.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="dash-trigger-check">
        <input type="checkbox" checked={trigger.endWhenCancelled} onChange={(event) => onChange({ ...trigger, endWhenCancelled: event.target.checked })} />
        Stop when the booking is cancelled
      </label>
      <span className="dash-hint">Steps read the booking as {"{{ when }}"}, {"{{ contact.name }}"}, {"{{ type.name }}"} and {"{{ link }}"}.</span>
    </>
  );
};

/** Fields to set on a record: path and value, each value a template. */
export const ValuesEditor = ({ values, onChange }: { values: Record<string, string>; onChange: (next: Record<string, string>) => void }): JSX.Element => {
  const pairs = Object.entries(values);
  return (
    <div className="dash-tools">
      {pairs.map(([field, value], index) => (
        <div key={index} className="dash-reach__add">
          <input
            className="dash-tool__when dash-workflow__short"
            aria-label="Field"
            placeholder="field"
            value={field}
            onChange={(event) => onChange(Object.fromEntries(pairs.map(([f, v], at) => (at === index ? [event.target.value, v] : [f, v]))))}
          />
          <input
            className="dash-tool__when"
            aria-label="Value"
            placeholder="value, or {{ a field of the row }}"
            value={value}
            onChange={(event) => onChange(Object.fromEntries(pairs.map(([f, v], at) => (at === index ? [f, event.target.value] : [f, v]))))}
          />
          <button type="button" className="dash-reach__remove" aria-label="Remove this field" onClick={() => onChange(Object.fromEntries(pairs.filter((_, at) => at !== index)))}>
            ✕
          </button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange({ ...values, [pairs.some(([f]) => f === "") ? `field${pairs.length + 1}` : ""]: "" })}>
          Add a field
        </Button>
      </div>
    </div>
  );
};

