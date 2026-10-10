import type { PendingAction } from "@freebirdai/core";
import { Button } from "@freebirdai/dash-components";
import { DASH_SCREENS, type DashScreen } from "@freebirdai/dash-spec";
import { useState } from "react";

/**
 * What the chat proposes, for the person to approve: guide's preview of the
 * pending action (`pending.preview`: a title, a line, and rows), drawn as a
 * card. A row whose value reads "before → after" shows the old value quiet
 * and the new one plain, so a change reads at a glance. Nothing happens until
 * Approve; Cancel drops it.
 */

const SCREEN_TITLES: Readonly<Record<DashScreen, string>> = {
  calendar: "Calendar",
  bookings: "Bookings",
  types: "Appointment types",
  blocks: "Blocks",
  people: "People & pools",
  settings: "Scheduling settings",
  contacts: "Contacts",
  contactFields: "Contact fields",
};

/** The screen a component id is, in words, or null for the dashboard's own. */
const screenTitle = (componentId: string): string | null => {
  const found = (Object.keys(DASH_SCREENS) as DashScreen[]).find((key) => DASH_SCREENS[key].id === componentId);
  return found ? SCREEN_TITLES[found] : null;
};

/** "a → b" as its two sides, when it is one change; otherwise the value as it is. */
export const sidesOf = (value: string): { readonly before: string; readonly after: string } | null => {
  const parts = value.split(" → ");
  return parts.length === 2 && parts[0]!.trim() && parts[1]!.trim() ? { before: parts[0]!, after: parts[1]! } : null;
};

export const ChatActionCard = ({
  pending,
  executing,
  fallbackSummary,
  onApprove,
  onCancel,
}: {
  readonly pending: PendingAction;
  readonly executing: boolean;
  /** The line to show when the action brings no preview of its own. */
  readonly fallbackSummary?: string | undefined;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
}): JSX.Element => {
  const preview = pending.preview;
  const where = screenTitle(pending.componentId);
  const title = preview?.title ?? pending.label ?? pending.actionId.replace(/_/g, " ");
  const rows = preview?.rows ?? [];
  const summary = preview?.summary || fallbackSummary;
  return (
    <section className="dash-action-card" aria-label={`Approve: ${title}`} data-testid="chat-confirm">
      <header className="dash-action-card__head">
        <span className="dash-action-card__eyebrow">
          <span className="dash-action-card__dot" aria-hidden="true" />
          Needs your approval
        </span>
        {where && <span className="dash-action-card__where">{where}</span>}
      </header>
      <h3 className="dash-action-card__title">{title}</h3>
      {summary && <p className="dash-action-card__summary">{summary}</p>}
      {rows.length > 0 && (
        <dl className="dash-action-card__rows">
          {rows.map((row, index) => {
            const sides = sidesOf(row.value);
            return (
              <div key={`${row.label}-${index}`} className="dash-action-card__row" data-multiline={row.multiline ? "true" : undefined}>
                <dt className="dash-action-card__label">{row.label}</dt>
                <dd className="dash-action-card__value">
                  {sides ? (
                    <>
                      <span className="dash-action-card__before">{sides.before}</span>
                      <span className="dash-action-card__arrow" aria-label="becomes">
                        →
                      </span>
                      <span className="dash-action-card__after">{sides.after}</span>
                    </>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <footer className="dash-action-card__actions">
        <Button onClick={onCancel} disabled={executing} testId="chat-confirm-cancel">
          Cancel
        </Button>
        <Button tone="primary" onClick={onApprove} busy={executing} disabled={executing} testId="chat-confirm-apply">
          {executing ? "Applying…" : "Approve"}
        </Button>
      </footer>
    </section>
  );
};

/**
 * A value the chat hands over once and keeps nowhere — a link that is itself
 * a key. Shown here until dismissed, with a way to copy it; gone on reload.
 */
export const OnceCard = ({ title, values, onDismiss }: { readonly title: string; readonly values: Readonly<Record<string, string>>; readonly onDismiss: () => void }): JSX.Element => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(key),
      () => setCopied(null),
    );
  };
  return (
    <section className="dash-once" aria-label={title} data-testid="chat-once">
      <header className="dash-once__head">
        <h3 className="dash-once__title">{title}</h3>
        <button type="button" className="dash-once__close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </header>
      <p className="dash-once__note">Shown once and not kept in the conversation. Copy it now.</p>
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="dash-once__row">
          <input className="dash-once__value" readOnly value={value} onFocus={(event) => event.currentTarget.select()} aria-label={key === "link" ? "Link" : key} />
          <Button size="sm" tone={copied === key ? "default" : "primary"} onClick={() => copy(key, value)} testId={`chat-once-copy-${key}`}>
            {copied === key ? "Copied" : "Copy"}
          </Button>
        </div>
      ))}
    </section>
  );
};
