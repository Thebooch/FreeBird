import { Button } from "@freebirdai/dash-components";
import { useEffect, useState, type ReactNode } from "react";

/**
 * The sheet every setup editor opens in: a title over a trail, sections down
 * the middle, and Save, Cancel and (for something that exists) Remove at the
 * foot. Saving shows its own progress and the server's words when it is
 * refused, so a person always knows why.
 */
export const SetupSheet = ({
  trail,
  title,
  onClose,
  onSave,
  onRemove,
  removeLabel = "Remove",
  saveLabel = "Save",
  children,
  testId,
  wide,
}: {
  readonly trail: string;
  readonly title: string;
  readonly onClose: () => void;
  /** Resolves when saved; throws to show why not. */
  readonly onSave: () => Promise<void>;
  readonly onRemove?: () => Promise<void>;
  readonly removeLabel?: string;
  readonly saveLabel?: string;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly wide?: boolean;
}): JSX.Element => {
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const run = async (what: "save" | "remove", action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dash-sheet-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <form
        className="dash-sheet dash-sched-sheet"
        data-wide={wide ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void run("save", onSave);
        }}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <header className="dash-sheet__head">
          <div className="dash-sheet__trail">{trail}</div>
          <div className="dash-sheet__bar">
            <h2 className="dash-sheet__title">{title}</h2>
            <Button tone="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <div className="dash-sheet__body">{children}</div>
        <footer className="dash-cal-sheet__foot">
          <div className="dash-cal-sheet__foot-group">
            {onRemove &&
              (confirming ? (
                <>
                  <span className="dash-hint">{removeLabel} for good?</span>
                  <Button tone="danger" busy={busy === "remove"} onClick={() => void run("remove", onRemove)}>
                    {removeLabel}
                  </Button>
                  <Button tone="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button tone="danger" onClick={() => setConfirming(true)}>
                  {removeLabel}
                </Button>
              ))}
          </div>
          <div className="dash-cal-sheet__foot-group">
            {error && (
              <span className="dash-sched-error" role="alert">
                {error}
              </span>
            )}
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" type="submit" busy={busy === "save"} testId="setup-save">
              {saveLabel}
            </Button>
          </div>
        </footer>
      </form>
    </div>
  );
};
