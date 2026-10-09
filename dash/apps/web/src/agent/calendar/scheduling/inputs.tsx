import { useId, useMemo, useState, type ReactNode } from "react";
import { DURATION_UNITS, splitDuration, timeZones, type DurationUnit } from "./model.js";

/**
 * The form inputs scheduling's setup is built from. Each one is labelled by
 * the row it sits in (`FormRow`), so a label and its control are always tied
 * together by id.
 */

/** A labelled row: the label and hint on the left, the control on the right; stacked on a narrow screen. */
export const FormRow = ({
  label,
  hint,
  children,
  aside,
  wide,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: (id: string) => ReactNode;
  /** Beside the label: "Default: 30 min". */
  readonly aside?: ReactNode;
  /** The label above and the control across the whole row, for controls too wide to sit beside it. */
  readonly wide?: boolean;
}): JSX.Element => {
  const id = useId();
  return (
    <div className="dash-sched-row" data-wide={wide ? "true" : undefined}>
      <div className="dash-sched-row__label">
        <label htmlFor={id}>{label}</label>
        {hint && <span className="dash-sched-row__hint">{hint}</span>}
      </div>
      <div className="dash-sched-row__control">
        {children(id)}
        {aside && <span className="dash-sched-row__aside">{aside}</span>}
      </div>
    </div>
  );
};

/** A duration as a number and a unit: "30" "minutes" ↔ "30m". */
export const DurationInput = ({
  id,
  value,
  onChange,
  units = ["m", "h", "d", "w"],
  testId,
}: {
  readonly id?: string;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  readonly units?: readonly DurationUnit[];
  readonly testId?: string;
}): JSX.Element => {
  const split = splitDuration(value);
  const unit = units.includes(split.unit) ? split.unit : units[0]!;
  const amount = units.includes(split.unit) ? split.amount : 0;
  return (
    <span className="dash-sched-duration">
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        className="dash-sched-input dash-sched-input--number"
        value={Number.isFinite(amount) ? amount : 0}
        onChange={(event) => onChange(`${Math.max(0, Math.round(Number(event.target.value) || 0))}${unit}`)}
        {...(testId ? { "data-testid": testId } : {})}
      />
      <select className="dash-sched-input" value={unit} aria-label="Unit" onChange={(event) => onChange(`${amount}${event.target.value}`)}>
        {DURATION_UNITS.filter((one) => units.includes(one.unit)).map((one) => (
          <option key={one.unit} value={one.unit}>
            {one.label}
          </option>
        ))}
      </select>
    </span>
  );
};

export const NumberInput = ({
  id,
  value,
  onChange,
  min,
  max,
  placeholder,
  testId,
}: {
  readonly id?: string;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
  readonly testId?: string;
}): JSX.Element => (
  <input
    id={id}
    type="number"
    className="dash-sched-input dash-sched-input--number"
    value={value ?? ""}
    min={min}
    max={max}
    step={1}
    placeholder={placeholder}
    onChange={(event) => {
      const raw = event.target.value.trim();
      if (raw === "") return onChange(undefined);
      const n = Math.round(Number(raw));
      onChange(Number.isFinite(n) ? Math.min(max ?? n, Math.max(min ?? n, n)) : undefined);
    }}
    {...(testId ? { "data-testid": testId } : {})}
  />
);

export const TextInput = ({
  id,
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
  testId,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: "text" | "email" | "date" | "time";
  readonly maxLength?: number;
  readonly testId?: string;
}): JSX.Element => (
  <input
    id={id}
    type={type}
    className="dash-sched-input"
    value={value}
    placeholder={placeholder}
    maxLength={maxLength}
    onChange={(event) => onChange(event.target.value)}
    {...(testId ? { "data-testid": testId } : {})}
  />
);

/** A time zone, from what this browser knows, with the common ones first. */
export const TimeZoneSelect = ({ id, value, onChange }: { readonly id?: string; readonly value: string; readonly onChange: (zone: string) => void }): JSX.Element => {
  const zones = useMemo(() => timeZones(), []);
  return (
    <select id={id} className="dash-sched-input" value={value} onChange={(event) => onChange(event.target.value)}>
      {!zones.includes(value) && <option value={value}>{value}</option>}
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
};

/** One of the eight series colours, as swatches. */
export const ColorPicker = ({ value, onChange, label }: { readonly value: number; readonly onChange: (color: number) => void; readonly label: string }): JSX.Element => (
  <div className="dash-swatches" role="radiogroup" aria-label={label}>
    {Array.from({ length: 8 }, (_, index) => index + 1).map((color) => (
      <button
        key={color}
        type="button"
        role="radio"
        aria-checked={value === color}
        aria-label={`Colour ${color}`}
        className="dash-swatch"
        data-active={value === color ? "true" : undefined}
        style={{ background: `var(--dash-series-${color})` }}
        onClick={() => onChange(color)}
      />
    ))}
  </div>
);

/**
 * A list of short words as removable chips, with a box to add more. Enter or
 * a comma adds one; pasting a comma-separated list adds them all.
 */
export const ChipsInput = ({
  id,
  values,
  onChange,
  placeholder = "Type and press Enter",
  suggestions,
  testId,
}: {
  readonly id?: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly placeholder?: string;
  readonly suggestions?: readonly string[];
  readonly testId?: string;
}): JSX.Element => {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = (text: string) => {
    const words = text
      .split(/[,\n]/)
      .map((one) => one.trim())
      .filter((one) => one !== "" && !values.includes(one));
    if (words.length > 0) onChange([...values, ...words]);
    setDraft("");
  };
  return (
    <div className="dash-sched-chips" {...(testId ? { "data-testid": testId } : {})}>
      {values.map((value) => (
        <span key={value} className="dash-sched-chip">
          {value}
          <button type="button" className="dash-sched-chip__remove" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((one) => one !== value))}>
            ✕
          </button>
        </span>
      ))}
      <input
        id={id}
        className="dash-sched-chips__input"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        list={suggestions ? listId : undefined}
        onChange={(event) => (event.target.value.includes(",") ? add(event.target.value) : setDraft(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "" && values.length > 0) onChange(values.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((one) => (
            <option key={one} value={one} />
          ))}
        </datalist>
      )}
    </div>
  );
};

/** A section of a setup sheet: a card with a title and what it is for. */
export const SheetSection = ({
  title,
  description,
  children,
  actions,
  testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
}): JSX.Element => (
  <section className="dash-sheet__section dash-sched-section" {...(testId ? { "data-testid": testId } : {})}>
    <header className="dash-sched-section__head">
      <div>
        <h3 className="dash-sched-section__title">{title}</h3>
        {description && <p className="dash-sched-section__desc">{description}</p>}
      </div>
      {actions && <div className="dash-sched-section__actions">{actions}</div>}
    </header>
    <div className="dash-sched-section__body">{children}</div>
  </section>
);
