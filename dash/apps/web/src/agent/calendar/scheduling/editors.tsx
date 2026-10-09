import { WEEKDAYS, minutesOf, type Consolidation, type PartialSettings, type ResolvedSettings, type SchedulingSettings, type SettingsLayer, type WeeklyHours } from "@freebirdai/dash-spec";
import { Button } from "@freebirdai/dash-components";
import { Segmented, Switch } from "../controls.jsx";
import { ChipsInput, DurationInput, FormRow, NumberInput } from "./inputs.jsx";
import { APPROVAL_WORDS, DAY_LABELS, FACT_SUGGESTIONS, LAYER_WORDS, SETTING_META, settingWords } from "./model.js";
import { RuleBuilder } from "./RuleBuilder.jsx";

/* ── settings, layer by layer ──────────────────────────────────────────── */

/**
 * The settings one layer may change, each beside what it would be without
 * this layer and where that comes from ("Default: 30 min, from workspace
 * settings"). A setting this layer does not change is shown greyed with its
 * inherited value and a "Change" button; a changed one has "Use default".
 */
export const SettingsEditor = ({
  keys,
  value,
  inherited,
  onChange,
  fields = [],
}: {
  readonly keys: readonly (keyof SchedulingSettings)[];
  readonly value: PartialSettings;
  readonly inherited: { readonly settings: ResolvedSettings; readonly from: Readonly<Record<keyof SchedulingSettings, SettingsLayer>> };
  readonly onChange: (value: PartialSettings) => void;
  readonly fields?: ReadonlyArray<{ readonly path: string; readonly label: string }>;
}): JSX.Element => {
  const set = (key: keyof SchedulingSettings, next: unknown) => {
    const copy: Record<string, unknown> = { ...value };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy as PartialSettings);
  };
  const paths = [...fields.map((one) => one.path), ...FACT_SUGGESTIONS.map((one) => one.path)];

  return (
    <div className="dash-sched-settings">
      {keys.map((key) => {
        const meta = SETTING_META[key];
        const own = (value as Record<string, unknown>)[key];
        const changed = own !== undefined;
        const base = (inherited.settings as Record<string, unknown>)[key];
        const current = changed ? own : base;
        if (key === "approvalWhen" && (value.approval ?? inherited.settings.approval) !== "rules") return null;
        if (key === "stackOnlySame" && ((value.capacity ?? inherited.settings.capacity) ?? 1) <= 1) return null;
        const aside = changed ? (
          <button type="button" className="dash-sched-link" onClick={() => set(key, undefined)}>
            Use default ({settingWords(key, base)})
          </button>
        ) : (
          <span className="dash-hint">From {LAYER_WORDS[inherited.from[key]]}</span>
        );
        return (
          <FormRow key={key} label={meta.label} {...(meta.hint ? { hint: meta.hint } : {})} aside={aside}>
            {(id) => (
              <div className="dash-sched-setting" data-inherited={changed ? undefined : "true"} data-testid={`setting-${key}`}>
                {meta.kind === "duration" && <DurationInput id={id} value={current as string} onChange={(next) => set(key, next)} />}
                {meta.kind === "step" && (
                  <select id={id} className="dash-sched-input" value={current as string} onChange={(event) => set(key, event.target.value)}>
                    {["5m", "10m", "15m", "20m", "30m", "45m", "60m", "90m", "120m"].map((step) => (
                      <option key={step} value={step}>
                        {step.replace("m", " min")}
                      </option>
                    ))}
                  </select>
                )}
                {meta.kind === "number" && (
                  <NumberInput
                    id={id}
                    value={current as number | undefined}
                    {...(meta.min !== undefined ? { min: meta.min } : {})}
                    {...(meta.max !== undefined ? { max: meta.max } : {})}
                    {...(key === "maxPerDay" ? { placeholder: "No limit" } : {})}
                    onChange={(next) => set(key, next === undefined ? (key === "maxPerDay" ? null : undefined) : next)}
                  />
                )}
                {meta.kind === "approval" && (
                  <Segmented
                    label={meta.label}
                    value={current as SchedulingSettings["approval"]}
                    options={(["none", "always", "rules"] as const).map((mode) => ({ value: mode, label: APPROVAL_WORDS[mode] }))}
                    onChange={(next) => set(key, next)}
                  />
                )}
                {meta.kind === "switch" && <Switch checked={Boolean(current)} onChange={(next) => set(key, next)} label={current ? "Yes" : "No"} />}
                {meta.kind === "fields" && <ChipsInput id={id} values={(current as string[]) ?? []} suggestions={paths} placeholder="contact.address" onChange={(next) => set(key, next)} />}
                {meta.kind === "rules" && <RuleBuilder value={(current as SchedulingSettings["approvalWhen"]) ?? { all: [], any: [] }} fields={fields} onChange={(next) => set(key, next)} />}
                {meta.kind === "consolidate" && (
                  <ConsolidationEditor value={current as Consolidation | undefined} paths={paths} onChange={(next) => set(key, next === undefined ? null : next)} />
                )}
              </div>
            )}
          </FormRow>
        );
      })}
    </div>
  );
};

/* ── consolidation ─────────────────────────────────────────────────────── */

/**
 * Off, or on: which fields an appointment must share to be grouped with
 * another, whether grouped means the same time (stacked) or touching with
 * no buffer (back to back), and whether only those times are shown.
 */
