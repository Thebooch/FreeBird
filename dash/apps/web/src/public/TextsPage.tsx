import { useEffect, useMemo, useState } from "react";
import { textsApi, type TextsPage as Page } from "./api.js";
import { Alert, Button, Field, Loading, Shell, Unavailable } from "./ui.jsx";

/**
 * A workspace's text pages (`/p/<workspace>/texts`, `/privacy`, `/terms`):
 * the opt-in form registration reviewers look at, with its consent box
 * unticked and apart from anything else, and the privacy section and
 * messaging terms it links to. Ticking the box is the only way it signs
 * anyone up, and what is kept is the exact sentence beside it.
 */
export const TextsPage = ({ workspace, page }: { readonly workspace: string; readonly page: "opt-in" | "privacy" | "terms" }) => {
  const api = useMemo(() => textsApi(workspace), [workspace]);
  const [content, setContent] = useState<Page | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  /* Never shown: only a script fills it in. */
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.page().then(setContent, (error: unknown) => setFailure(error instanceof Error ? error.message : "This page can't be opened."));
  }, [api]);

  if (failure) {
    return (
      <Shell brand={null} width="narrow">
        <Unavailable title="There's nothing here" message={failure} />
      </Shell>
    );
  }
  if (!content) {
    return (
      <Shell brand={null}>
        <Loading />
      </Shell>
    );
  }

  const base = `/p/${encodeURIComponent(workspace)}/texts`;
  const sections = page === "privacy" ? content.privacy : page === "terms" ? content.terms : null;
  if (sections) {
    return (
      <Shell brand={content.workspace} width="narrow">
        <article className="pub-card pub-texts" data-testid={`texts-${page}`}>
          <h1>{page === "privacy" ? `${content.business}: privacy and text messages` : `${content.business}: messaging terms`}</h1>
          {sections.map((one) => (
            <section key={one.heading}>
              <h2>{one.heading}</h2>
              <p>{one.text}</p>
            </section>
          ))}
          <p className="pub-muted">
            <a href={base}>Sign up for texts</a> · <a href={`${base}/${page === "privacy" ? "terms" : "privacy"}`}>{page === "privacy" ? "Messaging terms" : "Privacy"}</a>
          </p>
        </article>
      </Shell>
    );
  }

  const submit = async () => {
    if (!agreed) {
      setProblem("Tick the box to agree to texts.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.optIn({ name: name.trim(), phone: phone.trim(), consent: true, website });
      setDone(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That couldn't be sent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell brand={content.workspace} width="narrow">
      <div className="pub-card pub-texts" data-testid="texts-opt-in">
        <h1>Texts from {content.business}</h1>
        {done ? (
          <Alert tone="success" title="You're signed up">
            Reply STOP to any text to stop them, or HELP for help.
          </Alert>
        ) : (
          <form
            className="pub-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Your name" optional htmlFor="texts-name">
              <input id="texts-name" className="pub-input" autoComplete="name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Mobile number" htmlFor="texts-phone">
              <input id="texts-phone" className="pub-input" type="tel" autoComplete="tel" value={phone} maxLength={40} onChange={(event) => setPhone(event.target.value)} required />
            </Field>
            <label className="pub-check" htmlFor="texts-agree">
              <input id="texts-agree" type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
              <span>{content.wording}</span>
            </label>
            <div className="pub-trap" aria-hidden="true">
              <label htmlFor="texts-website">Leave this empty</label>
              <input id="texts-website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
            </div>
            {problem ? <Alert tone="danger">{problem}</Alert> : null}
            <div className="pub-row" data-justify="end">
              <Button tone="primary" type="submit" busy={busy}>
                Sign up for texts
              </Button>
            </div>
          </form>
        )}
        <p className="pub-muted">
          <a href={`${base}/privacy`}>Privacy</a> · <a href={`${base}/terms`}>Messaging terms</a>
        </p>
      </div>
    </Shell>
  );
};
