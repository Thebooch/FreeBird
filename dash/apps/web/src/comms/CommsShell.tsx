import { AgentChip, Button, EmptyState, Icon } from "@freebirdai/dash-components";
import type { AgentSpec, MailboxView, MailPage } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { AddMailboxSheet, MailboxSheet, signInTo } from "./MailboxSheet.jsx";
import { areaGroups, filterShown, loadSelection, saveSelection, ticked, toggle, when, type AreaGroup } from "./model.js";
import { ThreadView } from "./ThreadView.jsx";
import { CommsSettingsSheet } from "./CommsSettingsSheet.jsx";

/**
 * Comms: calls, texts and email, in a section of their own (`#/comms`).
 *
 * Three panes on a wide screen, one at a time on a narrow one:
 * - **Mailboxes.** Your comms (the team's own) and Agent comms (one area per
 *   agent with addresses of its own, in its colour), each mailbox with a tick
 *   box, so any set of them can be shown. Each person's ticks are remembered
 *   per area.
 * - **Mail.** Merged newest first across the ticked mailboxes. Typing filters
 *   what shows at once; Enter searches every ticked mailbox's own index.
 * - **The conversation**, read live, with drafts inline.
 *
 * Texts and calls join the same panes in step 9.
 */

type Shown = MailPage["messages"][number];

const STATUS_WORDS: Readonly<Record<MailboxView["status"], string>> = {
  ready: "",
  needs_app: "Needs its app",
  needs_sign_in: "Sign in",
};

const sender = (one: Shown): string => (one.sent ? `To ${one.to.map((to) => to.name ?? to.address).join(", ")}` : (one.from?.name ?? one.from?.address ?? "Unknown sender"));

