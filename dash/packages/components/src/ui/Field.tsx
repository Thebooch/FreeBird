import { useId, type ReactNode } from "react";

/**
 * Form units.
 *
 * Every one of these ties its label to its control with a generated id rather
 * than relying on the caller to pass a unique one. A widget can appear twice
 * on a board, so any id a component hard-codes is a duplicate waiting to
 * happen — and a duplicate id silently breaks the label association, which is
 * invisible until somebody uses a screen reader.
 */

export const Field = ({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string) => ReactNode;
}): JSX.Element => {
  const id = useId();
  return (
    <div className="dash-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="dash-hint">{hint}</p>}
    </div>
  );
};

export const SearchInput = ({
  value,
  onChange,
  placeholder = "Search",
  label = "Search",
  testId,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly label?: string;
  readonly testId?: string;
}): JSX.Element => (
  <span className="dash-search">
    <span className="dash-search__icon" aria-hidden="true">
      ⌕
    </span>
    <input
      type="search"
      className="dash-search__input"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
      {...(testId ? { "data-testid": testId } : {})}
    />
    {value.length > 0 && (
      <button
        type="button"
        className="dash-search__clear"
        aria-label="Clear search"
        onClick={() => onChange("")}
      >
        <span aria-hidden="true">✕</span>
      </button>
    )}
  </span>
);

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export const Select = ({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly testId?: string;
}): JSX.Element => (
  <select
    className="dash-control"
    value={value}
    aria-label={label}
    onChange={(event) => onChange(event.target.value)}
    {...(testId ? { "data-testid": testId } : {})}
  >
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);

export const Checkbox = ({
  checked,
  onChange,
  label,
  meta,
  disabled,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly meta?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}): JSX.Element => (
  <label className="dash-check" data-disabled={disabled ? "true" : undefined}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      {...(testId ? { "data-testid": testId } : {})}
    />
    <span className="dash-check__text">
      <span className="dash-check__name">{label}</span>
      {meta && <span className="dash-check__meta">{meta}</span>}
    </span>
  </label>
);
