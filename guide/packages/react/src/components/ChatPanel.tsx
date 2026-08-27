import React, { useEffect, useState } from "react";
import type { ChatMessage, ComponentCitation } from "@freebirdai/core";
import {
  activateCitation,
  citationsFromToolPayload,
  replayPendingCitation,
} from "@freebirdai/core";
import { useChat } from "../hooks/useChat.js";
import { useSession } from "../hooks/useSession.js";
import { useFreeBird } from "../provider.js";
import { slotWith, type SlotProps } from "./Slot.js";

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
 * Headless ChatPanel primitives. Compose them yourself:
 *
 * <ChatPanel.Root>
 *   <ChatPanel.Messages>
 *     {({ messages, streamingText }) => messages.map(...)}
 *   </ChatPanel.Messages>
 *   <ChatPanel.Form>
 *     <ChatPanel.Input />
 *     <ChatPanel.Submit>Send</ChatPanel.Submit>
 *   </ChatPanel.Form>
 * </ChatPanel.Root>
 *
 * Every primitive stamps `data-freebird-*` attributes so any styling system
 * can hook onto them. @freebirdai/react-tailwind ships a pre-styled variant.
 */

// ---------------------------------------------------------------------------
// Root (just a scoped wrapper + data attrs)
// ---------------------------------------------------------------------------
export interface ChatPanelRootProps
  extends React.HTMLAttributes<HTMLDivElement>,
    SlotProps {
  /**
   * When true (default), creates a chat session on mount so `useChat().send`
   * works immediately. Set false if you manage sessions yourself with
   * `useSession({ autoCreate: false })`.
   */
  sessionAutoCreate?: boolean;
  /** Passed to the auto-created session (optional). */
  sessionTopic?: string;
  /** Passed to the auto-created session (optional). */
  sessionTags?: string[];
}

