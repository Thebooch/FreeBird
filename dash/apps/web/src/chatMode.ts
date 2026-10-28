import { useCallback, useEffect, useState } from "react";

/**
 * Where the assistant sits: nowhere, beside the page, or in place of it.
 *
 * One conversation in all three. Only the column's shape changes, so the
 * topic, the scroll and a half-written message survive Docked ↔ Full screen.
 *
 * Full screen is a history entry rather than a route of its own. Every page
 * keeps its address, Back leaves full screen the way it closes a record, and
 * the chat can go full screen over a board, Comms or the agent alike without
 * any of them learning a new route. The entry is the same URL with a marker in
 * `history.state`, which also survives a reload.
 *
 * Leaving the page — a tab, a mode, a record, a chip — docks it. You asked to
 * see something, and seeing it beside the answer is the point.
 */
export type ChatMode = "closed" | "docked" | "full";

/** The marker on a full-screen history entry. */
const FULL = "dashChat";

/** Where the last open/closed choice is kept, beside the session id. */
export const CHAT_MODE_KEY = "dash.chat.mode";

/** Where a dragged column width is kept. Per viewer, so `localStorage`. */
export const CHAT_WIDTH_KEY = "dash.chat.width";

export const CHAT_WIDTH_MIN = 320;
export const CHAT_WIDTH_MAX = 640;

export const isFullEntry = (state: unknown): boolean =>
  typeof state === "object" && state !== null && (state as Record<string, unknown>)[FULL] === "full";

/** `history.state` with the marker added or taken off, keeping anything else on it. */
export const withFullMarker = (state: unknown, full: boolean): Record<string, unknown> | null => {
  const rest = typeof state === "object" && state !== null ? { ...(state as Record<string, unknown>) } : {};
  delete rest[FULL];
  if (full) return { ...rest, [FULL]: "full" };
  return Object.keys(rest).length > 0 ? rest : null;
};

/**
 * What the chat opens as on load.
 *
 * A full-screen entry reloads full screen. Otherwise the last choice in this
 * tab: a docked column stays docked across a reload, as the topic does.
 */
export const initialChatMode = (historyState: unknown, stored: string | null): ChatMode =>
  isFullEntry(historyState) ? "full" : stored === "docked" ? "docked" : "closed";

/** Back or Forward onto an entry: the marker decides full screen, and leaving it docks. */
export const modeAfterPop = (current: ChatMode, historyState: unknown): ChatMode =>
  isFullEntry(historyState) ? "full" : current === "full" ? "docked" : current;

/** Any navigation the app makes docks a full-screen chat and leaves the rest alone. */
export const modeAfterNavigate = (current: ChatMode): ChatMode => (current === "full" ? "docked" : current);

/** Opening keeps full screen full; closing closes from either. */
export const modeAfterToggle = (current: ChatMode, open: boolean): ChatMode =>
  open ? (current === "closed" ? "docked" : current) : "closed";

/** The remembered choice. Full screen is remembered as docked: the history entry carries full. */
export const storedFormOf = (mode: ChatMode): "closed" | "docked" => (mode === "closed" ? "closed" : "docked");

export const clampChatWidth = (width: number): number =>
  Math.round(Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, width)));

/** A stored width, or null when there is none or it is not a number. */
export const parseChatWidth = (raw: string | null): number | null => {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clampChatWidth(value) : null;
};

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch {
    // Private mode, or storage disabled: the defaults are fine.
    return null;
  }
};

const write = (store: () => Storage, key: string, value: string): void => {
  try {
    store().setItem(key, value);
  } catch {
    // Not remembering where the chat was is a small loss, not a broken app.
  }
};

export interface ChatModeControls {
  readonly mode: ChatMode;
  /** The column is showing, docked or full. */
  readonly open: boolean;
  /** Open (docked, or as it was) or close. */
  readonly setOpen: (open: boolean) => void;
  readonly enterFull: () => void;
  readonly exitFull: () => void;
  /** A width the person dragged to, or null for the default. */
  readonly width: number | null;
  readonly setWidth: (width: number) => void;
}

/**
 * The chat's mode, kept in step with the address bar.
 *
 * Listens for `dash:route` (the app's own `navigate`) to dock, and for
 * `popstate` to follow Back and Forward onto or off a full-screen entry.
 * `hashchange` is left out on purpose: it fires after `popstate` on a Back
 * between two addresses and would dock what the marker just restored.
 */
export const useChatMode = (): ChatModeControls => {
  const [mode, setMode] = useState<ChatMode>(() =>
    initialChatMode(window.history.state, read(() => sessionStorage, CHAT_MODE_KEY)),
  );
  const [width, setWidthState] = useState<number | null>(() =>
    parseChatWidth(read(() => localStorage, CHAT_WIDTH_KEY)),
  );

  useEffect(() => write(() => sessionStorage, CHAT_MODE_KEY, storedFormOf(mode)), [mode]);

  useEffect(() => {
    const onPop = (): void => setMode((current) => modeAfterPop(current, window.history.state));
    const onNavigate = (): void => setMode(modeAfterNavigate);
    window.addEventListener("popstate", onPop);
    window.addEventListener("dash:route", onNavigate);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("dash:route", onNavigate);
    };
  }, []);

  const enterFull = useCallback(() => {
    if (isFullEntry(window.history.state)) {
      setMode("full");
      return;
    }
    // Same address, one entry deeper: Back comes out of full screen and stays on the page.
    window.history.pushState(withFullMarker(window.history.state, true), "", window.location.href);
    setMode("full");
  }, []);

  const exitFull = useCallback(() => {
    /*
     * Back over our own entry, so the history does not keep a full-screen
     * step that Forward would reopen after the person chose to leave it.
     * `popstate` then docks.
     */
    if (isFullEntry(window.history.state)) window.history.back();
    else setMode(modeAfterNavigate);
  }, []);

  const setOpen = useCallback((open: boolean) => {
    // Closing from full screen takes the marker off, so a reload does not reopen it.
    if (!open && isFullEntry(window.history.state)) {
      window.history.replaceState(withFullMarker(window.history.state, false), "", window.location.href);
    }
    setMode((current) => modeAfterToggle(current, open));
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampChatWidth(next);
    setWidthState(clamped);
    write(() => localStorage, CHAT_WIDTH_KEY, String(clamped));
  }, []);

  return { mode, open: mode !== "closed", setOpen, enterFull, exitFull, width, setWidth };
};
