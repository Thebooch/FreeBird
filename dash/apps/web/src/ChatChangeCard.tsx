import { Button } from "@freebirdai/dash-components";
import { WriteReview } from "@freebirdai/dash-react";
import type { WriteReviewView } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { writesApi } from "./writes.js";

/**
 * The assistant's proposed change, shown the way a form's is.
 *
 * The chat's own confirmation card says "Apply this change?", which is fine
 * for renaming a tab and not for changing somebody's account. This shows the
 * server's review of the change instead — the same one a form gets — and
 * Apply is not offered until that review is on screen: the assistant's
 * proposal reaches the browser before the server has finished reading the
 * record, and a yes given before then would be a yes to nothing in particular.
 */

export const CHANGE_ACTIONS = new Set(["change_record", "remove_record"]);

export interface ChatChangeCardProps {
  readonly args: Readonly<Record<string, unknown>>;
  readonly onApply: () => Promise<unknown> | void;
  readonly onCancel: () => Promise<unknown> | void;
}

export const ChatChangeCard = ({ args, onApply, onCancel }: ChatChangeCardProps): JSX.Element => {
  const pendingId = typeof args["pendingWriteId"] === "string" ? args["pendingWriteId"] : undefined;
  const digest = typeof args["digest"] === "string" ? args["digest"] : undefined;
  const [review, setReview] = useState<WriteReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReview(null);
    setError(null);
    if (!pendingId) return;
    let cancelled = false;
    writesApi
      .review(pendingId)
      .then((loaded) => {
        if (cancelled) return;
        // The card approves the digest the harness carries; a review that differs is not this one.
        if (digest && loaded.digest !== digest) setError("This change moved since it was proposed. Ask again.");
        else setReview(loaded);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [pendingId, digest]);

  if (error) {
    return (
      <div className="dash-callout dash-callout--bad" data-testid="chat-change-error">
        {error}
        <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
          <Button size="sm" onClick={() => void onCancel()}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  if (!review) {
    return (
      <div className="dash-callout" data-testid="chat-change-preparing">
        Preparing the change — reading the record as it is now.
        <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
          <Button size="sm" onClick={() => void onCancel()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="dash-callout" data-testid="chat-change-card">
      <strong>{review.title}</strong>
      <WriteReview
        review={review}
        compact
        busy={busy}
        onCancel={() => void onCancel()}
        onConfirm={() => {
          setBusy(true);
          void Promise.resolve(onApply()).finally(() => setBusy(false));
        }}
      />
    </div>
  );
};
