import { createComponentRegistry } from "@freebirdai/core";
import { FreeBirdProvider } from "@freebirdai/react";
import { useOptionalDashboard } from "@freebirdai/dash-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

/**
 * One conversation for the whole workspace.
 *
 * This exists because of where the chat used to live. `ChatColumn` mounted its
 * own provider inside the dashboard's `toolbar` slot, and `<Dashboard>` is
 * keyed on the board id — so switching tabs changed the key, React unmounted
 * the subtree, and the provider's store went with it. `FreeBirdProvider` holds
 * its store in a ref created once, so losing the provider loses the session id;
 * `useSession({autoCreate:true})` then minted a fresh one and the conversation
 * was gone. Not deleted — orphaned server-side, which is worse, because it
 * looks like deletion and is not.
 *
 * Closing the drawer and opening a record did the same thing, for the same
 * reason. So the store is hoisted above every one of those boundaries, and the
 * session id is written down so a reload resumes rather than restarts.
 *
 * Tabs are how somebody filed their widgets. Losing what you were talking
 * about because you looked at another tab defeats the point of being able to
 * navigate between them at all.
 */

/** Where the session id is kept, so a reload continues the conversation. */
export const SESSION_KEY = "dash.chat.session";

export const readStoredSession = (storage?: Storage): string | null => {
  try {
    const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    const value = store?.getItem(SESSION_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    // Private mode, or storage disabled. A fresh session is the right fallback.
    return null;
  }
};

export const writeStoredSession = (id: string | null, storage?: Storage): void => {
  try {
    const store = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return;
    if (id) store.setItem(SESSION_KEY, id);
    else store.removeItem(SESSION_KEY);
  } catch {
    // Not being able to remember the session is a worse conversation, not a
    // broken app.
  }
};

/** The window the board is showing, in the headers the server parses. */
export interface ChatScope {
  readonly dashboardId: string | null;
  readonly range: string | null;
  /**
   * What is actually on screen, when it is more specific than the board.
   *
   * A record page is the case that matters: somebody looking at one record and
   * asking "what is this?" means that one, and the assistant has no way to
   * know unless it is told. Encoded rather than sent as a payload because it
   * is two ids and a kind, and the transport already carries headers.
   */
  readonly view: string | null;
}

/**
 * How the live board reports itself upward.
 *
 * The scope has to be read fresh on every request rather than baked into the
 * transport: `FetchTransport` is constructed once inside the provider, so a
 * header closure captures whatever was current at first mount. That only
 * stayed correct before because the provider remounted on every tab change —
 * which is the bug being fixed here, so it cannot be relied on again.
 */
const ChatScopeContext = createContext<((scope: ChatScope) => void) | null>(null);

export interface ChatSessionProps {
  readonly children: ReactNode;
}

/**
 * Tells the conversation which board and window it is about.
 *
 * Rendered inside `<Dashboard>` so it can read the window the board actually
 * resolved — the browser anchors its range to an instant that only moves when
 * the user acts, so a range recomputed on the server would describe a
 * different window from the tiles being discussed.
 */
export const ChatScopeReporter = ({
  dashboardId,
  openRecord,
}: {
  readonly dashboardId: string | null;
  /** The record page currently open, when one is. */
  readonly openRecord?: { readonly widgetId: string; readonly recordId: string } | undefined;
}): null => {
  const report = useContext(ChatScopeContext);
  // Optional: the assistant also opens on an empty workspace, where there is
  // no board and so no window to report.
  const dashboard = useOptionalDashboard();
  const range = dashboard?.params.range ?? null;
  const encoded = range
    ? `${range.preset}:${range.start}:${range.end}:${range.grain}`
    : null;

  const view = openRecord
    ? `record:${encodeURIComponent(openRecord.widgetId)}:${encodeURIComponent(openRecord.recordId)}`
    : "board";

  useEffect(() => {
    report?.({ dashboardId, range: encoded, view });
  }, [report, dashboardId, encoded, view]);
  return null;
};

export const ChatSession = ({ children }: ChatSessionProps): JSX.Element => {
  const scopeRef = useRef<ChatScope>({ dashboardId: null, range: null, view: null });
  const report = useMemo(
    () => (scope: ChatScope) => {
      scopeRef.current = scope;
    },
    [],
  );

  /*
   * An empty client registry. The server builds the real one per turn; this
   * only satisfies the provider, which wants somewhere to look up a component
   * it might render inline. Dash renders its own widgets.
   */
  const registry = useMemo(() => createComponentRegistry<ReactNode>(), []);

  const transportOptions = useMemo(
    () => ({
      baseUrl: "/freebird",
      headers: (): Record<string, string> => {
        const current = scopeRef.current;
        return {
          ...(current.dashboardId ? { "x-dash-dashboard": current.dashboardId } : {}),
          ...(current.range ? { "x-dash-range": current.range } : {}),
          ...(current.view ? { "x-dash-view": current.view } : {}),
        };
      },
    }),
    [],
  );

  /*
   * Read once, at mount. A later write must not change what the provider was
   * constructed with, or the store would be recreated and the wipe would be
   * back in a different disguise.
   */
  const initialSessionId = useMemo(() => readStoredSession(), []);

  return (
    <ChatScopeContext.Provider value={report}>
      <FreeBirdProvider
        registry={registry}
        transportOptions={transportOptions}
        {...(initialSessionId ? { initialSessionId } : {})}
      >
        {children}
      </FreeBirdProvider>
    </ChatScopeContext.Provider>
  );
};
