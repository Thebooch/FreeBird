import { useRef } from "react";

/**
 * Small pieces the calendar's screens share: a segmented choice and a few
 * line icons drawn in `currentColor`, so they follow the text they sit in.
 */

export const ChevronLeft = (): JSX.Element => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5 5.5 8 10 12.5" />
  </svg>
);

export const ChevronRight = (): JSX.Element => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const Check = (): JSX.Element => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 6.2 5 8.5 9.5 3.5" />
  </svg>
);

/**
 * One choice of several, as a single control.
 *
 * A radio group in the accessibility tree, with arrow keys moving the choice:
 * the same contract as `Tabs`, for choices that change how one thing is
 * shown rather than which thing is shown.
 */
export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly hint?: string }>;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly testId?: string;
}): JSX.Element => {
  const groupRef = useRef<HTMLDivElement>(null);
  const move = (from: number, step: number): void => {
    const next = options[(from + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div className="dash-segmented" role="radiogroup" aria-label={label} ref={groupRef} {...(testId ? { "data-testid": testId } : {})}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="dash-segmented__option"
            data-value={option.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            {...(option.hint ? { title: option.hint } : {})}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

/**
 * On or off, drawn as a switch. A checkbox underneath, with `role="switch"`,
 * so it is announced as what it looks like and works with Space.
 */
export const Switch = ({
  checked,
  onChange,
  label,
  hint,
  disabled,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}): JSX.Element => (
  <label className="dash-switch" data-disabled={disabled ? "true" : undefined}>
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      {...(testId ? { "data-testid": testId } : {})}
    />
    <span className="dash-switch__track" aria-hidden="true" />
    <span className="dash-switch__text">
      <span className="dash-switch__label">{label}</span>
      {hint && <span className="dash-switch__hint">{hint}</span>}
    </span>
  </label>
);
