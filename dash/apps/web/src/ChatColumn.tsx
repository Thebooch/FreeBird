import {
  useActionEvents,
  useActionState,
  useChat,
  useFreeBird,
  useSession,
} from "@freebirdai/react";
import { useCallback } from "react";
import { useOptionalDashboard } from "@freebirdai/dash-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { ConciergeCard } from "./ConciergeCard";
import { writeStoredSession } from "./ChatSession.jsx";
import { Citations, DigDeeper } from "./MessageExtras.jsx";
import { showWidget } from "./showWidget.js";

/**
 * The assistant, as a column rather than a bubble.
 *
 * It slides in from the right and the dashboard reflows to make room, because
 * the thing being discussed is the board itself — a panel that covers the
 * widgets you are asking about would be the wrong shape.
 *
 * Everything it knows comes from the server: the registry is rebuilt per turn
 * from the stored dashboard and its capability report, so the client does not
 * have to describe anything. The client-side registry below stays empty on
 * purpose — it exists only to satisfy the provider, which needs one for
 * rendering components inline, and Dash renders its own.
 */

export interface ChatColumnProps {
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  /** Which board the conversation is about. Sent with every request. */
  readonly dashboardId: string | null;
  /** Called after anything stored changes, so the shell reloads. */
  readonly onDashboardChanged: () => void;
  /**
   * A widget the assistant just added.
   *
   * Named rather than merely announced, so the board can put the user in front
   * of it — landing in arrange mode with no idea which tile is the new one is
   * not a handoff, it is a puzzle.
   */
  readonly onWidgetAdded?: (widgetId: string) => void;
  /** Move to another tab, when the assistant is asked to. */
  readonly onSwitchDashboard?: (id: string) => void;
  /** Open a panel the assistant cannot fill in on the user's behalf. */
  readonly onOpenPanel?: (panel: "connections" | "add-widget") => void;
  /**
   * Whether a widget is being built right now.
   *
   * The shell reads this to widen the column, because a preview needs room —
   * so it has to travel up rather than being decided in here.
   */
  readonly onBuildingChange?: (building: boolean) => void;
}

/**
 * Actions that changed something stored, so the shell must re-read.
 *
 * Tab actions land here too: the server already wrote them, and the nav is
 * rendered from that list.
 */
/**
 * Actions that move a guided setup along.
 *
 * They change a draft the server holds rather than the board, so the shell has
 * nothing to re-read — but the card is rendering that draft and has to be told
 * it moved. `confirm_setup` is the one that also writes a widget.
 */
const SETUP_ACTIONS = new Set([
  "start_setup",
  "answer_step",
  "revise_setup",
  "confirm_setup",
]);

/**
 * What to say while the assistant is working, when it is doing something with
 * a name.
 *
 * Derived, never invented. Every phrase here is keyed to an action the server
 * really registered and really started — the same event stream that drives the
 * confirmation card — so the line under the dots is a report rather than
 * atmosphere. An action nobody thought to list falls back to the label the
 * action itself declared.
 *
 * The alternative, generated "reasoning" text, would be the one thing this
 * whole product exists not to do: something that looks like information and
 * is not.
 */
const WORKING_ON: Readonly<Record<string, string>> = {
  start_setup: "Building your widget",
  revise_setup: "Adjusting the widget",
  answer_step: "Noting that down",
  confirm_setup: "Adding it to the board",
  add_widget: "Adding the widget",
  remove_widget: "Removing the widget",
  create_dashboard: "Creating the tab",
  rename_dashboard: "Renaming the tab",
  delete_dashboard: "Deleting the tab",
  read_connection: "Opening the connection panel",
  open_connections: "Opening your connections",
  open_add_widget: "Opening the widget picker",
  switch_dashboard: "Switching tabs",
  set_time_range: "Changing the time range",
  open_widget: "Finding that widget",
};

/** How long before a plain wait admits it is a long one. */
const PATIENCE_MS = 8_000;

