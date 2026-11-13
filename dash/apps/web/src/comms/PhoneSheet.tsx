import { Button } from "@freebirdai/dash-components";
import { PHONE_TEXT_WORDS, PHONE_VOICE_WORDS, type AgentSpec, type AvailableNumber, type MailboxOwner, type OwnedNumber, type PhoneLineView, type PhoneText } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { api, type PhoneAccount, type PhoneAddressCheck } from "../api.js";
import { FormRow, SheetSection, TextInput } from "../agent/calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../agent/calendar/scheduling/SetupSheet.jsx";

/**
 * Settings → Phone: connect a provider and a number, so a person never opens
 * the provider's console after the first copy-paste.
 *
 * 1. Pick a provider (Twilio is the default).
 * 2. Paste its keys: Dash checks them and names the account.
 * 3. Dash checks that the internet can reach it, before anything is bought.
 * 4. Choose a number: a new one, one already in the account, or a new one
 *    to receive on while people keep dialling the business's own number.
 * 5. Dash points the number's texts at the line; then text it to test.
 * 6. Whose it is: the team's, or one agent's.
 *
 * A new line shows where its texts and calls stand; texting starts when its
 * registration is approved (the registration wizard comes next).
 */

const ownerKey = (owner: MailboxOwner): string => (owner.kind === "team" ? "team" : `agent:${owner.id}`);
const ownerOf = (key: string): MailboxOwner => (key.startsWith("agent:") ? { kind: "agent", id: key.slice(6) } : { kind: "team" });
const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const OwnerSelect = ({ id, value, agents, onChange }: { readonly id: string; readonly value: string; readonly agents: readonly AgentSpec[]; readonly onChange: (key: string) => void }): JSX.Element => (
  <select id={id} className="dash-sched-input" value={value} onChange={(event) => onChange(event.target.value)} data-testid="phone-owner">
    <option value="team">The team's line (Your comms)</option>
    {agents.map((agent) => (
      <option key={agent.id} value={`agent:${agent.id}`}>
        {agent.name}'s own line (Agent comms)
      </option>
    ))}
  </select>
);

/** Where a line's texts and calls stand, as two chips. */
export const LineChips = ({ line }: { readonly line: Pick<PhoneLineView, "text" | "voice"> }): JSX.Element => (
  <span className="dash-comms-line__status">
    <span data-ready={line.text === "approved" ? "true" : undefined}>{PHONE_TEXT_WORDS[line.text]}</span>
    <span data-ready={line.voice === "ready" ? "true" : undefined}>{PHONE_VOICE_WORDS[line.voice]}</span>
  </span>
);

/** A step with a command in it shows the command as code: "Run: <code>", or "… with <code>NAME=value</code>." */
const commandOf = (step: string): JSX.Element | string => {
  const run = /^Run: (.+)$/.exec(step);
  if (run) return <>Run: <code>{run[1]}</code></>;
  const setting = /^(.*?)(DASH_PUBLIC_ORIGIN=\S+?)(\.?)$/.exec(step);
  if (setting) return <>{setting[1]}<code>{setting[2]}</code>{setting[3]}</>;
  return step;
};

const AddressProblem = ({ check, onRetry }: { readonly check: PhoneAddressCheck; readonly onRetry: () => void }): JSX.Element => (
  <div className="dash-phone-address" data-testid="phone-address-problem">
    <p className="dash-sched-error">{check.problem}</p>
    <p className="dash-hint">Phone providers send texts and calls to this server over the internet, so it needs an address they can reach. Nothing is bought until it works. Two ways:</p>
    {(check.fixes ?? []).map((fix) => (
      <div key={fix.title} className="dash-phone-address__fix">
        <strong>{fix.title}</strong>
        <ol>
          {fix.steps.map((step) => (
            <li key={step}>{commandOf(step)}</li>
          ))}
        </ol>
      </div>
    ))}
    <Button size="sm" onClick={onRetry} testId="phone-address-retry">
      Check again
    </Button>
  </div>
);

