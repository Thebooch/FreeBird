import { Button } from "@freebirdai/dash-components";
import {
  BUSINESS_TYPES,
  OPT_IN_METHODS,
  REGISTRATION_STEPS,
  REGISTRATION_STEP_WORDS,
  TIMELINE_WORDS,
  type CampaignUse,
  type PhoneLineView,
  type RegistrationDraftView,
  type RegistrationProblem,
  type RegistrationStep,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { FormRow, SheetSection, TextInput } from "../agent/calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../agent/calendar/scheduling/SetupSheet.jsx";
import { itemAttrs, openChat, screenAttrs, useChatFocus, useChatScreen } from "../agent/chatScreen.js";

/**
 * Text registration (A2P 10DLC), in six short screens. It asks only for what
 * Dash cannot know, drafts the rest from the workspace, and refuses to
 * submit what would fail a known check. Everything saves as it is typed
 * (the EIN on its own, sealed as soon as it is given), so leaving loses
 * nothing. Every step ends with "Need further explanation? Ask the chat",
 * which opens the chat already focused on the step and the field.
 */

const BUSINESS_TYPE_WORDS: Readonly<Record<(typeof BUSINESS_TYPES)[number], string>> = {
  llc: "LLC",
  corporation: "Corporation",
  partnership: "Partnership",
  nonprofit: "Nonprofit",
  sole_proprietor: "Sole proprietor (no EIN)",
};

const OPT_IN_WORDS: Readonly<Record<(typeof OPT_IN_METHODS)[number], string>> = {
  website_form: "A form on our website",
  booking_page: "The booking page's text box",
  in_person: "In person",
  keyword: "Texting a keyword",
  imported: "A list we had before, with proof",
};

const SAVE_AFTER_MS = 600;

type Draft = RegistrationDraftView;

export const RegistrationWizard = ({ line, onClose, onChanged }: { readonly line: PhoneLineView; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uses, setUses] = useState<ReadonlyArray<CampaignUse & { suggested?: string }>>([]);
  const [showAllUses, setShowAllUses] = useState(false);
  const [problems, setProblems] = useState<readonly RegistrationProblem[] | null>(null);
  const [ein, setEin] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saving" | "saved" | null>(null);
  const [explained, setExplained] = useState<Record<string, { sentence: string; field?: string }>>({});
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);

  useChatScreen(["textRegistration"]);
  /* The chat knows the line, the step and the field the person was last in. */
  useChatFocus("textRegistration", draft ? { id: line.id, label: `${line.number ?? line.title} · ${REGISTRATION_STEP_WORDS[draft.step]}${draft.field ? ` · ${draft.field}` : ""}` } : null);

  useEffect(() => {
    void api.registration(line.id).then(
      (found) => {
        setDraft(found);
        /* Reopened on the check step: run the checks for it. */
        if (found.step === "check") void api.checkRegistration(line.id).then((answer) => setProblems(answer.problems), () => setProblems([]));
      },
      (cause: unknown) => setNote(String(cause instanceof Error ? cause.message : cause)),
    );
    void api.registrationUses(line.id).then((answer) => setUses(answer.uses), () => setUses([]));
  }, [line.id]);

  /* Autosave: what changed, a moment after the last keystroke. */
  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setSaved("saving");
    try {
      setDraft(await api.saveRegistration(line.id, patch));
      setSaved("saved");
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
      setSaved(null);
    }
  }, [line.id]);
  useEffect(() => () => void flush(), [flush]);
  /* Leaving the wizard puts sheets back over the whole page. */
  useEffect(() => () => document.documentElement.removeAttribute("data-sheet-beside-chat"), []);

  const change = (section: "business" | "contact" | "campaign" | "optIn" | "confirmed", key: string, value: unknown) => {
    setDraft((held) => (held ? ({ ...held, field: key, [section]: { ...(held[section] as object), [key]: value } } as Draft) : held));
    const current = (pending.current[section] as Record<string, unknown> | undefined) ?? {};
    pending.current = { ...pending.current, [section]: { ...current, [key]: value }, field: key };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  const goTo = (step: RegistrationStep, field?: string) => {
    pending.current = { ...pending.current, step, ...(field ? { field } : {}) };
    setDraft((held) => (held ? { ...held, step, ...(field ? { field } : {}) } : held));
    void flush();
    if (step === "check") void api.checkRegistration(line.id).then((answer) => setProblems(answer.problems), () => setProblems(null));
  };

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try {
      await action();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
      /* A refused submit says which checks failed: show them on step 5. */
      if (what === "submit") void api.checkRegistration(line.id).then((answer) => setProblems(answer.problems), () => undefined);
    } finally {
      setBusy(null);
    }
  };

  if (!draft) {
    return (
      <SetupSheet trail="Communications · Phone" title="Text registration" onClose={onClose} onSave={async () => onClose()}>
        <p className="dash-hint">{note ?? "Loading…"}</p>
      </SetupSheet>
    );
  }

  const b = draft.business;
  const c = draft.campaign;
  const step = draft.step;
  const sole = b.businessType === "sole_proprietor";
  const index = REGISTRATION_STEPS.indexOf(step);
  const submitted = Boolean(draft.submitted.brand) && draft.submitted.brandState !== "rejected";
  const shownUses = showAllUses ? uses : uses.filter((one) => one.suggested).length > 0 ? uses.filter((one) => one.suggested || one.id === c.use) : uses;

  const text = (section: "business" | "contact" | "campaign" | "optIn", key: string, label: string, hint?: string, value = String(((draft[section] as unknown) as Record<string, unknown>)[key] ?? "")) => (
    <FormRow label={label} {...(hint ? { hint } : {})}>
      {(id) => (
        <span {...itemAttrs(key)}>
          <TextInput id={id} value={value} onChange={(next) => change(section, key, next)} testId={`reg-${key}`} />
        </span>
      )}
    </FormRow>
  );

  const ask = (
    <p className="dash-reg-ask">
      Need further explanation?{" "}
      <button
        type="button"
        className="dash-link"
        onClick={() => {
          /* The wizard moves aside so the chat shows beside it, already focused on this step and field. */
          document.documentElement.setAttribute("data-sheet-beside-chat", "true");
          openChat();
        }}
        data-testid="reg-ask-chat"
      >
        Ask the chat
      </button>
    </p>
  );

  const body: Record<RegistrationStep, JSX.Element> = {
    business: (
      <SheetSection title="1. Your business" description="Exactly as the IRS has it: carriers match the legal name to the EIN character for character.">
        {text("business", "legalName", "Legal business name", "As on the IRS letter (CP 575 or 147C).")}
        <FormRow label="Business type">
          {(id) => (
            <select id={id} className="dash-sched-input" value={b.businessType ?? ""} onChange={(event) => change("business", "businessType", event.target.value || undefined)} data-testid="reg-businessType">
              <option value="">Choose…</option>
              {BUSINESS_TYPES.map((one) => (
                <option key={one} value={one}>
                  {BUSINESS_TYPE_WORDS[one]}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        {sole ? (
          <p className="dash-hint">A sole proprietor registers with the owner's own details and an identity check instead of an EIN. It is limited to one campaign and a lower volume of texts.</p>
        ) : (
          <FormRow label="EIN" hint={b.ein ? `On file: ${b.ein}. Sealed, and sent only to the provider.` : "Nine digits. Sealed as soon as it is typed; never shown again in full."}>
            {(id) => (
              <span className="dash-phone-search" {...itemAttrs("ein")}>
                <input id={id} type="password" inputMode="numeric" autoComplete="off" className="dash-sched-input" value={ein} onChange={(event) => setEin(event.target.value)} placeholder={b.ein ?? "12-3456789"} data-testid="reg-ein" />
                <Button size="sm" busy={busy === "ein"} onClick={() => void run("ein", async () => (setDraft(await api.setRegistrationEin(line.id, ein)), setEin("")))} testId="reg-ein-save">
                  Seal
                </Button>
              </span>
            )}
          </FormRow>
        )}
        {text("business", "street", "Street")}
        {text("business", "city", "City")}
        {text("business", "region", "State or province")}
        {text("business", "postalCode", "ZIP or postal code")}
        {text("business", "website", "Website", "On https, showing the same business name. Reviewers open it.")}
        {text("business", "industry", "Industry", "In a word or two, like Home services.")}
      </SheetSection>
    ),
    contact: (
      <SheetSection title="2. Who to contact" description="The person responsible for the texting. The registry may contact them.">
        {text("contact", "name", "Name")}
        {text("contact", "title", "Title")}
        {text("contact", "email", "Email")}
        {text("contact", "phone", "Phone")}
      </SheetSection>
    ),
    campaign: (
      <SheetSection title="3. What you'll text">
        <FormRow label="Campaign use" hint={draft.submitted.brandState === "approved" ? "The registry's list for your business." : "The registry's own list for your business replaces this once it is approved."}>
          {(id) => (
            <span className="dash-reg-uses" id={id} {...itemAttrs("use")}>
              {shownUses.map((one) => (
                <label key={one.id} className="dash-check" data-testid={`reg-use-${one.id}`}>
                  <input type="radio" name="reg-use" checked={c.use === one.id} onChange={() => change("campaign", "use", one.id)} /> {one.title}
                  {one.suggested ? <span className="dash-reg-suggested"> · {one.suggested}</span> : null}
                  {one.extraVetting ? <span className="dash-reg-vetting"> · needs extra vetting</span> : null}
                </label>
              ))}
              {!showAllUses && shownUses.length < uses.length ? (
                <button type="button" className="dash-link" onClick={() => setShowAllUses(true)}>
                  Show every use
                </button>
              ) : null}
            </span>
          )}
        </FormRow>
        <div className="dash-reg-drafted" {...itemAttrs("description")}>
          {c.drafted ? (
            <>
              <p className="dash-hint">Drafted from: {c.drafted.from.join(", ")}</p>
              <p>{c.drafted.description}</p>
              <ol>
                {c.drafted.samples.map((one) => (
                  <li key={one}>{one}</li>
                ))}
              </ol>
              <label className="dash-check">
                <input type="checkbox" checked={c.drafted.accepted} onChange={(event) => void run("use", async () => setDraft(await api.useRegistrationDraft(line.id, event.target.checked)))} data-testid="reg-use-this" /> Use this
              </label>
            </>
          ) : (
            <p className="dash-hint">Dash can draft this from the workflows and agents that already text. With none, write it yourself: who you text, why, and how often.</p>
          )}
          <Button size="sm" busy={busy === "draft"} onClick={() => void run("draft", async () => setDraft(await api.draftRegistrationUse(line.id)))} testId="reg-draft">
            {c.drafted ? "Draft again" : "Draft it for me"}
          </Button>
        </div>
        <FormRow label="Use description" hint="Who you text, why, and how often." wide>
          {(id) => <textarea id={id} className="dash-sched-input" rows={3} value={c.description} onChange={(event) => change("campaign", "description", event.target.value)} data-testid="reg-description" />}
        </FormRow>
        {[0, 1, 2, 3, 4].map((i) => (
          <FormRow key={i} label={`Sample ${i + 1}`} {...(i === 0 ? { hint: "Name the business in one; end one with \"Reply STOP to opt out\". Templated parts in brackets: [first name]." } : {})}>
            {(id) => (
              <TextInput
                id={id}
                value={c.samples[i] ?? ""}
                onChange={(value) => {
                  const samples = [...c.samples];
                  samples[i] = value;
                  change("campaign", "samples", samples.slice(0, Math.max(samples.length, i + 1)).map((one) => one ?? ""));
                }}
                testId={`reg-sample-${i}`}
              />
            )}
          </FormRow>
        ))}
        {text("campaign", "frequency", "How often", "Like: one or two texts per appointment.")}
        <label className="dash-check">
          <input type="checkbox" checked={c.containsLinks === true} onChange={(event) => change("campaign", "containsLinks", event.target.checked)} /> Some texts carry a link (never a link shortener)
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={c.containsPhoneNumbers === true} onChange={(event) => change("campaign", "containsPhoneNumbers", event.target.checked)} /> Some texts carry a phone number
        </label>
      </SheetSection>
    ),
    opt_in: (
      <SheetSection title="4. How people agree" description="The consent box is unticked until they tick it, and separate from agreeing to any terms.">
        <span {...itemAttrs("optInMethods")}>
          {OPT_IN_METHODS.map((one) => (
            <label key={one} className="dash-check">
              <input
                type="checkbox"
                checked={draft.optIn.methods.includes(one)}
                onChange={(event) => change("optIn", "methods", event.target.checked ? [...draft.optIn.methods, one] : draft.optIn.methods.filter((held) => held !== one))}
              />{" "}
              {OPT_IN_WORDS[one]}
            </label>
          ))}
        </span>
        <FormRow label="How they agree" hint="Step by step, as a reviewer would see it." wide>
          {(id) => <textarea id={id} className="dash-sched-input" rows={2} value={draft.optIn.description} onChange={(event) => change("optIn", "description", event.target.value)} data-testid="reg-optInDescription" />}
        </FormRow>
        <label className="dash-check">
          <input type="checkbox" checked={draft.optIn.hosted} onChange={(event) => change("optIn", "hosted", event.target.checked)} data-testid="reg-hosted" /> Use Dash's opt-in page, privacy section and terms
        </label>
        {draft.optIn.hosted ? (
          <p className="dash-hint">
            They are at this workspace's public address. Reviewers check your own site, so we recommend placing the form there too: <code>{"<div data-dash-texts></div>"}</code> with the opt-in script, or the WordPress shortcode <code>[dash_text_optin]</code>.
          </p>
        ) : (
          <>
            {text("optIn", "pageUrl", "Opt-in page", "Dash reads it for an unticked box, apart from the terms.", draft.optIn.pageUrl ?? "")}
            {text("optIn", "privacyUrl", "Privacy policy", "Dash reads it for the clause that mobile numbers are not shared or sold.", draft.optIn.privacyUrl ?? "")}
            {text("optIn", "termsUrl", "Messaging terms", undefined, draft.optIn.termsUrl ?? "")}
          </>
        )}
      </SheetSection>
    ),
    check: (
      <SheetSection title="5. Check and submit" description="Nothing to type. A rejection costs a fee and restarts the wait, so nothing goes until every check passes. The provider sets its fees: see its current pricing page before you submit.">
        {problems === null ? (
          <p className="dash-hint">Checking…</p>
        ) : problems.length === 0 ? (
          <p className="dash-reg-ok">Every check passes.</p>
        ) : (
          <ul className="dash-reg-problems" data-testid="reg-problems">
            {problems.map((one) => (
              <li key={`${one.rule}:${one.field}`}>
                {one.says}{" "}
                <button type="button" className="dash-link" onClick={() => goTo(one.step, one.field)}>
                  Fix this
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="dash-check" {...itemAttrs("confirmed")}>
          <input type="checkbox" checked={draft.confirmed.legalName} onChange={(event) => change("confirmed", "legalName", event.target.checked)} data-testid="reg-confirm-name" /> “{b.legalName || "—"}” is the legal name exactly as on the IRS letter
        </label>
        {!sole && (
          <label className="dash-check">
            <input type="checkbox" checked={draft.confirmed.ein} onChange={(event) => change("confirmed", "ein", event.target.checked)} data-testid="reg-confirm-ein" /> The EIN ending {b.ein ? b.ein.slice(-4) : "—"} is the business's own
          </label>
        )}
        <Button
          tone="primary"
          busy={busy === "submit"}
          disabled={submitted}
          testId="reg-submit"
          onClick={() =>
            void run("submit", async () => {
              await flush();
              setDraft(await api.submitRegistration(line.id));
              onChanged();
            })
          }
        >
          Submit
        </Button>
      </SheetSection>
    ),
    status: (
      <SheetSection
        title="6. Status"
        description="Each change is emailed to the workspace's owners."
        actions={
          <Button size="sm" busy={busy === "refresh"} onClick={() => void run("refresh", async () => (setDraft(await api.refreshRegistration(line.id)), onChanged()))}>
            Check now
          </Button>
        }
      >
        {draft.timeline.length === 0 ? (
          <p className="dash-hint">Nothing submitted yet.</p>
        ) : (
          <ol className="dash-reg-timeline" data-testid="reg-timeline">
            {draft.timeline.map((one, i) => (
              <li key={`${one.event}:${i}`} data-event={one.event}>
                <strong>{TIMELINE_WORDS[one.event]}</strong> · {new Date(one.at).toLocaleString()}
                {one.codes.map((code) => (
                  <div key={code} className="dash-reg-reason">
                    {explained[code] ? (
                      <>
                        {explained[code]!.sentence}{" "}
                        {explained[code]!.field ? (
                          <button type="button" className="dash-link" onClick={() => goTo(fieldStep(explained[code]!.field!), explained[code]!.field)}>
                            Fix this
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <button type="button" className="dash-link" onClick={() => void api.explainRejection(line.id, code).then((help) => setExplained((held) => ({ ...held, [code]: help })))}>
                        Why? (code {code})
                      </button>
                    )}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </SheetSection>
    ),
  };

  return (
    <SetupSheet trail={`Communications · ${line.number ?? line.title}`} title="Text registration" testId="reg-wizard" wide saveLabel="Close" onClose={onClose} onSave={async () => (await flush(), onClose())}>
      <div {...screenAttrs("textRegistration")} {...itemAttrs(line.id)}>
        <nav className="dash-reg-steps" aria-label="Steps">
          {REGISTRATION_STEPS.map((one, i) => (
            <button key={one} type="button" className="dash-reg-step" data-active={one === step ? "true" : undefined} onClick={() => goTo(one)} data-testid={`reg-step-${one}`}>
              {i + 1}. {REGISTRATION_STEP_WORDS[one]}
            </button>
          ))}
        </nav>
        {body[step]}
        <div className="dash-reg-foot">
          {index > 0 ? (
            <Button size="sm" tone="ghost" onClick={() => goTo(REGISTRATION_STEPS[index - 1]!)}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <span className="dash-hint">{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}</span>
          {index < REGISTRATION_STEPS.length - 1 ? (
            <Button size="sm" onClick={() => goTo(REGISTRATION_STEPS[index + 1]!)} testId="reg-next">
              Next
            </Button>
          ) : (
            <span />
          )}
        </div>
        {ask}
        {note && <p className="dash-sched-error">{note}</p>}
      </div>
    </SetupSheet>
  );
};

/** Which step a field lives on. */
const fieldStep = (field: string): RegistrationStep =>
  ["legalName", "ein", "businessType", "street", "city", "region", "postalCode", "website", "industry"].includes(field)
    ? "business"
    : field.startsWith("contact")
      ? "contact"
      : ["use", "description", "samples", "frequency", "containsLinks", "containsPhoneNumbers"].includes(field)
        ? "campaign"
        : ["optIn", "optInMethods", "optInDescription", "pageUrl", "privacyUrl", "termsUrl"].includes(field)
          ? "opt_in"
          : "check";
