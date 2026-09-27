import { Button, Field } from "@freebirdai/dash-components";
import type { WriteFieldError, WriteFormField } from "@freebirdai/dash-spec";
import { humanLabel } from "@freebirdai/dash-spec";
import { useMemo } from "react";

/**
 * The values a change takes, as a form.
 *
 * Built from the request's own fields — never a hand-written form per record
 * type — so any API whose write endpoints were read gets one. Each input is
 * chosen from what the field declares: a closed set is a picker, a yes/no is
 * a checkbox, a date is a date input, and an id that names another record is
 * a picker over that record type's own list when the host can load one.
 *
 * Pure: it holds no state and sends nothing. The host keeps the values and
 * decides what to do with them, which is always "ask the server for a
 * review" — this form never changes anything by itself.
 */

export type FormValues = Readonly<Record<string, unknown>>;

export interface ReferenceOption {
  readonly value: string;
  readonly label: string;
}

export interface RecordFormProps {
  readonly fields: readonly WriteFormField[];
  readonly values: FormValues;
  readonly onChange: (values: FormValues) => void;
  readonly errors?: readonly WriteFieldError[] | undefined;
  /** Changing something that exists: say which values could not be read. */
  readonly editing?: boolean;
  readonly disabled?: boolean;
  /** Choices for fields that name another record, by record type, when the host has loaded them. */
  readonly references?: Readonly<Record<string, readonly ReferenceOption[]>> | undefined;
}

const ITEM = "[]";

const asText = (value: unknown): string =>
  value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value);

/** Fields a person fills in — not the containers other fields sit inside. */
const inputs = (fields: readonly WriteFormField[]): WriteFormField[] =>
  fields.filter(
    (field) =>
      !(field.type === "object" && fields.some((other) => other.field.startsWith(`${field.field}.`))) &&
      !fields.some((other) => other.field.startsWith(`${field.field}${ITEM}.`)),
  );

const groupOf = (path: string): string => {
  const parts = path.replace(/\[\]/g, "").split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
};

