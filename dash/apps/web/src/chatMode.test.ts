import { describe, expect, it } from "vitest";
import {
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  initialChatMode,
  isFullEntry,
  modeAfterNavigate,
  modeAfterPop,
  modeAfterToggle,
  parseChatWidth,
  storedFormOf,
  withFullMarker,
} from "./chatMode.js";

/**
 * One conversation, three places to be. These are the rules the shell follows
 * when something moves it; the hook only wires them to the history.
 */
describe("the chat's mode", () => {
  it("opens docked and keeps full screen full when opened again", () => {
    expect(modeAfterToggle("closed", true)).toBe("docked");
    expect(modeAfterToggle("docked", true)).toBe("docked");
    expect(modeAfterToggle("full", true)).toBe("full");
  });

  it("closes from either open mode", () => {
    expect(modeAfterToggle("docked", false)).toBe("closed");
    expect(modeAfterToggle("full", false)).toBe("closed");
  });

  it("docks when the page changes, and leaves a docked or closed chat alone", () => {
    // A tab, a mode, a record, a chip: you asked to see something, so it shows beside the answer.
    expect(modeAfterNavigate("full")).toBe("docked");
    expect(modeAfterNavigate("docked")).toBe("docked");
    expect(modeAfterNavigate("closed")).toBe("closed");
  });

  it("follows Back and Forward onto and off a full-screen entry", () => {
    const full = withFullMarker(null, true);
    expect(modeAfterPop("docked", full)).toBe("full");
    expect(modeAfterPop("closed", full)).toBe("full");
    // Back off it docks rather than closing: the person left full screen, not the chat.
    expect(modeAfterPop("full", null)).toBe("docked");
    expect(modeAfterPop("closed", null)).toBe("closed");
  });
});

describe("the full-screen history marker", () => {
  it("is added and removed without disturbing anything else in the state", () => {
    const marked = withFullMarker({ other: 1 }, true);
    expect(isFullEntry(marked)).toBe(true);
    expect(marked).toMatchObject({ other: 1 });

    const cleared = withFullMarker(marked, false);
    expect(isFullEntry(cleared)).toBe(false);
    expect(cleared).toEqual({ other: 1 });
  });

  it("leaves no state behind when there was none to keep", () => {
    expect(withFullMarker(withFullMarker(null, true), false)).toBeNull();
  });

  it("is not mistaken for anything else a page puts in history", () => {
    expect(isFullEntry(null)).toBe(false);
    expect(isFullEntry("full")).toBe(false);
    expect(isFullEntry({ dashChat: "docked" })).toBe(false);
  });
});

describe("what a reload restores", () => {
  it("restores full screen from the entry, not from storage", () => {
    expect(initialChatMode(withFullMarker(null, true), "closed")).toBe("full");
    // Storage only ever says docked or closed: another tab's full screen is not this one's.
    expect(initialChatMode(null, "full")).toBe("closed");
  });

  it("restores a docked column and otherwise starts closed", () => {
    expect(initialChatMode(null, "docked")).toBe("docked");
    expect(initialChatMode(null, "closed")).toBe("closed");
    expect(initialChatMode(null, null)).toBe("closed");
  });

  it("remembers full screen as docked", () => {
    expect(storedFormOf("full")).toBe("docked");
    expect(storedFormOf("docked")).toBe("docked");
    expect(storedFormOf("closed")).toBe("closed");
  });
});

describe("a dragged column width", () => {
  it("is kept inside the column's limits", () => {
    expect(parseChatWidth("100")).toBe(CHAT_WIDTH_MIN);
    expect(parseChatWidth("5000")).toBe(CHAT_WIDTH_MAX);
    expect(parseChatWidth("455.6")).toBe(456);
  });

  it("falls back to the default when nothing usable is stored", () => {
    expect(parseChatWidth(null)).toBeNull();
    expect(parseChatWidth("wide")).toBeNull();
  });
});
