import { Badge, Button, Checkbox } from "@freebirdai/dash-components";
import type { WriteReviewView } from "@freebirdai/dash-spec";
import { useState } from "react";

/**
 * The change, as it will be sent, for a person to say yes to.
 *
 * The same review whether the change was asked for by a form or by the
 * assistant, because it is the same object: the server built it, read the
 * record for it, and holds its digest. What is shown here is what will be
 * sent — every changed value before and after, anything that may be cleared,
 * and whether it can be undone.
 *
 * A change that cannot be undone asks for one more deliberate act than the
 * others. A confirmation card people have learned to click through is not
 * protection for a delete.
 */

export interface WriteReviewProps {
  readonly review: WriteReviewView;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Go back and change the values. Absent where there were none to change. */
  readonly onEdit?: (() => void) | undefined;
  readonly busy?: boolean;
  /** Why the last attempt failed, in the API's own words where it gave any. */
  readonly error?: string | undefined;
  readonly detail?: string | undefined;
  /** Where it is being shown, for a narrower layout in the chat column. */
  readonly compact?: boolean;
  /** This review can no longer be sent — it was, or the API refused it. */
  readonly confirmDisabled?: boolean;
}

const confirmLabel = (review: WriteReviewView): string => {
  if (review.kind === "delete") return `Delete from ${review.connectionTitle}`;
  if (review.kind === "action") return review.title;
  if (review.mode === "create" || review.mode === "upsert:create") return `Create on ${review.connectionTitle}`;
  return `Save to ${review.connectionTitle}`;
};

export const WriteReview = ({
  review,
  onConfirm,
  onCancel,
  onEdit,
  busy = false,
  error,
  detail,
  compact = false,
  confirmDisabled = false,
}: WriteReviewProps): JSX.Element => {
  const [understood, setUnderstood] = useState(false);
  const [showKept, setShowKept] = useState(false);
  const changed = review.rows.filter((row) => row.changed);
  const kept = review.rows.filter((row) => !row.changed);
  const blocked = review.danger && !understood;

  return (
    <div className="dash-write-review" data-compact={compact ? "true" : undefined} data-testid="write-review">
      <p className="dash-write-review__summary">{review.summary}</p>
      <div className="dash-row" style={{ gap: 6 }}>
        {review.danger && <Badge tone="danger">Cannot be undone</Badge>}
        {review.unverified && <Badge tone="warn">First use</Badge>}
        {review.inferred && <Badge tone="warn">From documentation prose</Badge>}
      </div>

      {changed.length > 0 && (
        <table className="dash-write-review__diff" data-testid="write-review-rows">
          <thead>
            <tr>
              <th scope="col">Field</th>
              {review.mode !== "create" && review.mode !== "upsert:create" && <th scope="col">Now</th>}
              <th scope="col">{review.mode === "create" || review.mode === "upsert:create" ? "Value" : "After"}</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((row) => (
              <tr key={row.field}>
                <th scope="row">{row.label}</th>
                {review.mode !== "create" && review.mode !== "upsert:create" && (
                  <td className="dash-write-review__before">{row.before ?? "—"}</td>
                )}
                <td className="dash-write-review__after">{row.after ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kept.length > 0 && (
        <p className="dash-hint">
          {kept.length} other value{kept.length === 1 ? " is" : "s are"} sent back as {kept.length === 1 ? "it is" : "they are"}.{" "}
          <button type="button" className="dash-linkish" onClick={() => setShowKept((open) => !open)}>
            {showKept ? "Hide" : "Show"}
          </button>
          {showKept && (
            <span className="dash-write-review__kept">
              {kept.map((row) => `${row.label}: ${row.after ?? "—"}`).join(" · ")}
            </span>
          )}
        </p>
      )}

      {review.warnings.map((warning) => (
        <div key={warning} className="dash-callout dash-callout--info" role="note">
          {warning}
        </div>
      ))}
      {error && (
        <div className="dash-callout dash-callout--bad" role="alert" data-testid="write-review-error">
          {error}
          {detail && <div className="dash-write-review__detail">{detail}</div>}
        </div>
      )}

      {review.danger && (
        <Checkbox
          checked={understood}
          onChange={setUnderstood}
          label="I understand this cannot be undone here."
          testId="write-review-understood"
        />
      )}
      <div className="dash-row dash-row--end" style={{ marginTop: 10 }}>
        {onEdit && (
          <Button tone="ghost" onClick={onEdit} disabled={busy} testId="write-review-edit">
            Change values
          </Button>
        )}
        <Button onClick={onCancel} disabled={busy} testId="write-review-cancel">
          Cancel
        </Button>
        <Button
          tone={review.danger ? "danger" : "primary"}
          onClick={onConfirm}
          busy={busy}
          disabled={blocked || confirmDisabled}
          testId="write-review-confirm"
        >
          {confirmLabel(review)}
        </Button>
      </div>
    </div>
  );
};
