import {
  defineComponent,
  h,
  inject,
  onMounted,
  provide,
  ref,
  computed,
  type InjectionKey,
  type PropType,
  type Ref,
} from "vue";
import type { ChatMessage, ComponentCitation } from "@freebirdai/core";
import {
  activateCitation,
  citationsFromToolPayload,
  parseChatBoldSegments,
  replayPendingCitation,
} from "@freebirdai/core";
import { useFreeBird } from "../composables/useFreeBird.js";
import { useSession } from "../composables/useSession.js";
import { useChat } from "../composables/useChat.js";

/**
 * Host hook for client-side routing when a citation targets another page.
 * Return `false` to fall back to a full-page `location.assign`; anything
 * else (including void) means the host's router handled it.
 */
export type CitationNavigateHandler = (
  path: string,
  citation: ComponentCitation,
) => void | boolean | Promise<void | boolean>;

/**
 * Internal form context shared between Form/Input/Submit. Mirrors the
 * React FormCtx exactly.
 */
interface FormContext {
  value: Ref<string>;
  streaming: Ref<boolean>;
  sessionReady: Ref<boolean>;
  submit: () => Promise<void>;
}
const FORM_KEY: InjectionKey<FormContext> = Symbol("freebird-chat-form");
const useFormCtx = (): FormContext => {
  const ctx = inject(FORM_KEY);
  if (!ctx) {
    throw new Error(
      "ChatPanelInput / ChatPanelSubmit must be used inside <ChatPanelForm>.",
    );
  }
  return ctx;
};

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export const ChatPanelRoot = defineComponent({
  name: "FreeBirdChatPanelRoot",
  props: {
    sessionAutoCreate: { type: Boolean, default: true },
    sessionTopic: { type: String, default: undefined },
    sessionTags: { type: Array as PropType<string[]>, default: undefined },
  },
  setup(props, { slots }) {
    useSession({
      autoCreate: props.sessionAutoCreate,
      topic: props.sessionTopic,
      tags: props.sessionTags,
    });
    // A citation click may have navigated here — finish the scroll+highlight.
    onMounted(() => {
      void replayPendingCitation();
    });
    return () =>
      h(
        "div",
        { "data-freebird-chat": "" },
        slots.default ? slots.default() : undefined,
      );
  },
});

// ---------------------------------------------------------------------------
// Messages (scoped slot: { messages, streamingText, streaming })
// ---------------------------------------------------------------------------
export const ChatPanelMessages = defineComponent({
  name: "FreeBirdChatPanelMessages",
  setup(_, { slots }) {
    const chat = useChat();
    return () =>
      h(
        "div",
        { "data-freebird-chat-messages": "" },
        slots.default
          ? slots.default({
              messages: chat.messages.value,
              streamingText: chat.streamingText.value,
              streaming: chat.streaming.value,
            })
          : undefined,
      );
  },
});