const Input = ({
  field,
  value,
  onChange,
  disabled,
  options,
  id,
}: {
  readonly field: WriteFormField;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled: boolean;
  readonly options: readonly ReferenceOption[] | undefined;
  readonly id: string;
}): JSX.Element => {
  const testId = `write-field-${field.field}`;
  if (field.type === "boolean") {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true || value === "true"}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
        style={{ width: "auto", alignSelf: "flex-start" }}
      />
    );
  }
  const choices: readonly ReferenceOption[] | undefined =
    field.options?.map((option) => ({ value: option, label: humanLabel(option) })) ?? options;
  if (choices && choices.length > 0) {
    const current = asText(value);
    const known = choices.some((choice) => choice.value === current);
    return (
      <select
        id={id}
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        data-testid={testId}
      >
        <option value="">{field.required ? "Choose…" : "—"}</option>
        {!known && current !== "" && <option value={current}>{current}</option>}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  const type =
    field.type === "integer" || field.type === "number"
      ? "number"
      : field.format === "date"
        ? "date"
        : field.format === "date-time"
          ? "datetime-local"
          : field.format === "email"
            ? "email"
            : "text";
  const text = asText(value);
  return (
    <input
      id={id}
      type={type}
      value={type === "date" ? text.slice(0, 10) : type === "datetime-local" ? text.slice(0, 16) : text}
      disabled={disabled}
      step={field.type === "integer" ? 1 : "any"}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      data-testid={testId}
      {...(field.type === "array" ? { placeholder: "Separate values with commas" } : {})}
    />
  );
};

const hintFor = (field: WriteFormField, editing: boolean, value: unknown): string | undefined => {
  if (editing && field.readFrom === null && (value === undefined || value === null || value === "")) {
    return "Its current value could not be read. Left empty, it may be cleared.";
  }
  if (field.type === "array") return "A list — separate values with commas.";
  return undefined;
};

/** A list of records inside the one being made — `Units` on a new property. */
const ItemGroup = ({
  owner,
  fields,
  values,
  onChange,
  disabled,
  references,
  errors,
}: {
  readonly owner: string;
  readonly fields: readonly WriteFormField[];
  readonly values: FormValues;
  readonly onChange: (values: FormValues) => void;
  readonly disabled: boolean;
  readonly references: RecordFormProps["references"];
  readonly errors: readonly WriteFieldError[];
}): JSX.Element => {
  const items = Array.isArray(values[owner]) ? (values[owner] as Record<string, unknown>[]) : [];
  const leaf = (field: WriteFormField) => field.field.slice(owner.length + ITEM.length + 1);
  const set = (next: Record<string, unknown>[]) => onChange({ ...values, [owner]: next });
  return (
    <fieldset className="dash-keyblock" data-testid={`write-group-${owner}`}>
      <legend>{humanLabel(owner)}</legend>
      {items.map((item, index) => (
        <div key={index} className="dash-write-item">
          {fields
            .filter((field) => !fields.some((other) => other.field.startsWith(`${field.field}.`)))
            .map((field) => {
              const path = leaf(field);
              const value = path.split(".").reduce<unknown>(
                (at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined),
                item,
              );
              return (
                <Field key={field.field} label={`${field.label}${field.required ? " *" : ""}`}>
                  {(id) => (
                    <Input
                      id={id}
                      field={field}
                      value={value}
                      disabled={disabled}
                      options={field.references ? references?.[field.references] : undefined}
                      onChange={(next) => {
                        const copy = items.map((one) => ({ ...one }));
                        const parts = path.split(".");
                        let at: Record<string, unknown> = copy[index]!;
                        for (const part of parts.slice(0, -1)) {
                          at[part] = { ...((at[part] as Record<string, unknown>) ?? {}) };
                          at = at[part] as Record<string, unknown>;
                        }
                        at[parts[parts.length - 1]!] = next;
                        set(copy);
                      }}
                    />
                  )}
                </Field>
              );
            })}
          <Button size="sm" tone="ghost" disabled={disabled} onClick={() => set(items.filter((_, i) => i !== index))}>
            Remove this one
          </Button>
        </div>
      ))}
      {errors.length > 0 && <p className="dash-write-error">{errors.map((error) => `${error.label} ${error.message}`).join("; ")}</p>}
      <Button size="sm" disabled={disabled} onClick={() => set([...items, {}])} testId={`write-add-${owner}`}>
        Add {items.length === 0 ? "one" : "another"}
      </Button>
    </fieldset>
  );
};

export const RecordForm = ({
  fields,
  values,
  onChange,
  errors = [],
  editing = false,
  disabled = false,
  references,
}: RecordFormProps): JSX.Element => {
  const shown = useMemo(() => inputs(fields), [fields]);
  const itemOwners = useMemo(
    () => [...new Set(fields.filter((field) => field.field.includes(ITEM)).map((field) => field.field.slice(0, field.field.indexOf(ITEM))))],
    [fields],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, WriteFormField[]>();
    for (const field of shown) {
      if (field.field.includes(ITEM)) continue;
      const group = groupOf(field.field);
      groups.set(group, [...(groups.get(group) ?? []), field]);
    }
    return [...groups];
  }, [shown]);
  const errorFor = (path: string) => errors.find((error) => error.field === path);

  return (
    <div className="dash-write-form" data-testid="write-form">
      {grouped.map(([group, members]) => {
        const body = members.map((field) => {
          const error = errorFor(field.field);
          const hint = hintFor(field, editing, values[field.field]);
          return (
            <Field key={field.field} label={`${field.label}${field.required ? " *" : ""}`} {...(hint ? { hint } : {})}>
              {(id) => (
                <>
                  <Input
                    id={id}
                    field={field}
                    value={values[field.field]}
                    disabled={disabled}
                    options={field.references ? references?.[field.references] : undefined}
                    onChange={(next) => onChange({ ...values, [field.field]: next })}
                  />
                  {error && (
                    <span className="dash-write-error" role="alert">
                      {error.message}
                    </span>
                  )}
                </>
              )}
            </Field>
          );
        });
        return group === "" ? (
          body
        ) : (
          <fieldset key={group} className="dash-keyblock">
            <legend>{humanLabel(group)}</legend>
            {body}
          </fieldset>
        );
      })}
      {itemOwners.map((owner) => (
        <ItemGroup
          key={owner}
          owner={owner}
          fields={fields.filter((field) => field.field.startsWith(`${owner}${ITEM}.`))}
          values={values}
          onChange={onChange}
          disabled={disabled}
          references={references}
          errors={errors.filter((error) => error.field.startsWith(`${owner}${ITEM}`))}
        />
      ))}
    </div>
  );
};

/**
 * The values to send: for a change, only what differs from what the form
 * opened with; for a create, everything given. Sending unchanged values
 * would make every field look edited in the review.
 */
export const changedValues = (
  initial: FormValues,
  values: FormValues,
  creating: boolean,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    if (creating) {
      if (value !== undefined && value !== null && value !== "") out[field] = value;
      continue;
    }
    if (JSON.stringify(value ?? null) !== JSON.stringify(initial[field] ?? null) && asText(value) !== asText(initial[field])) {
      out[field] = value;
    }
  }
  return out;
};
