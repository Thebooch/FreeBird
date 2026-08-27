import { useCallback, useEffect } from "react";
import { useFreeBird } from "../provider.js";
import type { ChatMessage, Reference } from "@freebirdai/core";

export interface UseChatOptions {
  /** If true (default), automatically loads messages when sessionId changes. */
  autoLoadMessages?: boolean;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  /** The partial assistant text while streaming (before the message is persisted). */
  streamingText: string;
  streaming: boolean;
  /** References surfaced on the latest assistant reply. */
  latestReferences: Reference[];
  send: (text: string) => Promise<void>;
  /**
   * Ask the chat to explain a component by id. Called by InfoTrigger;
   * also safe to call directly ("I clicked the info button").
   */
  explain: (componentId: string) => Promise<void>;
  /** Aborts any active stream. */
  abort: () => void;
}

/**
 * Main chat hook. Thin reactive wrapper over FreeBirdStore — all of the
 * streaming logic, text delta accumulation, and abort handling lives in
 * `@freebirdai/core-state` so Vue/Angular share it.
 */
export const useChat = (opts: UseChatOptions = {}): UseChatReturn => {
  const fb = useFreeBird();

  // Load messages when session changes.
  useEffect(() => {
    if (!fb.sessionId || opts.autoLoadMessages === false) return;
    let cancelled = false;
    fb.transport.listMessages(fb.sessionId).then((msgs) => {
      if (!cancelled) fb.setMessages(msgs);
    });
    return () => {
      cancelled = true;
    };
  }, [fb.sessionId]); // deliberately keyed on sessionId only

  const send = useCallback((text: string) => fb.store.send(text), [fb.store]);
  const explain = useCallback(
    (componentId: string) => fb.store.explain(componentId),
    [fb.store],
  );
  const abort = useCallback(() => fb.store.abort(), [fb.store]);

  // Wire up InfoTrigger broadcasts.
  useEffect(() => {
    return fb.onExplain((componentId) => {
      explain(componentId).catch((e) => console.error("[freebird] explain error", e));
    });
  }, [fb, explain]);

  return {
    messages: fb.messages,
    streamingText: fb.streamingText,
    streaming: fb.streaming,
    latestReferences: fb.latestReferences,
    send,
    explain,
    abort,
  };
};
