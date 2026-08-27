import { onMounted, onUnmounted, watch, type ComputedRef } from "vue";
import type { ChatMessage, Reference } from "@freebirdai/core";
import { useFreeBird } from "./useFreeBird.js";

export interface UseChatOptions {
  /** If true (default), automatically loads messages when sessionId changes. */
  autoLoadMessages?: boolean;
}

export interface UseChatReturn {
  messages: ComputedRef<ChatMessage[]>;
  streamingText: ComputedRef<string>;
  streaming: ComputedRef<boolean>;
  latestReferences: ComputedRef<Reference[]>;
  send: (text: string) => Promise<void>;
  explain: (componentId: string) => Promise<void>;
  abort: () => void;
}

/**
 * Vue composable version of the React `useChat` hook. All streaming and
 * SSE handling lives in `FreeBirdStore` so this is a thin reactive wrapper.
 */
export const useChat = (opts: UseChatOptions = {}): UseChatReturn => {
  const fb = useFreeBird();

  if (opts.autoLoadMessages !== false) {
    watch(
      () => fb.sessionId.value,
      (id) => {
        if (!id) return;
        fb.transport.listMessages(id).then((msgs) => {
          // Only overwrite if we're still looking at the same session.
          if (fb.sessionId.value === id) fb.setMessages(msgs);
        });
      },
      { immediate: true },
    );
  }

  const explain = (componentId: string) => fb.store.explain(componentId);

  // Wire up InfoTrigger broadcasts. Cleanup on unmount.
  let off: (() => void) | null = null;
  onMounted(() => {
    off = fb.onExplain((componentId) => {
      explain(componentId).catch((e) =>
         
        console.error("[freebird] explain error", e),
      );
    });
  });
  onUnmounted(() => {
    off?.();
    off = null;
  });

  return {
    messages: fb.messages,
    streamingText: fb.streamingText,
    streaming: fb.streaming,
    latestReferences: fb.latestReferences,
    send: (text) => fb.store.send(text),
    explain,
    abort: () => fb.store.abort(),
  };
};
