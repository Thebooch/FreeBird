import type { ReactNode } from "react";
import { Button } from "./Button.jsx";
import { Icon, type IconName } from "./Icon.jsx";

/**
 * The states a widget lands in when there is no chart to draw.
 *
 * Kept as units because each one is a different sentence to a person: nothing
 * matched, something broke, or the binding no longer fits. Collapsing them
 * into one grey box is precisely the failure this product exists to avoid.
 */

/** A centred line of prose. The plainest of the three. */
export const Message = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <div className="dash-message">{children}</div>
);

export const EmptyState = ({
  title,
  body,
  icon,
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly icon?: IconName;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}): JSX.Element => (
  <div className="dash-state">
    {icon && (
      <span className="dash-state__glyph" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
    )}
    <p className="dash-state__title">{title}</p>
    {body && <p className="dash-state__body">{body}</p>}
    {action && (
      <Button size="sm" onClick={action.onClick}>
        {action.label}
      </Button>
    )}
  </div>
);

export const ErrorState = ({
  message,
  detail,
  onRetry,
  retryLabel = "Try again",
}: {
  readonly message: string;
  /** Specifics worth showing but not worth leading with. */
  readonly detail?: readonly string[];
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}): JSX.Element => (
  <div className="dash-state" data-tone="error" role="alert">
    {/*
     * A mark of its own, so a failure does not look like an empty result.
     *
     * The two states are a click apart and lead to opposite next steps —
     * "nothing matched your filter" and "the upstream refused us" — and
     * before this they were the same grey box with different words in it.
     */}
    <span className="dash-state__glyph" aria-hidden="true">
      <Icon name="alert" size={20} />
    </span>
    <p className="dash-state__title">{message}</p>
    {detail && detail.length > 0 && (
      <ul className="dash-state__detail">
        {detail.slice(0, 3).map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    )}
    {onRetry && (
      <Button size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    )}
  </div>
);