const Root: React.FC<ChatPanelRootProps> = (props) => {
  const {
    sessionAutoCreate = true,
    sessionTopic,
    sessionTags,
    ...rest
  } = props;
  useSession({
    autoCreate: sessionAutoCreate,
    topic: sessionTopic,
    tags: sessionTags,
  });
  // A citation click may have navigated here — finish the scroll+highlight.
  useEffect(() => {
    void replayPendingCitation();
  }, []);
  return slotWith("div", { ...rest, "data-freebird-chat": "" } as any);
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export interface ChatPanelMessagesRenderProps {
  messages: ChatMessage[];
  streamingText: string;
  streaming: boolean;
}

export interface ChatPanelMessagesProps {
  /** Render prop — do anything you want with the message list. */
  children: (state: ChatPanelMessagesRenderProps) => React.ReactNode;
  className?: string;
}

const Messages: React.FC<ChatPanelMessagesProps> = ({ children, className }) => {
  const chat = useChat();
  return (
    <div data-freebird-chat-messages="" className={className}>
      {children({
        messages: chat.messages,
        streamingText: chat.streamingText,
        streaming: chat.streaming,
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Form (wraps an <input> and a submit button, wires to useChat.send)
// ---------------------------------------------------------------------------
export interface ChatPanelFormProps
  extends Omit<React.FormHTMLAttributes<HTMLFormElement>, "onSubmit"> {
  /** Called before send with the raw text. Return false to cancel. */
  beforeSend?: (text: string) => boolean | Promise<boolean>;
  /** Called after send finishes (success or error). */
  afterSend?: () => void;
  children: React.ReactNode;
}

interface FormCtxValue {
  value: string;
  setValue: (v: string) => void;
  streaming: boolean;
  /** False while the default auto-created session is still being created. */
  sessionReady: boolean;
  submit: () => void;
}
const FormCtx = React.createContext<FormCtxValue | null>(null);

const Form: React.FC<ChatPanelFormProps> = ({ beforeSend, afterSend, children, ...rest }) => {
  const { send, streaming } = useChat();
  const fb = useFreeBird();
  const [value, setValue] = useState("");

  const submit = async () => {
    const text = value.trim();
    if (!text || streaming || !fb.sessionId) return;
    if (beforeSend && (await beforeSend(text)) === false) return;
    setValue("");
    try {
      await send(text);
    } finally {
      afterSend?.();
    }
  };

  return (
    <FormCtx.Provider
      value={{
        value,
        setValue,
        streaming,
        sessionReady: fb.sessionId != null,
        submit,
      }}
    >
      <form
        data-freebird-chat-form=""
        {...rest}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {children}
      </form>
    </FormCtx.Provider>
  );
};

const useForm = (): FormCtxValue => {
  const v = React.useContext(FormCtx);
  if (!v) throw new Error("ChatPanel.Input / Submit must be inside <ChatPanel.Form>");
  return v;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export interface ChatPanelInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  /** Optional controlled override. */
  value?: string;
  onValueChange?: (v: string) => void;
}

const Input: React.FC<ChatPanelInputProps> = ({ value, onValueChange, ...rest }) => {
  const form = useForm();
  return (
    <input
      data-freebird-chat-input=""
      type="text"
      value={value ?? form.value}
      onChange={(e) => {
        onValueChange?.(e.target.value);
        form.setValue(e.target.value);
      }}
      disabled={form.streaming || !form.sessionReady || rest.disabled}
      {...rest}
    />
  );
};

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
export interface ChatPanelSubmitProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    SlotProps {}

const Submit: React.FC<ChatPanelSubmitProps> = (props) => {
  const form = useForm();
  const disabled =
    form.streaming || !form.sessionReady || !form.value.trim() || props.disabled;
  return slotWith("button", {
    type: "submit",
    ...props,
    disabled,
    "data-freebird-chat-submit": "",
    "data-streaming": form.streaming ? "" : undefined,
  } as any);
};

// ---------------------------------------------------------------------------
// Citations (chips under an assistant reply; also composable standalone)
// ---------------------------------------------------------------------------
export interface ChatPanelCitationsProps {
  message: ChatMessage;
  /** Client-side routing hook for cross-page citations. */
  onCitationNavigate?: CitationNavigateHandler;
  className?: string;
}

const Citations: React.FC<ChatPanelCitationsProps> = ({
  message,
  onCitationNavigate,
  className,
}) => {
  if (message.role !== "assistant") return null;
  const citations = citationsFromToolPayload(message.toolPayload);
  if (citations.length === 0) return null;
  return (
    <div data-freebird-chat-citations="" className={className}>
      {citations.map((citation, i) => (
        <button
          key={`${citation.componentId}-${i}`}
          type="button"
          data-freebird-chat-citation=""
          data-kind={citation.kind ?? "component"}
          data-component={citation.componentId}
          onClick={() =>
            void activateCitation(citation, {
              ...(onCitationNavigate ? { onNavigate: onCitationNavigate } : {}),
            })
          }
        >
          {citation.title}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Message (convenience renderer for a single message)
// ---------------------------------------------------------------------------
export interface ChatPanelMessageProps extends React.HTMLAttributes<HTMLDivElement> {
  message: ChatMessage;
  /** Client-side routing hook for cross-page citation chips. */
  onCitationNavigate?: CitationNavigateHandler;
}

const Message: React.FC<ChatPanelMessageProps> = ({
  message,
  onCitationNavigate,
  ...rest
}) => (
  <div
    data-freebird-chat-message=""
    data-role={message.role}
    {...rest}
  >
    {message.content}
    {message.references.length > 0 && (
      <div data-freebird-chat-refs="">
        {message.references.map((r, i) => (
          <span key={i} data-freebird-chat-ref="" data-tag={r.tag} data-component={r.componentId}>
            {r.reason}
          </span>
        ))}
      </div>
    )}
    <Citations
      message={message}
      {...(onCitationNavigate ? { onCitationNavigate } : {})}
    />
  </div>
);

export const ChatPanel = {
  Root,
  Messages,
  Form,
  Input,
  Submit,
  Message,
  Citations,
};