export const CommsShell = (): JSX.Element => {
  const [mailboxes, setMailboxes] = useState<readonly MailboxView[] | null>(null);
  const [apps, setApps] = useState({ gmail: false, outlook: false });
  const [agents, setAgents] = useState<readonly AgentSpec[]>([]);
  const [area, setArea] = useState("team");
  const [selection, setSelection] = useState<Record<string, string[]>>(() => loadSelection());
  const [page, setPage] = useState<{ messages: Shown[]; cursor?: string | undefined; problems: MailPage["problems"]; searched?: boolean | undefined; capped?: readonly string[] | undefined } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [searched, setSearched] = useState("");
  const [open, setOpen] = useState<{ readonly mailbox: string; readonly thread: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<MailboxView | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const asked = useRef(0);

  const loadMailboxes = useCallback(async () => {
    try {
      const [boxes, people] = await Promise.all([api.commsMailboxes(), api.agents()]);
      setMailboxes(boxes.mailboxes);
      setApps(boxes.apps);
      setAgents(people);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setMailboxes([]);
    }
  }, []);
  useEffect(() => {
    void loadMailboxes();
    /* Back from a provider's sign-in, in another tab. */
    const back = (event: MessageEvent) => {
      if ((event.data as { dashOAuth?: boolean } | null)?.dashOAuth) void loadMailboxes();
    };
    const focus = () => void loadMailboxes();
    window.addEventListener("message", back);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("message", back);
      window.removeEventListener("focus", focus);
    };
  }, [loadMailboxes]);

  const groups = useMemo(() => areaGroups(mailboxes ?? [], agents), [mailboxes, agents]);
  const all: readonly AreaGroup[] = [groups.team, ...groups.agents];
  const group = all.find((one) => one.key === area) ?? groups.team;
  const chosen = ticked(group, selection[group.key]);
  const chosenKey = chosen.join(",");
  const several = chosen.length > 1;

  const load = useCallback(
    async (more?: string) => {
      const ticket = ++asked.current;
      setLoading(true);
      setError(null);
      try {
        const answer = await api.commsList({ area: group.key, mailboxes: chosen, ...(more ? { cursor: more } : {}), ...(searched ? { q: searched } : {}) });
        if (ticket !== asked.current) return;
        setPage((held) => ({
          messages: more && held ? [...held.messages, ...answer.messages] : [...answer.messages],
          cursor: answer.cursor,
          problems: answer.problems,
          searched: answer.searched,
          capped: answer.capped,
        }));
      } catch (cause) {
        if (ticket === asked.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (ticket === asked.current) setLoading(false);
      }
    },
    // The ticked set is read through its key.
    [group.key, chosenKey, searched],
  );
  useEffect(() => {
    if (mailboxes === null) return;
    setPage(null);
    void load();
  }, [load, mailboxes === null]);

  const pick = (key: string, ids: string[]) => {
    const next = { ...selection, [key]: ids };
    setSelection(next);
    saveSelection(next);
  };

  const shown = page ? (searched ? page.messages : filterShown(page.messages, typed)) : [];
  const agentById = new Map(agents.map((one) => [one.id, one]));
  const titleOf = (id: string) => (mailboxes ?? []).find((one) => one.id === id);

  const mailboxRow = (box: MailboxView, owner: AreaGroup) => {
    const on = owner.key === group.key && chosen.includes(box.id);
    return (
      <li key={box.id} className="dash-comms-box" data-status={box.status}>
        <label className="dash-comms-box__pick">
          <input
            type="checkbox"
            checked={on}
            disabled={box.status !== "ready"}
            onChange={() => {
              setArea(owner.key);
              pick(owner.key, owner.key === group.key ? toggle(chosen, box.id) : [box.id]);
            }}
            data-testid={`comms-pick-${box.id}`}
          />
          <span className="dash-comms-box__name" title={box.address ?? box.title}>
            {box.address ?? box.title}
          </span>
        </label>
        {box.status !== "ready" ? (
          <Button size="sm" tone="ghost" onClick={() => (box.status === "needs_sign_in" ? void signInTo(box.id).catch((cause: unknown) => setError(String(cause))) : setManaging(box))}>
            {STATUS_WORDS[box.status]}
          </Button>
        ) : (
          <button type="button" className="dash-comms-box__more" aria-label={`Manage ${box.address ?? box.title}`} onClick={() => setManaging(box)}>
            <Icon name="ellipsis" />
          </button>
        )}
      </li>
    );
  };

  const areaButton = (one: AreaGroup) => (
    <button
      type="button"
      className="dash-comms-area"
      data-active={one.key === group.key ? "true" : undefined}
      onClick={() => {
        setArea(one.key);
        setOpen(null);
      }}
      data-testid={`comms-area-${one.key}`}
    >
      {one.color !== undefined ? <AgentChip name={one.label} color={one.color} size="sm" /> : <span>All of your comms</span>}
      <span className="dash-comms-area__count">{one.mailboxes.length}</span>
    </button>
  );

  return (
    <div className="dash-page dash-comms" data-testid="comms-section" data-pane={open ? "thread" : "list"}>
      <aside className="dash-comms__boxes" aria-label="Mailboxes">
        <div className="dash-comms__boxes-head">
          <h1 className="dash-comms__title">Comms</h1>
          <Button size="sm" tone="primary" onClick={() => setAdding(true)} testId="comms-add-mailbox">
            Add mailbox
          </Button>
        </div>
        <h2 className="dash-comms__group">Your comms</h2>
        {areaButton(groups.team)}
        <ul className="dash-comms__list">{groups.team.mailboxes.map((box) => mailboxRow(box, groups.team))}</ul>
        {groups.team.mailboxes.length === 0 && <p className="dash-hint">Add your own Gmail or Outlook inbox.</p>}
        <h2 className="dash-comms__group">Agent comms</h2>
        {groups.agents.length === 0 && <p className="dash-hint">An agent with an address of its own gets an area here. Add a mailbox and choose the agent it belongs to.</p>}
        {groups.agents.map((one) => (
          <div key={one.key} className="dash-comms__agent">
            {areaButton(one)}
            <ul className="dash-comms__list">{one.mailboxes.map((box) => mailboxRow(box, one))}</ul>
          </div>
        ))}
        <div className="dash-comms__foot">
          <Button size="sm" tone="ghost" onClick={() => setSettingUp(true)} testId="comms-settings-open">
            Settings
          </Button>
        </div>
      </aside>

      <section className="dash-comms__mail" aria-label="Mail">
        <form
          className="dash-comms__search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearched(typed.trim());
          }}
        >
          <input
            type="search"
            className="dash-contacts-search__input"
            value={typed}
            placeholder={`Search ${several ? `${chosen.length} mailboxes` : "this mailbox"}: words, from:, to:, subject:, is:unread`}
            onChange={(event) => {
              setTyped(event.target.value);
              if (!event.target.value.trim() && searched) setSearched("");
            }}
            data-testid="comms-search"
          />
        </form>
        {page?.searched && (
          <p className="dash-comms__note">
            Searched all mail in {several ? "the ticked mailboxes" : "this mailbox"}.
            {page.capped && page.capped.length > 0 ? ` ${page.capped.map((id) => titleOf(id)?.address ?? id).join(", ")}: only the most relevant results, not strictly by date.` : ""}
          </p>
        )}
        {!searched && typed.trim() && <p className="dash-comms__note">Showing what has loaded that matches. Press Enter to search all mail.</p>}
        {error && <p className="dash-sched-error">{error}</p>}
        {page?.problems.map((one) => (
          <p key={one.mailbox} className="dash-sched-error">
            {titleOf(one.mailbox)?.address ?? one.mailbox}: {one.message}
          </p>
        ))}
        {mailboxes !== null && group.mailboxes.length === 0 ? (
          <EmptyState icon="mail" title="No mailboxes here yet" body="Add a Gmail or Outlook mailbox to read, sort and answer its mail here." />
        ) : (
          <ul className="dash-comms__messages" data-testid="comms-messages">
            {shown.map((one) => {
              const agent = one.agent ? agentById.get(one.agent) : undefined;
              const active = open?.mailbox === one.mailbox && open.thread === one.threadId;
              return (
                <li key={`${one.mailbox}:${one.id}`}>
                  <button
                    type="button"
                    className="dash-comms-row"
                    data-unread={one.unread ? "true" : undefined}
                    data-set-aside={one.status === "ignored" ? "true" : undefined}
                    data-active={active ? "true" : undefined}
                    onClick={() => setOpen({ mailbox: one.mailbox, thread: one.threadId })}
                  >
                    <span className="dash-comms-row__top">
                      <span className="dash-comms-row__from">{sender(one)}</span>
                      <span className="dash-comms-row__when">{when(one.at)}</span>
                    </span>
                    <span className="dash-comms-row__subject">{one.subject || "(no subject)"}</span>
                    <span className="dash-comms-row__snippet">{one.snippet}</span>
                    <span className="dash-comms-row__tags">
                      {several && <span className="dash-comms-tag">{titleOf(one.mailbox)?.address ?? one.mailbox}</span>}
                      {one.draft && <span className="dash-comms-tag" data-tone="draft">Draft waiting</span>}
                      {one.status === "replied" && <span className="dash-comms-tag">Replied</span>}
                      {one.status === "triaged" && <span className="dash-comms-tag">Handled</span>}
                      {one.status === "ignored" && <span className="dash-comms-tag">Set aside</span>}
                      {agent && <AgentChip name={agent.name} color={agent.color} size="sm" title={one.sent ? `Sent by ${agent.name}` : `Handled by ${agent.name}`} />}
                    </span>
                  </button>
                </li>
              );
            })}
            {page && shown.length === 0 && !loading && (
              <li className="dash-hint dash-comms__empty">
                {group.mailboxes.every((one) => one.status !== "ready") ? "Sign in to a mailbox here to see its mail." : searched || typed ? "Nothing matches." : "No mail yet."}
              </li>
            )}
          </ul>
        )}
        {(loading || page?.cursor) && (
          <div className="dash-comms__more">
            <Button size="sm" busy={loading} onClick={() => page?.cursor && void load(page.cursor)}>
              {loading ? "Reading mail…" : "Load more"}
            </Button>
          </div>
        )}
      </section>

      <section className="dash-comms__thread" aria-label="Conversation">
        {open ? (
          <ThreadView
            key={`${open.mailbox}:${open.thread}`}
            mailbox={open.mailbox}
            threadId={open.thread}
            agents={agents}
            onBack={() => setOpen(null)}
            onChanged={() => void load()}
          />
        ) : (
          <EmptyState icon="mail" title="Pick a conversation" body="Its messages are read live from the mailbox, with any reply an agent drafted underneath." />
        )}
      </section>

      {adding && (
        <AddMailboxSheet
          agents={agents}
          apps={apps}
          onClose={() => setAdding(false)}
          onAdded={(made) => {
            setAdding(false);
            setArea(made.owner.kind === "agent" ? `agent:${made.owner.id}` : "team");
            void loadMailboxes();
          }}
        />
      )}
      {settingUp && <CommsSettingsSheet onClose={() => setSettingUp(false)} />}
      {managing && <MailboxSheet mailbox={managing} agents={agents} onClose={() => setManaging(null)} onChanged={() => void loadMailboxes()} />}
    </div>
  );
};
