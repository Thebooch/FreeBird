import { Button } from "@freebirdai/dash-components";
import type { AgentSpec, MailboxOwner, MailboxView } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { FormRow, SheetSection, TextInput } from "../agent/calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../agent/calendar/scheduling/SetupSheet.jsx";

/**
 * Adding a mailbox, and looking after one: which provider, whose it is (the
 * team's own, or an address set up for one agent), the workspace's OAuth app
 * the first time, then the provider's own sign-in in a new tab.
 */

const PROVIDERS = [
  { id: "gmail", label: "Gmail", help: "In Google Cloud: create a project, enable the Gmail API, set up the OAuth consent screen, and create an OAuth client of type Web application." },
  { id: "outlook", label: "Outlook", help: "In Microsoft Entra: register an app, add a client secret, and allow Mail.ReadWrite, Mail.Send, User.Read and offline_access." },
] as const;

type Provider = (typeof PROVIDERS)[number]["id"];

const ownerKey = (owner: MailboxOwner): string => (owner.kind === "team" ? "team" : `agent:${owner.id}`);
const ownerOf = (key: string): MailboxOwner => (key.startsWith("agent:") ? { kind: "agent", id: key.slice(6) } : { kind: "team" });

/** Open the provider's sign-in in a new tab; Dash hears back when it is done. */
export const signInTo = async (mailbox: string): Promise<void> => {
  const { authorizeUrl } = await api.startSignIn(mailbox);
  const opened = window.open(authorizeUrl, "_blank");
  if (!opened) window.location.assign(authorizeUrl);
};

const OwnerSelect = ({ id, value, agents, onChange }: { readonly id: string; readonly value: string; readonly agents: readonly AgentSpec[]; readonly onChange: (key: string) => void }): JSX.Element => (
  <select id={id} className="dash-sched-input" value={value} onChange={(event) => onChange(event.target.value)} data-testid="mailbox-owner">
    <option value="team">The team's own inbox (Your comms)</option>
    {agents.map((agent) => (
      <option key={agent.id} value={`agent:${agent.id}`}>
        {agent.name}'s own address (Agent comms)
      </option>
    ))}
  </select>
);

export const AddMailboxSheet = ({
  agents,
  apps,
  onClose,
  onAdded,
}: {
  readonly agents: readonly AgentSpec[];
  readonly apps: { readonly gmail: boolean; readonly outlook: boolean };
  readonly onClose: () => void;
  readonly onAdded: (mailbox: MailboxView) => void;
}): JSX.Element => {
  const [provider, setProvider] = useState<Provider>("gmail");
  const [owner, setOwner] = useState("team");
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const needsApp = !apps[provider];
  const returnAddress = `${window.location.origin}/api/oauth/callback`;

  return (
    <SetupSheet
      trail="Communications"
      title="Add a mailbox"
      saveLabel="Add and sign in"
      testId="add-mailbox"
      onClose={onClose}
      onSave={async () => {
        if (needsApp) {
          if (!clientId.trim() || !clientSecret.trim()) throw new Error("Paste the app's client ID and secret first.");
          await api.setCommsApp(provider, clientId, clientSecret);
        }
        const made = await api.addMailbox({ provider, owner: ownerOf(owner), ...(title.trim() ? { title: title.trim() } : {}) });
        await signInTo(made.id);
        onAdded(made);
      }}
    >
      <SheetSection title="Mailbox">
        <FormRow label="Provider">
          {(id) => (
            <select id={id} className="dash-sched-input" value={provider} onChange={(event) => setProvider(event.target.value as Provider)} data-testid="mailbox-provider">
              {PROVIDERS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label="Whose is it?" hint="Your inbox shows under Your comms. An agent's own address shows in its own area, and its mail never mixes into yours.">
          {(id) => <OwnerSelect id={id} value={owner} agents={agents.filter((one) => !one.archived)} onChange={setOwner} />}
        </FormRow>
        <FormRow label="Name" hint="Optional, e.g. Leasing inbox.">
          {(id) => <TextInput id={id} value={title} onChange={setTitle} maxLength={120} placeholder={provider === "gmail" ? "Gmail" : "Outlook"} />}
        </FormRow>
      </SheetSection>
      {needsApp && (
        <SheetSection
          title="Your OAuth app"
          description={
            <>
              Once per workspace, every {provider === "gmail" ? "Gmail" : "Outlook"} mailbox signs in through your own app. {PROVIDERS.find((one) => one.id === provider)?.help} Its redirect URI is <code>{returnAddress}</code>.
            </>
          }
        >
          <FormRow label="Client ID">{(id) => <TextInput id={id} value={clientId} onChange={setClientId} testId="mailbox-client-id" />}</FormRow>
          <FormRow label="Client secret">
            {(id) => <input id={id} type="password" className="dash-sched-input" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} data-testid="mailbox-client-secret" autoComplete="off" />}
          </FormRow>
        </SheetSection>
      )}
      <p className="dash-hint">Next, {provider === "gmail" ? "Google" : "Microsoft"} asks you to allow Dash to read and send this mailbox's mail, in a new tab.</p>
    </SetupSheet>
  );
};

export const MailboxSheet = ({
  mailbox,
  agents,
  onClose,
  onChanged,
}: {
  readonly mailbox: MailboxView;
  readonly agents: readonly AgentSpec[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): JSX.Element => {
  const [owner, setOwner] = useState(ownerKey(mailbox.owner));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setOwner(ownerKey(mailbox.owner)), [mailbox]);
  return (
    <SetupSheet
      trail="Communications"
      title={mailbox.address ?? mailbox.title}
      testId="mailbox-sheet"
      onClose={onClose}
      onSave={async () => {
        if (owner !== ownerKey(mailbox.owner)) await api.setMailboxOwner(mailbox.id, ownerOf(owner));
        onChanged();
        onClose();
      }}
      removeLabel="Remove mailbox"
      onRemove={async () => {
        await api.removeMailbox(mailbox.id);
        onChanged();
        onClose();
      }}
    >
      <SheetSection title="Whose it is" description="Changing this only moves where its mail is shown.">
        <FormRow label="Owner">{(id) => <OwnerSelect id={id} value={owner} agents={agents.filter((one) => !one.archived)} onChange={setOwner} />}</FormRow>
      </SheetSection>
      <SheetSection
        title="Sign-in"
        description={mailbox.status === "ready" ? "Signed in. Sign in again if the provider stopped letting Dash read it." : "Not signed in yet."}
        actions={
          <Button
            size="sm"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setNote(null);
              void signInTo(mailbox.id)
                .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
          >
            Sign in
          </Button>
        }
      >
        {mailbox.error && <p className="dash-sched-error">Last read: {mailbox.error}</p>}
        {note && <p className="dash-sched-error">{note}</p>}
        <p className="dash-hint">
          {mailbox.kept} of its newest messages are kept so it opens at once; everything older is read live.
          {mailbox.refreshedAt ? ` Last read ${new Date(mailbox.refreshedAt).toLocaleString()}.` : ""}
        </p>
      </SheetSection>
    </SetupSheet>
  );
};