export const ConsolidationEditor = ({
  value,
  paths,
  onChange,
}: {
  readonly value: Consolidation | undefined;
  readonly paths: readonly string[];
  readonly onChange: (value: Consolidation | undefined) => void;
}): JSX.Element => (
  <div className="dash-sched-consolidate">
    <Switch
      checked={value !== undefined}
      onChange={(on) => onChange(on ? { by: ["contact.address"], mode: "back_to_back", show: "only" } : undefined)}
      label={value ? "On" : "Off"}
      hint="Offer times that group appointments sharing a field."
      testId="consolidate-switch"
    />
    {value && (
      <div className="dash-sched-consolidate__body">
        <div className="dash-sched-consolidate__line">
          <span className="dash-sched-consolidate__label">Group by</span>
          <ChipsInput values={value.by} suggestions={paths} onChange={(by) => by.length > 0 && onChange({ ...value, by: by.slice(0, 5) })} />
        </div>
        <div className="dash-sched-consolidate__line">
          <span className="dash-sched-consolidate__label">As</span>
          <Segmented
            label="How appointments are grouped"
            value={value.mode}
            options={[
              { value: "back_to_back", label: "Back to back", hint: "Touching a matching appointment, with no buffer between" },
              { value: "stack", label: "Stacked", hint: "At the same time as a matching appointment (needs more than one at a time)" },
            ]}
            onChange={(mode) => onChange({ ...value, mode })}
          />
        </div>
        <div className="dash-sched-consolidate__line">
          <span className="dash-sched-consolidate__label">Show</span>
          <Segmented
            label="Which times are shown"
            value={value.show}
            options={[
              { value: "only", label: "Only grouped times", hint: "With a small button to see the rest" },
              { value: "first", label: "Grouped times first" },
            ]}
            onChange={(show) => onChange({ ...value, show })}
          />
        </div>
      </div>
    )}
  </div>
);

/* ── working hours ─────────────────────────────────────────────────────── */

/**
 * A week of hours: each day on or off, with one or more ranges. Ranges that
 * overlap or run backwards are flagged as they are typed, before saving.
 */
export const HoursEditor = ({ value, onChange, testId }: { readonly value: WeeklyHours; readonly onChange: (hours: WeeklyHours) => void; readonly testId?: string }): JSX.Element => {
  const setDay = (day: (typeof WEEKDAYS)[number], ranges: WeeklyHours[typeof day]) => onChange({ ...value, [day]: ranges });
  return (
    <div className="dash-sched-hours" {...(testId ? { "data-testid": testId } : {})}>
      {WEEKDAYS.map((day) => {
        const ranges = value[day];
        const sorted = [...ranges].sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
        const wrong = ranges.some((range) => minutesOf(range.from) >= minutesOf(range.to)) || sorted.some((range, index) => index > 0 && minutesOf(range.from) < minutesOf(sorted[index - 1]!.to));
        return (
          <div key={day} className="dash-sched-hours__day" data-off={ranges.length === 0 ? "true" : undefined}>
            <Switch checked={ranges.length > 0} onChange={(on) => setDay(day, on ? [{ from: "09:00", to: "17:00" }] : [])} label={DAY_LABELS[day]} />
            <div className="dash-sched-hours__ranges">
              {ranges.length === 0 ? (
                <span className="dash-hint">Unavailable</span>
              ) : (
                ranges.map((range, index) => (
                  <span key={index} className="dash-sched-hours__range">
                    <input
                      type="time"
                      className="dash-sched-input"
                      value={range.from}
                      aria-label={`${DAY_LABELS[day]} from`}
                      onChange={(event) => setDay(day, ranges.map((one, at) => (at === index ? { ...one, from: event.target.value || one.from } : one)))}
                    />
                    <span className="dash-hint">to</span>
                    <input
                      type="time"
                      className="dash-sched-input"
                      value={range.to === "24:00" ? "23:59" : range.to}
                      aria-label={`${DAY_LABELS[day]} to`}
                      onChange={(event) => setDay(day, ranges.map((one, at) => (at === index ? { ...one, to: event.target.value || one.to } : one)))}
                    />
                    <button type="button" className="dash-sched-rule__remove" aria-label="Remove these hours" onClick={() => setDay(day, ranges.filter((_, at) => at !== index))}>
                      ✕
                    </button>
                  </span>
                ))
              )}
              {wrong && <span className="dash-sched-error">Ranges must run forwards and not overlap.</span>}
            </div>
            {ranges.length > 0 && ranges.length < 8 && (
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  const last = ranges.at(-1)!;
                  const start = Math.min(minutesOf(last.to) + 60, 23 * 60);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  setDay(day, [...ranges, { from: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`, to: `${pad(Math.min(Math.floor(start / 60) + 1, 23))}:${pad(start % 60 === 0 ? 0 : 59)}` }]);
                }}
              >
                + Hours
              </Button>
            )}
          </div>
        );
      })}
      <div className="dash-sched-hours__foot">
        <button
          type="button"
          className="dash-sched-link"
          disabled={WEEKDAYS.slice(1, 5).every((day) => JSON.stringify(value[day]) === JSON.stringify(value.mon))}
          onClick={() => onChange(Object.fromEntries(WEEKDAYS.map((each) => [each, ["sat", "sun"].includes(each) ? value[each] : value.mon])) as WeeklyHours)}
        >
          Use Monday's hours Tuesday to Friday
        </button>
      </div>
    </div>
  );
};