/**
 * The gap between sending and the first word coming back.
 *
 * Real streaming shortened it and cannot remove it: the model has to read the
 * dashboard's knowledge before it says anything, and a turn that starts with a
 * tool call produces no text at all until the tool has run. An empty log for
 * those seconds reads as a hang — which it looked like even when everything
 * was working.
 */
const Thinking = ({ what }: { what: string | null }): JSX.Element => {
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setWaited(Date.now() - started), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const line = what ?? (waited > PATIENCE_MS ? "Still working" : "Thinking");

  return (
    <div className="dash-chat__msg dash-chat__thinking" data-role="assistant" data-testid="chat-thinking">
      <span className="dash-chat__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="dash-chat__thinking-text">{line}…</span>
    </div>
  );
};

const SPEC_ACTIONS = new Set([
  "add_widget",
  "remove_widget",
  "create_dashboard",
  "rename_dashboard",
  "delete_dashboard",
]);

const ChatBody = ({
  onToggle,
  dashboardId,
  onDashboardChanged,
  onWidgetAdded,
  onSwitchDashboard,
  onOpenPanel,
  onBuildingChange,
}: Omit<ChatColumnProps, "open">): JSX.Element => {
  const { sessionId, createSession } = useSession({ autoCreate: true, topic: "dashboard" });
  const freeBird = useFreeBird();

  /*
   * Written down as soon as there is one, so a reload continues the
   * conversation instead of silently starting a new one. `ChatSession` reads
   * it back at mount; `useChat` refetches the history whenever the id changes,
   * so nothing else is needed to restore what was said.
   */
  useEffect(() => {
    if (sessionId) writeStoredSession(sessionId);
  }, [sessionId]);

  /*
   * A remembered session can outlive the database it was made in.
   *
   * The chat store is embedded and gets replaced — restored from a backup, or
   * set aside after a hard kill damaged it, which has happened more than once.
   * The id in `sessionStorage` then names a session the server has never heard
   * of, and until this the failure was total silence: the append fails, the
   * stream ends carrying nothing, and every message after it does the same
   * with the input still looking ready.
   *
   * Recovering once is right and twice is a loop, so it is attempted a single
   * time per mount: start a fresh session and let the user send again.
   */
  const recovered = useRef(false);
  useEffect(() => {
    const failure = freeBird.lastChatError;
    if (!failure || recovered.current) return;
    if (!/session/i.test(failure)) return;
    recovered.current = true;
    writeStoredSession(null);
    void createSession().catch(() => {
      // Nothing left to try; the callout below is what the user sees.
    });
  }, [freeBird.lastChatError, createSession]);

  /*
   * Whether the server has an assistant at all.
   *
   * Chat storage is allowed to fail on its own so a damaged embedded database
   * cannot take down dashboards — but that failure was invisible here. The
   * session request 404s, `sessionId` stays null forever, and the box sits
   * disabled reading "Starting…", which looks like a hang and is really a
   * boot error the server already printed. Asking once tells the two apart.
   */
  const [chatAvailable, setChatAvailable] = useState<boolean | null>(null);
  /*
   * Whether there is a model to write with.
   *
   * Without one the server substitutes a stand-in adapter that emits a single
   * sentence explaining the problem — and that sentence then travels the whole
   * normal path and lands in a bubble looking exactly like something the
   * assistant said. It is a state of the app, not a remark, so it is asked
   * about here and shown as a callout instead. The stand-in stays as the
   * server's answer to a request that should no longer arrive.
   */
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .models()
      .then((result) => {
        if (!cancelled) {
          setHasModel(Object.values(result.providers).some(Boolean));
        }
      })
      // Same reasoning as the health probe below: unreachable is not the same
      // as absent, and declaring the assistant dead on one failed request is
      // worse than letting the first message find out.
      .catch(() => {
        if (!cancelled) setHasModel(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api
      .health()
      .then((result) => {
        if (!cancelled) setChatAvailable(result.chat !== false);
      })
      // Unreachable is not the same as "no assistant", and the retry loop
      // below will keep trying — so assume present rather than declaring it
      // dead on one failed request.
      .catch(() => {
        if (!cancelled) setChatAvailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unavailable = chatAvailable === false;
  const keyless = hasModel === false;
  const chat = useChat();
  const actions = useActionState();
  /*
   * When a board is open the column renders inside its provider — via the
   * `toolbar` slot, documented as where a chat drawer goes — so it can drive
   * the view directly rather than routing every change up through props.
   * Fixed positioning means its place in the tree does not affect where it
   * appears on screen.
   *
   * Optional because the assistant also opens on an empty workspace, where
   * there is no board and so nothing to set a time range on. Requiring the
   * context there took the whole app down the moment the panel was opened.
   */
  const dashboard = useOptionalDashboard();
  const setPreset = dashboard?.setPreset;
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  /*
   * Bumped whenever the assistant touches a setup, so the card re-reads.
   *
   * The card and the assistant are two hands on the same draft: with an AI key
   * the model can answer a question through its own action, and without one
   * the card posts the answer itself. Neither owns the state, so the card is
   * told to look again rather than being kept in sync.
   */
  const [setupRevision, setSetupRevision] = useState(0);
  /*
   * Whether the setup on screen was started here, in this tab, just now.
   *
   * The card cannot work this out for itself — a draft is a draft — and the
   * difference decides whether somebody is carried straight into building or
   * stopped and asked whether they meant to resume something. This is the
   * side that knows: it watched the action run.
   */
  const [startedHere, setStartedHere] = useState(false);
  /** The action the server is carrying out right now, if any. */
  const [running, setRunning] = useState<{ actionId: string; label?: string } | null>(null);

  // Keep the newest message in view, including while a reply streams in.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages, chat.streamingText]);

  /*
   * Executed actions are the assistant's hands.
   *
   * View actions are applied here because they are client state the server
   * cannot reach; spec actions already wrote to disk server-side, so the only
   * thing left is to re-read the board.
   */
  useActionEvents(
    useCallback(
      (event) => {
        if (event.kind === "action.started") {
          setRunning({
            actionId: event.record.actionId,
            ...(event.record.label ? { label: event.record.label } : {}),
          });
          return;
        }
        if (event.kind !== "action.executed") return;
        setRunning(null);
        // The id lives on the record; the event carries the args it ran with.
        const actionId = event.record.actionId;
        const args = (event.args ?? {}) as Record<string, unknown>;

        if (SETUP_ACTIONS.has(actionId)) {
          setSetupRevision((current) => current + 1);
          if (actionId === "start_setup") setStartedHere(true);
          // The setup is over, so the next draft to appear is a different one
          // and has to earn its own answer to this question.
          if (actionId === "confirm_setup") {
            setStartedHere(false);
            onDashboardChanged();
          }
          return;
        }
        if (SPEC_ACTIONS.has(actionId)) {
          onDashboardChanged();
          // Creating a tab should land on it, the same as clicking ＋ does.
          const created = (event.result as { dashboardId?: unknown } | null)?.dashboardId;
          if (actionId === "create_dashboard" && typeof created === "string") {
            onSwitchDashboard?.(created);
          }
          return;
        }
        if (actionId === "set_time_range" && typeof args.preset === "string") {
          // No board open means no range to change; the action simply has
          // nothing to act on rather than being an error.
          setPreset?.(args.preset as Parameters<NonNullable<typeof setPreset>>[0]);
        }
        if (actionId === "open_widget") {
          /*
           * The server resolved the handle, so this gets the real widget id
           * AND which tab it is filed under. Switching first is what makes
           * "show me the rent roll" work from any tab — the assistant is not
           * limited to the board that happens to be open, and the user should
           * not have to be either.
           *
           * The tile is waited for rather than assumed: a tab change refetches
           * the board, so it does not exist yet at the moment the action lands.
           */
          const opened = event.result as
            | { widgetId?: unknown; dashboardId?: unknown }
            | null;
          const widgetId =
            typeof opened?.widgetId === "string" ? opened.widgetId : args.widgetId;
          if (typeof widgetId !== "string") return;
          if (typeof opened?.dashboardId === "string" && opened.dashboardId !== dashboardId) {
            onSwitchDashboard?.(opened.dashboardId);
          }
          showWidget(widgetId);
        }
        if (actionId === "switch_dashboard" && typeof args.dashboardId === "string") {
          onSwitchDashboard?.(args.dashboardId);
        }
        if (actionId === "open_connections" || actionId === "read_connection") {
          onOpenPanel?.("connections");
        }
        if (actionId === "open_add_widget") {
          onOpenPanel?.("add-widget");
        }
      },
      [setPreset, onDashboardChanged, onSwitchDashboard, onOpenPanel, dashboardId],
    ),
  );

  /*
   * The action in flight, named. Null while the assistant is simply composing
   * a reply, which is the ordinary case and wants the generic line.
   *
   * Read off the started/executed events rather than off `phase`, and that is
   * the load-bearing detail: an action the server authorises itself never puts
   * the client into `executing` at all — it goes straight from nothing to
   * executed — so a phase check said "Thinking…" through the whole of a widget
   * build. The events fire for every action either way.
   */
  const working = running ? (WORKING_ON[running.actionId] ?? running.label ?? null) : null;

  const submit = (): void => {
    const text = draft.trim();
    if (!text || chat.streaming || !sessionId || keyless) return;
    setDraft("");
    void chat.send(text);
  };

  return (
    <>
      <div className="dash-chat__head">
        <h3 className="dash-chat__title">Assistant</h3>
        <button
          className="dash-iconbtn"
          style={{ marginLeft: "auto" }}
          onClick={() => onToggle(false)}
          aria-label="Close the assistant"
          data-testid="chat-close"
        >
          ✕
        </button>
      </div>

      <div className="dash-chat__log" ref={logRef} data-testid="chat-log">
        {chat.messages.length === 0 && !chat.streamingText && !chat.streaming && (
          /*
           * A prompt for the user, not the assistant speaking. It stays fixed
           * because it is the one thing said before there is anything to say
           * — there has been no turn, so there is nothing to generate from.
           */
          <p className="dash-chat__empty">
            Ask what a widget is showing, what is on any of your tabs, or why an endpoint
            could not be read. Describe something you want to see and it gets built here,
            next to a live preview — nothing reaches the board until you say so.
          </p>
        )}

        {chat.messages.map((message) => (
          <div key={message.id} className="dash-chat__msg" data-role={message.role}>
            {message.content}
            {/*
             * Where the answer came from, and how far it looked. Both sit
             * under the text rather than in it — a footnote, not a hedge.
             */}
            <Citations message={message} />
            <DigDeeper message={message} onAsk={(text) => void chat.send(text)} />
          </div>
        ))}

        {chat.streamingText && (
          <div className="dash-chat__msg" data-role="assistant" data-streaming="true">
            {chat.streamingText}
          </div>
        )}

        {/*
         * Shown only while there is nothing else to show. The moment the first
         * delta lands the reply above replaces it, so the two are never on
         * screen together saying different things.
         */}
        {chat.streaming && !chat.streamingText && <Thinking what={working} />}

        {/*
         * The guided setup, when one is running. It renders itself away when
         * there is no draft, so no condition is needed here.
         */}
        {dashboardId && (
          <ConciergeCard
            dashboardId={dashboardId}
            revision={setupRevision}
            startedHere={startedHere}
            onOpenPanel={onOpenPanel}
            onActiveChange={onBuildingChange}
            onAdded={(widgetId) => {
              setSetupRevision((current) => current + 1);
              setStartedHere(false);
              onDashboardChanged();
              onWidgetAdded?.(widgetId);
            }}
            onDismissed={() => {
              setSetupRevision((current) => current + 1);
              setStartedHere(false);
            }}
          />
        )}

        {/*
         * The confirmation card. Adding or removing a widget writes the stored
         * dashboard, so neither runs until this is clicked — the assistant can
         * only ever propose them.
         */}
        {actions.pending && actions.phase === "awaiting_confirmation" && (
          <div className="dash-callout" data-testid="chat-confirm">
            <strong>{actions.pending.label ?? actions.pending.actionId}</strong>
            <div style={{ marginTop: 4 }}>
              {actions.pending.actionId === "add_widget"
                ? `Add "${String(actions.pending.args.widgetId ?? "")}" to this dashboard?`
                : actions.pending.actionId === "remove_widget"
                  ? `Remove "${String(actions.pending.args.widgetId ?? "")}" from this dashboard?`
                  : "Apply this change?"}
            </div>
            <div className="dash-row dash-row--end" style={{ marginTop: 8, gap: 6 }}>
              <button
                className="dash-control"
                onClick={() => void actions.cancel()}
                data-testid="chat-confirm-cancel"
              >
                Cancel
              </button>
              <button
                className="dash-control"
                onClick={() => void actions.confirm()}
                data-testid="chat-confirm-apply"
              >
                Apply
              </button>
            </div>
          </div>
        )}

        {actions.phase === "error" && actions.lastError && (
          <div className="dash-callout dash-callout--bad">{actions.lastError}</div>
        )}

        {/*
          * Said out loud, not just implied by a disabled box.
          *
          * Chat storage failing is survivable — dashboards, connections and
          * queries are untouched by design — but silence about it reads as a
          * hang. The server prints the directory and the reason on the
          * console at boot; this points there rather than restating it, since
          * the fix is a filesystem one and the console has the path.
          */}
        {unavailable && (
          <div className="dash-callout dash-callout--bad" data-testid="chat-unavailable">
            The assistant is unavailable — its storage could not be opened. Everything else on
            the dashboard still works. The server console explains what to do; a restart is
            usually needed after fixing it.
          </div>
        )}

        {/*
         * A missing key is a state of the app, not something the assistant
         * said. It used to arrive as a bubble, because the server substitutes
         * a stand-in adapter whose one sentence travels the ordinary reply
         * path — indistinguishable from an answer, in a column where every
         * other sentence is one.
         */}
        {keyless && !unavailable && (
          <div className="dash-callout" data-testid="chat-no-model">
            No AI model is configured, so the assistant cannot reply. Set{" "}
            <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> and restart the
            server. Guided setup still works without one.
          </div>
        )}
      </div>

      <form
        className="dash-chat__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          className="dash-chat__input"
          value={draft}
          rows={1}
          placeholder={
            unavailable
              ? "The assistant is unavailable — see the server console"
              : keyless
                ? "No AI model is configured"
                : sessionId
                  ? "Ask about this dashboard…"
                  : "Starting…"
          }
          disabled={!sessionId || keyless}
          data-testid="chat-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline, as everywhere else.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="dash-control"
          type="submit"
          disabled={!sessionId || keyless || chat.streaming || draft.trim().length === 0}
          data-testid="chat-send"
        >
          {chat.streaming ? "…" : "Send"}
        </button>
      </form>
    </>
  );
};

export const ChatColumn = ({
  open,
  onToggle,
  dashboardId,
  ...handlers
}: ChatColumnProps): JSX.Element => {
  return (
    <>
      <button
        className="dash-chat__tab"
        hidden={open}
        onClick={() => onToggle(true)}
        aria-label="Open the assistant"
        data-testid="chat-open"
      >
        Assistant
      </button>

      <aside
        className="dash-chat"
        data-open={open ? "true" : "false"}
        aria-hidden={!open}
        aria-label="Assistant"
        data-testid="chat-column"
      >
        {/*
         * The body mounts only while open, so a closed column still costs
         * nothing: `useSession` lives in here, so no session is created and no
         * history fetched until somebody asks for one.
         *
         * The provider itself is *above* this, in `App` — see `ChatSession`.
         * It used to be here, which meant closing the drawer, opening a record
         * or switching tabs each threw the store away and started a new
         * conversation.
         */}
        {open && <ChatBody onToggle={onToggle} dashboardId={dashboardId} {...handlers} />}
      </aside>
    </>
  );
};