// ---------------------------------------------------------------------------
// Form (wraps <input> + submit button, wires to store.send)
// ---------------------------------------------------------------------------
export const ChatPanelForm = defineComponent({
  name: "FreeBirdChatPanelForm",
  props: {
    beforeSend: {
      type: Function as PropType<(text: string) => boolean | Promise<boolean>>,
      default: undefined,
    },
    afterSend: {
      type: Function as PropType<() => void>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const { send, streaming } = useChat();
    const fb = useFreeBird();
    const value = ref("");
    const sessionReady = computed(() => fb.sessionId.value != null);

    const submit = async (): Promise<void> => {
      const text = value.value.trim();
      if (!text || streaming.value || !sessionReady.value) return;
      if (props.beforeSend && (await props.beforeSend(text)) === false) return;
      value.value = "";
      try {
        await send(text);
      } finally {
        props.afterSend?.();
      }
    };

    provide(FORM_KEY, { value, streaming, sessionReady, submit });

    return () =>
      h(
        "form",
        {
          "data-freebird-chat-form": "",
          onSubmit: (e: Event) => {
            e.preventDefault();
            void submit();
          },
        },
        slots.default ? slots.default() : undefined,
      );
  },
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export const ChatPanelInput = defineComponent({
  name: "FreeBirdChatPanelInput",
  props: {
    placeholder: { type: String, default: undefined },
    disabled: { type: Boolean, default: false },
  },
  setup(props) {
    const form = useFormCtx();
    return () =>
      h("input", {
        "data-freebird-chat-input": "",
        type: "text",
        value: form.value.value,
        placeholder: props.placeholder,
        disabled: form.streaming.value || !form.sessionReady.value || props.disabled,
        onInput: (e: Event) => {
          form.value.value = (e.target as HTMLInputElement).value;
        },
      });
  },
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
export const ChatPanelSubmit = defineComponent({
  name: "FreeBirdChatPanelSubmit",
  props: {
    disabled: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const form = useFormCtx();
    return () => {
      const disabled =
        form.streaming.value ||
        !form.sessionReady.value ||
        !form.value.value.trim() ||
        props.disabled;
      return h(
        "button",
        {
          type: "submit",
          "data-freebird-chat-submit": "",
          "data-streaming": form.streaming.value ? "" : undefined,
          disabled,
        },
        slots.default ? slots.default() : "Send",
      );
    };
  },
});

// ---------------------------------------------------------------------------
// Citations (chips under an assistant reply; also composable standalone)
// ---------------------------------------------------------------------------
export const ChatPanelCitations = defineComponent({
  name: "FreeBirdChatPanelCitations",
  props: {
    message: { type: Object as PropType<ChatMessage>, required: true },
    /** Client-side routing hook for cross-page citations. */
    onCitationNavigate: {
      type: Function as PropType<CitationNavigateHandler>,
      default: undefined,
    },
  },
  setup(props) {
    return () => {
      if (props.message.role !== "assistant") return null;
      const citations = citationsFromToolPayload(props.message.toolPayload);
      if (citations.length === 0) return null;
      return h(
        "div",
        { "data-freebird-chat-citations": "" },
        citations.map((citation, i) =>
          h(
            "button",
            {
              key: `${citation.componentId}-${i}`,
              type: "button",
              "data-freebird-chat-citation": "",
              "data-kind": citation.kind ?? "component",
              "data-component": citation.componentId,
              onClick: () =>
                void activateCitation(citation, {
                  ...(props.onCitationNavigate
                    ? { onNavigate: props.onCitationNavigate }
                    : {}),
                }),
            },
            citation.title,
          ),
        ),
      );
    };
  },
});

// ---------------------------------------------------------------------------
// Message (single message renderer, convenience)
// ---------------------------------------------------------------------------
export const ChatPanelMessage = defineComponent({
  name: "FreeBirdChatPanelMessage",
  props: {
    message: { type: Object as PropType<ChatMessage>, required: true },
    /** When true, render `**bold**` segments in assistant/user text. */
    formatBold: { type: Boolean, default: false },
    /** Client-side routing hook for cross-page citation chips. */
    onCitationNavigate: {
      type: Function as PropType<CitationNavigateHandler>,
      default: undefined,
    },
  },
  setup(props) {
    const renderContent = (text: string) => {
      if (!props.formatBold) return text;
      const segments = parseChatBoldSegments(text);
      return segments.map((seg, i) =>
        seg.kind === "bold"
          ? h("strong", { key: i }, seg.value)
          : seg.value,
      );
    };
    return () =>
      h(
        "div",
        {
          "data-freebird-chat-message": "",
          "data-role": props.message.role,
        },
        [
          renderContent(props.message.content),
          props.message.references.length > 0
            ? h(
                "div",
                { "data-freebird-chat-refs": "" },
                props.message.references.map((r, i) =>
                  h(
                    "span",
                    {
                      key: i,
                      "data-freebird-chat-ref": "",
                      "data-tag": r.tag,
                      "data-component": r.componentId,
                    },
                    r.reason,
                  ),
                ),
              )
            : null,
          h(ChatPanelCitations, {
            message: props.message,
            ...(props.onCitationNavigate
              ? { onCitationNavigate: props.onCitationNavigate }
              : {}),
          }),
        ],
      );
  },
});

/**
 * Grouped export so consumers can write `<ChatPanel.Root>` just like the
 * React package. Vue template users can destructure in imports:
 *
 *   import { ChatPanel } from "@freebirdai/vue";
 *   // template: <ChatPanel.Root>...</ChatPanel.Root>
 */
export const ChatPanel = {
  Root: ChatPanelRoot,
  Messages: ChatPanelMessages,
  Form: ChatPanelForm,
  Input: ChatPanelInput,
  Submit: ChatPanelSubmit,
  Message: ChatPanelMessage,
  Citations: ChatPanelCitations,
};
