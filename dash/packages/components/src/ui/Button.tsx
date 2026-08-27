import type { ReactNode } from "react";

/**
 * The one button.
 *
 * Every component that needed a control was hand-rolling `<button className=
 * "dash-control">`, which is fine until one of them wants a disabled state or
 * a busy state and only that one gets it. A single unit means a fix lands
 * everywhere, and it is the thing a customisation can actually target.
 */

export type ButtonTone = "default" | "primary" | "ghost" | "danger";
export type ControlSize = "sm" | "md";

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly tone?: ButtonTone;
  readonly size?: ControlSize;
  readonly disabled?: boolean;
  /** Renders a spinner and blocks the click without changing the width. */
  readonly busy?: boolean;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly type?: "button" | "submit";
  readonly testId?: string;
}

export const Button = ({
  children,
  onClick,
  tone = "default",
  size = "md",
  disabled,
  busy,
  title,
  ariaLabel,
  type = "button",
  testId,
}: ButtonProps): JSX.Element => (
  <button
    type={type}
    className="dash-btn"
    data-tone={tone}
    data-size={size}
    // A busy control is disabled in fact; saying so in markup is what stops a
    // second click landing while the first is still in flight.
    disabled={disabled || busy}
    aria-busy={busy ? true : undefined}
    onClick={onClick}
    {...(title ? { title } : {})}
    {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    {...(testId ? { "data-testid": testId } : {})}
  >
    {busy && <span className="dash-btn__spinner" aria-hidden="true" />}
    {children}
  </button>
);

export interface IconButtonProps {
  /** A glyph. Always paired with a label, never the only channel. */
  readonly children: ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
  readonly tone?: ButtonTone;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly testId?: string;
  readonly onBlur?: () => void;
}

export const IconButton = ({
  children,
  label,
  onClick,
  tone = "ghost",
  disabled,
  pressed,
  testId,
  onBlur,
}: IconButtonProps): JSX.Element => (
  <button
    type="button"
    className="dash-iconbtn"
    data-tone={tone}
    // The glyph carries no meaning to a screen reader, so the label is the
    // accessible name and the tooltip both.
    title={label}
    aria-label={label}
    aria-pressed={pressed === undefined ? undefined : pressed}
    disabled={disabled}
    onClick={onClick}
    {...(onBlur ? { onBlur } : {})}
    {...(testId ? { "data-testid": testId } : {})}
  >
    <span aria-hidden="true">{children}</span>
  </button>
);
