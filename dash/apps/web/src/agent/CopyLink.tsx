import { Button } from "@freebirdai/dash-components";
import { useEffect, useRef, useState } from "react";

/**
 * Makes a link and copies it. A link is minted each time (only its hash is
 * kept, so it can't be read back), so the button says when it was copied;
 * where the clipboard isn't allowed, the link is shown to copy by hand.
 */
export const CopyLink = ({
  label,
  make,
  tone,
  size = "sm",
  testId,
}: {
  readonly label: string;
  readonly make: () => Promise<string>;
  readonly tone?: "primary" | "ghost";
  readonly size?: "sm" | "md";
  readonly testId?: string;
}): JSX.Element => {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await make();
      try {
        await navigator.clipboard.writeText(url);
        setShown(null);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2400);
      } catch {
        setShown(url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="dash-copylink">
      <Button size={size} {...(tone ? { tone } : {})} busy={busy} onClick={() => void run()} {...(testId ? { testId } : {})}>
        {copied ? "Link copied" : label}
      </Button>
      {copied ? (
        <span className="dash-copylink__done" role="status">
          On your clipboard
        </span>
      ) : null}
      {shown ? (
        <input className="dash-copylink__field" readOnly value={shown} aria-label="The link, to copy" autoFocus onFocus={(event) => event.target.select()} />
      ) : null}
      {error ? (
        <span className="dash-copylink__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
};
