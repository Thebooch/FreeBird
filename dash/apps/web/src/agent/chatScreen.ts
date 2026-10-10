import { DASH_SCREENS, type DashScreen } from "@freebirdai/dash-spec";
import { useFreeBird } from "@freebirdai/react";
import { useEffect } from "react";

/**
 * Telling the chat what is on screen, in guide's own terms.
 *
 * Each calendar and contacts screen is a guide component the server
 * registers with its actions (`chat/screens/`). While one is on screen it is
 * active, which is context for the chat — what "this" and "here" mean — and
 * never a limit: everything stays askable from anywhere. The one thing open
 * in it (a type being edited, a booking's sheet) is its focus, so "make this
 * one need approval" needs no follow-up question.
 */

/** The chat's store, or null where no chat is mounted (a screen rendered on its own, in a test). */
const useChatStore = () => {
  try {
    return useFreeBird().store;
  } catch {
    return null;
  }
};

/** These screens are on screen while the caller is mounted. */
export const useChatScreen = (screens: readonly DashScreen[]): void => {
  const store = useChatStore();
  const key = screens.join(",");
  useEffect(() => {
    if (!store) return undefined;
    store.setActiveComponentIds(key.split(",").filter(Boolean).map((one) => DASH_SCREENS[one as DashScreen].id));
    return () => store.setActiveComponentIds([]);
  }, [store, key]);
};

/** The one thing open on a screen, while it is open. */
export const useChatFocus = (screen: DashScreen, item: { readonly id: string; readonly label: string } | null): void => {
  const store = useChatStore();
  const id = item?.id;
  const label = item?.label;
  useEffect(() => {
    if (!store || !id) return undefined;
    store.setFocus({ componentId: DASH_SCREENS[screen].id, itemId: id, ...(label ? { label } : {}) });
    return () => store.setFocus(null);
  }, [store, screen, id, label]);
};

/** The attribute a screen's region carries, for citations and "take me there". */
export const screenAttrs = (screen: DashScreen): { readonly "data-freebird-component": string } => ({ "data-freebird-component": DASH_SCREENS[screen].id });

/** The attribute one item on a screen carries: a row, a card, a chip. */
export const itemAttrs = (id: string): { readonly "data-freebird-item": string } => ({ "data-freebird-item": id });

/** A change the chat made to a screen's data, so the screen reads it again. */
const SCREEN_CHANGED = "dash:screen-changed";

/** Say a screen's data changed: after an approved action on it. */
export const announceScreenChange = (componentId: string): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(SCREEN_CHANGED, { detail: componentId }));
};

/** Whether a component id is one of the screens. */
export const isScreenId = (componentId: string): boolean => Object.values(DASH_SCREENS).some((one) => one.id === componentId);

/** Read again when the chat changes one of these screens' data. */
export const useScreenChanged = (screens: readonly DashScreen[], onChange: () => void): void => {
  const key = screens.join(",");
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const ids = new Set<string>(key.split(",").filter(Boolean).map((one) => DASH_SCREENS[one as DashScreen].id));
    const heard = (event: Event) => {
      if (ids.has((event as CustomEvent<string>).detail)) onChange();
    };
    window.addEventListener(SCREEN_CHANGED, heard);
    return () => window.removeEventListener(SCREEN_CHANGED, heard);
  }, [key, onChange]);
};
