import { useEffect, useMemo, useState } from "react";
import { typeApi, type TypePage } from "./api.js";
import { browserZone } from "./time.js";
import { Alert, Button, Field, Icon, LOCATION_ICONS, Loading, Shell, Unavailable } from "./ui.jsx";

/**
 * An appointment type's public link (`/p/<workspace>/t/<slug>`).
 *
 * Anyone may open it: it asks who they are, then moves them to their own
 * page, which this browser also remembers (an HttpOnly cookie the server
 * sets), so coming back here shows their booking rather than a blank form.
 */
export const StartPage = ({ workspace, slug }: { readonly workspace: string; readonly slug: string }) => {
  const api = useMemo(() => typeApi(workspace, slug), [workspace, slug]);
  const [page, setPage] = useState<TypePage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  /* Never shown: only a script fills it in. */
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    api.page().then(
      (found) => {
        if (found.personal) window.location.replace(found.personal);
        else setPage(found);
      },
      (error: unknown) => setFailure(error instanceof Error ? error.message : "This page can't be opened."),
    );
  }, [api]);

  if (failure) {
    return (
      <Shell brand={null} width="narrow">
        <Unavailable title="There's no booking page here" message={failure} />
      </Shell>
    );
  }
  if (!page) {
    return (
      <Shell brand={null}>
        <Loading />
      </Shell>
    );
  }

  const submit = async () => {
    if (!name.trim() || !email.trim()) {
      setProblem("Say your name and email address.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const started = await api.start({ name: name.trim(), email: email.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), timezone: browserZone(), website });
      window.location.assign(started.page);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That couldn't be sent. Try again.");
      setBusy(false);
    }
  };

  const { type } = page;
  return (
    <Shell brand={page.workspace} footer="We use these details only to arrange your appointment.">
      <div className="pub-card pub-book">
        <aside className="pub-book__about">
          <div className="pub-stack" data-gap="sm">
            <span className="pub-eyebrow">Book a time</span>
            <h1 className="pub-title">{type.name}</h1>
          </div>
          <ul className="pub-meta">
            <li className="pub-meta__item">
              <Icon name="clock" />
              <span>
                <strong>{type.minutes} min</strong>
              </span>
            </li>
            <li className="pub-meta__item">
              <Icon name={LOCATION_ICONS[type.location.kind] ?? "pin"} />
              <span>{type.location.words}</span>
            </li>
            <li className="pub-meta__item">
              <Icon name={type.approval ? "hourglass" : "check"} />
              <span>{type.approval ? "Requests are confirmed by the team" : "Confirmed as soon as you book"}</span>
            </li>
          </ul>
          {type.description ? <p className="pub-muted pub-book__desc">{type.description}</p> : null}
        </aside>
        <section className="pub-book__work">
          {!page.open ? (
            <Alert tone="info" title="Not open yet">
              This booking page isn't taking requests yet. Please check back soon.
            </Alert>
          ) : (
            <form
              className="pub-form"
              style={{ maxWidth: 480 }}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <ol className="pub-steps" aria-label="Steps">
                <li className="pub-steps__one" data-state="now">
                  <span className="pub-steps__num">1</span>
                  <span>Your details</span>
                </li>
                <li className="pub-steps__one" data-state="next">
                  <span className="pub-steps__sep" aria-hidden="true" />
                  <span className="pub-steps__num">2</span>
                  <span>Pick a time</span>
                </li>
              </ol>
              <div className="pub-stack" data-gap="sm">
                <h2 className="pub-subtitle">First, who's booking?</h2>
                <p className="pub-muted">You'll get a page of your own to see and change your booking.</p>
              </div>
              <Field label="Your name" htmlFor="pub-name">
                <input id="pub-name" className="pub-input" autoComplete="name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="Email address" htmlFor="pub-email">
                <input id="pub-email" className="pub-input" type="email" autoComplete="email" value={email} maxLength={200} onChange={(event) => setEmail(event.target.value)} required />
              </Field>
              <Field label="Phone number" optional htmlFor="pub-phone" hint="Only if you'd like a text or call about it.">
                <input id="pub-phone" className="pub-input" type="tel" autoComplete="tel" value={phone} maxLength={40} onChange={(event) => setPhone(event.target.value)} />
              </Field>
              <div className="pub-trap" aria-hidden="true">
                <label htmlFor="pub-website">Leave this empty</label>
                <input id="pub-website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
              </div>
              {problem ? <Alert tone="danger">{problem}</Alert> : null}
              <div className="pub-row" data-justify="end">
                <Button tone="primary" size="lg" type="submit" busy={busy}>
                  Continue
                  <Icon name="right" size={16} />
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </Shell>
  );
};
