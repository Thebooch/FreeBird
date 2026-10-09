import { Button } from "@freebirdai/dash-components";
import { useEffect, useRef, useState } from "react";
import { api, type CalendarFeedInfo } from "../../api.js";

/**
 * Your own calendar on your phone: a link a calendar app subscribes to,
 * read-only, refreshed by the app. Only the link's hash is kept, so it is
 * shown once, when made; making another stops the old one.
 */

const dateWords = (at: string): string => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const CalendarFeed = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<CalendarFeedInfo | null | undefined>(undefined);
  const [made, setMade] = useState<{ url: string; webcal: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"make" | "stop" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || feed !== undefined) return;
    void api.calendarFeed().then(
      (held) => setFeed(held.feed),
      (cause) => setFailed(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [open, feed]);

  /* Closes on Escape or a click outside. */
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const run = async (what: "make" | "stop") => {
    setBusy(what);
    setFailed(null);
    try {
      if (what === "make") {
        const next = await api.makeCalendarFeed();
        setFeed(next.feed);
        setMade({ url: next.url, webcal: next.webcal });
        setCopied(false);
      } else {
        await api.stopCalendarFeed();
        setFeed(null);
        setMade(null);
      }
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dash-cal-feed" ref={root}>
      <Button onClick={() => setOpen((held) => !held)} testId="calendar-feed" title="See your calendar on your phone">
        Subscribe
      </Button>
      {open ? (
        <div className="dash-cal-feed__panel" role="dialog" aria-label="Your calendar on your phone">
          <div className="dash-cal-feed__head">
            <strong>Your calendar on your phone</strong>
            <span>Subscribe in Google Calendar, Apple Calendar or Outlook. It shows your own entries and appointments, read-only, and your app keeps it up to date.</span>
          </div>
          {feed === undefined && !failed ? <span className="dash-hint">Loading…</span> : null}
          {made ? (
            <div className="dash-cal-feed__made">
              <input readOnly value={made.url} aria-label="Your calendar link" onFocus={(event) => event.target.select()} />
              <div className="dash-cal-feed__row">
                <Button
                  size="sm"
                  tone="primary"
                  onClick={() =>
                    void navigator.clipboard.writeText(made.url).then(
                      () => setCopied(true),
                      () => undefined,
                    )
                  }
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <a className="dash-btn" data-size="sm" href={made.webcal}>
                  Open in my calendar app
                </a>
              </div>
              <span className="dash-hint">Shown only now. Anyone with it can see your calendar, so keep it to yourself.</span>
            </div>
          ) : feed ? (
            <p className="dash-cal-feed__state">
              You have a link from {dateWords(feed.createdAt)}, working until {dateWords(feed.expiresAt)}. Making a new one shows it here and stops the old one.
            </p>
          ) : feed === null ? (
            <p className="dash-cal-feed__state">You don't have a link yet.</p>
          ) : null}
          {failed ? (
            <span className="dash-hint" role="alert">
              {failed}
            </span>
          ) : null}
          <div className="dash-cal-feed__row dash-cal-feed__foot">
            <Button size="sm" {...(feed ? {} : { tone: "primary" as const })} busy={busy === "make"} onClick={() => void run("make")} testId="calendar-feed-make">
              {feed ? "Make a new link" : "Make my link"}
            </Button>
            {feed ? (
              <Button size="sm" tone="ghost" busy={busy === "stop"} onClick={() => void run("stop")}>
                Stop sharing
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