export const AddPhoneLineSheet = ({ agents, onClose, onAdded }: { readonly agents: readonly AgentSpec[]; readonly onClose: () => void; readonly onAdded: () => void }): JSX.Element => {
  const [accounts, setAccounts] = useState<readonly PhoneAccount[]>([]);
  const [provider, setProvider] = useState("twilio");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [account, setAccount] = useState<{ name: string; trial: boolean } | null>(null);
  const [address, setAddress] = useState<PhoneAddressCheck | null>(null);
  const [choice, setChoice] = useState<"new" | "existing" | "forward">("new");
  const [areaCode, setAreaCode] = useState("");
  const [found, setFound] = useState<readonly AvailableNumber[] | null>(null);
  const [owned, setOwned] = useState<readonly OwnedNumber[] | null>(null);
  const [number, setNumber] = useState("");
  const [businessNumber, setBusinessNumber] = useState("");
  const [owner, setOwner] = useState("team");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [made, setMade] = useState<{ line: PhoneLineView; forwarding?: string[] } | null>(null);
  const [heard, setHeard] = useState<PhoneText | null>(null);

  const chosen = accounts.find((one) => one.id === provider);
  const connected = Boolean(account) || Boolean(chosen?.connected);

  useEffect(() => {
    void api.phoneLines().then(
      (answer) => {
        setAccounts(answer.accounts);
        if (!answer.accounts.some((one) => one.id === "twilio") && answer.accounts[0]) setProvider(answer.accounts[0].id);
      },
      (cause: unknown) => setNote(message(cause)),
    );
  }, []);

  const checkAddress = useCallback(() => {
    setAddress(null);
    void api.checkPhoneAddress().then(setAddress, (cause: unknown) => setAddress({ ok: false, problem: message(cause) }));
  }, []);
  useEffect(() => {
    if (connected && !address) checkAddress();
  }, [connected, address, checkAddress]);

  useEffect(() => {
    if (connected && choice === "existing" && owned === null) void api.ownedPhoneNumbers(provider).then((answer) => setOwned(answer.numbers), (cause: unknown) => setNote(message(cause)));
  }, [connected, choice, owned, provider]);

  /* The test: wait for a text from the person's own phone. */
  useEffect(() => {
    if (!made || heard) return;
    const every = window.setInterval(() => {
      void api.phoneThreads(made.line.id).then((answer) => {
        const inbound = answer.threads.map((one) => one.last).find((one): one is PhoneText => Boolean(one && one.direction === "in"));
        if (inbound) setHeard(inbound);
      }, () => undefined);
    }, 3000);
    return () => window.clearInterval(every);
  }, [made, heard]);

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try {
      await action();
    } catch (cause) {
      setNote(message(cause));
    } finally {
      setBusy(null);
    }
  };

  if (made) {
    return (
      <SetupSheet trail="Communications · Phone" title={made.line.number ?? made.line.title} testId="phone-line-made" saveLabel="Done" onClose={onClose} onSave={async () => onClose()}>
        <SheetSection title="Your line is wired" description="Dash pointed this number's texts at your workspace through the provider. Nothing to type into the provider's console.">
          <LineChips line={made.line} />
          {made.line.text !== "approved" && <p className="dash-hint">Texting starts when the line's text registration (A2P 10DLC) is approved. Replies to people who text you first follow the same rule.</p>}
        </SheetSection>
        {made.forwarding && (
          <SheetSection title="Forward your business number" description={`People keep dialling the number they know: forward its calls to ${made.line.number}.`}>
            <ol className="dash-phone-steps" data-testid="phone-forwarding">
              {made.forwarding.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </SheetSection>
        )}
        <SheetSection title="Test it" description={`Text ${made.line.number} from your own phone. It shows up here, and in Communications, the moment it arrives.`}>
          {heard ? (
            <p className="dash-phone-heard" data-testid="phone-test-heard">
              Got it: “{heard.body}” from {heard.number}. Texts reach Dash.
            </p>
          ) : (
            <p className="dash-hint" data-testid="phone-test-waiting">
              Waiting for your text…
            </p>
          )}
        </SheetSection>
      </SetupSheet>
    );
  }

  return (
    <SetupSheet
      trail="Communications · Phone"
      title="Add a phone line"
      saveLabel="Add and wire it"
      testId="add-phone-line"
      onClose={onClose}
      onSave={async () => {
        if (!connected) throw new Error("Connect the provider's account first.");
        if (!address?.ok) throw new Error("This server can't be reached from the internet yet: fix the address first.");
        if (!number) throw new Error(choice === "existing" ? "Pick a number from the account." : "Search, then pick a number.");
        const result = await api.setUpPhoneLine({ provider, choice, number, owner: ownerOf(owner) });
        setMade(result);
        onAdded();
      }}
    >
      <SheetSection title="1. Provider">
        <div className="dash-phone-providers" role="radiogroup" aria-label="Provider">
          {accounts.map((one) => (
            <button
              key={one.id}
              type="button"
              role="radio"
              aria-checked={provider === one.id}
              className="dash-phone-provider"
              data-default={one.id === "twilio" ? "true" : undefined}
              data-active={provider === one.id ? "true" : undefined}
              onClick={() => {
                setProvider(one.id);
                setAccount(null);
                setKeys({});
                setFound(null);
                setOwned(null);
                setNumber("");
              }}
              data-testid={`phone-provider-${one.id}`}
            >
              <strong>{one.title}</strong>
              <span>{one.connected ? "Connected" : one.id === "twilio" ? "The default: paste two keys, pick a number" : "Use another provider"}</span>
            </button>
          ))}
        </div>
      </SheetSection>

      {chosen && !connected && (
        <SheetSection
          title="2. Keys"
          description={`Copied once from ${chosen.title}. Dash checks them, keeps them in its vault, and never shows them again.`}
          actions={
            <Button size="sm" busy={busy === "keys"} testId="phone-connect" onClick={() => void run("keys", async () => setAccount(await api.connectPhoneAccount(provider, keys)))}>
              Connect
            </Button>
          }
        >
          {chosen.credentials.map((field) => (
            <FormRow key={field.key} label={field.label} hint={field.help}>
              {(id) =>
                field.secret ? (
                  <input id={id} type="password" className="dash-sched-input" value={keys[field.key] ?? ""} onChange={(event) => setKeys({ ...keys, [field.key]: event.target.value })} autoComplete="off" data-testid={`phone-key-${field.key}`} />
                ) : (
                  <TextInput id={id} value={keys[field.key] ?? ""} onChange={(value) => setKeys({ ...keys, [field.key]: value })} testId={`phone-key-${field.key}`} />
                )
              }
            </FormRow>
          ))}
        </SheetSection>
      )}
      {account && (
        <p className="dash-phone-connected" data-testid="phone-connected">
          Connected to {account.name || "your account"}’s {chosen?.title ?? provider}.
          {account.trial ? " It's a trial account: it can only text and call numbers you've verified with the provider until it's upgraded." : ""}
        </p>
      )}

      {connected && address && !address.ok && <AddressProblem check={address} onRetry={checkAddress} />}
      {connected && !address && <p className="dash-hint">Checking that providers can reach this server…</p>}

      {connected && address?.ok && (
        <>
          <SheetSection title="3. Number">
            <div className="dash-phone-choices" role="radiogroup" aria-label="Which number">
              {(
                [
                  ["new", "Get a new number"],
                  ["existing", "Use a number already in this account"],
                  ["forward", "Keep your business number"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="dash-check">
                  <input type="radio" name="phone-choice" checked={choice === value} onChange={() => (setChoice(value), setNumber(""))} data-testid={`phone-choice-${value}`} /> {label}
                </label>
              ))}
            </div>
            {choice === "forward" && (
              <FormRow label="Your business number" hint="People keep dialling it. Dash gets a number to receive on, then shows how to forward your calls to it.">
                {(id) => <TextInput id={id} value={businessNumber} onChange={setBusinessNumber} placeholder="+1 555 123 4567" />}
              </FormRow>
            )}
            {(choice === "new" || choice === "forward") && (
              <FormRow label="Area code" hint="The provider quotes the monthly price on its own pricing page.">
                {(id) => (
                  <span className="dash-phone-search">
                    <TextInput id={id} value={areaCode} onChange={setAreaCode} maxLength={3} placeholder="415" testId="phone-area-code" />
                    <Button size="sm" busy={busy === "search"} testId="phone-search" onClick={() => void run("search", async () => setFound((await api.searchPhoneNumbers(provider, areaCode.trim())).numbers))}>
                      Search
                    </Button>
                  </span>
                )}
              </FormRow>
            )}
            {(choice === "existing" ? owned : found)?.map((one) => (
              <label key={one.number} className="dash-check" data-testid={`phone-number-${one.number}`}>
                <input type="radio" name="phone-number" checked={number === one.number} onChange={() => setNumber(one.number)} /> {one.number}
                {"locality" in one && one.locality ? ` · ${one.locality}${one.region ? `, ${one.region}` : ""}` : ""}
              </label>
            ))}
            {(choice === "existing" ? owned : found)?.length === 0 && <p className="dash-hint">{choice === "existing" ? "This account has no numbers yet." : "No numbers there: try another area code."}</p>}
          </SheetSection>
          <SheetSection title="4. Whose it is" description="The team's line shows under Your comms; an agent's own line shows in its area, and only that agent texts from it.">
            <FormRow label="Owner">{(id) => <OwnerSelect id={id} value={owner} agents={agents.filter((one) => !one.archived)} onChange={setOwner} />}</FormRow>
          </SheetSection>
        </>
      )}
      {note && <p className="dash-sched-error">{note}</p>}
    </SetupSheet>
  );
};

/** One line: its conversations (read here), and whose it is. */
export const PhoneLineSheet = ({ line, agents, onClose, onChanged }: { readonly line: PhoneLineView; readonly agents: readonly AgentSpec[]; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element => {
  const [owner, setOwner] = useState(ownerKey(line.owner));
  const [threads, setThreads] = useState<Awaited<ReturnType<typeof api.phoneThreads>>["threads"] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [texts, setTexts] = useState<readonly PhoneText[]>([]);
  useEffect(() => {
    void api.phoneThreads(line.id).then((answer) => setThreads(answer.threads), () => setThreads([]));
  }, [line.id]);
  useEffect(() => {
    if (open) void api.phoneThread(line.id, open).then((answer) => setTexts(answer.texts), () => setTexts([]));
  }, [line.id, open]);
  return (
    <SetupSheet
      trail="Communications · Phone"
      title={line.number ?? line.title}
      testId="phone-line-sheet"
      wide
      onClose={onClose}
      onSave={async () => {
        if (owner !== ownerKey(line.owner)) await api.setPhoneLineOwner(line.id, ownerOf(owner));
        onChanged();
        onClose();
      }}
      removeLabel="Remove line"
      onRemove={async () => {
        await api.removePhoneLine(line.id);
        onChanged();
        onClose();
      }}
    >
      <SheetSection title="Status">
        <LineChips line={line} />
        <p className="dash-hint">
          Today: {line.today.texts} of {line.today.textsPerDay} texts, {line.today.callMinutes} of {line.today.callMinutesPerDay} call minutes.
        </p>
      </SheetSection>
      <SheetSection title="Conversations" description="STOP, HELP and START are answered by Dash and marked; agents never read them as conversation.">
        {threads === null ? (
          <p className="dash-hint">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="dash-hint">No texts yet.</p>
        ) : (
          <ul className="dash-phone-threads">
            {threads.map((one) => (
              <li key={one.number}>
                <button type="button" className="dash-phone-thread" data-active={open === one.number ? "true" : undefined} onClick={() => setOpen(one.number)} data-testid={`phone-thread-${one.number}`}>
                  <strong>{one.number}</strong>
                  <span>{one.last?.body ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <ol className="dash-phone-texts" data-testid="phone-texts">
            {texts.map((one) => (
              <li key={one.id} data-direction={one.direction} data-keyword={one.keyword ?? undefined}>
                <span className="dash-phone-text__body">{one.body}</span>
                <span className="dash-phone-text__meta">
                  {new Date(one.at).toLocaleString()}
                  {one.keyword ? ` · ${one.keyword.toUpperCase()}, answered by Dash` : ""}
                  {one.held ? " · held by the inbound screen" : ""}
                  {one.status && one.direction === "out" ? ` · ${one.status.replace("_", " ")}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </SheetSection>
      <SheetSection title="Whose it is" description="Changing this only moves where the line is shown, and which agent texts from it.">
        <FormRow label="Owner">{(id) => <OwnerSelect id={id} value={owner} agents={agents.filter((one) => !one.archived)} onChange={setOwner} />}</FormRow>
      </SheetSection>
    </SetupSheet>
  );
};
