import React from "react";
import type { ChatMessage } from "@freebirdai/core";
import {
  ChatPanel as HeadlessChatPanel,
  DynamicGrid as HeadlessDynamicGrid,
  LockToggle as HeadlessLockToggle,
  InfoTrigger as HeadlessInfoTrigger,
  CustomTabBar as HeadlessCustomTabBar,
  type DynamicGridProps,
  type LockToggleProps,
  type InfoTriggerProps,
} from "@freebirdai/react";

/**
 * Pre-styled FreeBird components built on `@freebirdai/react` primitives.
 * Everything is governed by CSS variables declared in `./styles.css`
 * (which you import once at your app root).
 *
 * To theme, override the variables in your own :root rule:
 *
 *   :root {
 *     --freebird-accent: #f97316;
 *     --freebird-radius: 1rem;
 *   }
 */

// ---------------------------------------------------------------------------
// ChatPanel (opinionated default layout)
// ---------------------------------------------------------------------------

export interface StyledChatPanelProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Submit button label. Defaults to "Send". */
  sendLabel?: string;
  /** Placeholder for the input. */
  placeholder?: string;
  /** Optional message renderer override. */
  renderMessage?: (m: ChatMessage) => React.ReactNode;
}

export const ChatPanel: React.FC<StyledChatPanelProps> = ({
  sendLabel = "Send",
  placeholder = "Ask anything…",
  renderMessage,
  ...rest
}) => (
  <HeadlessChatPanel.Root {...rest}>
    <HeadlessChatPanel.Messages>
      {({ messages, streamingText, streaming }) => (
        <>
          {messages.map((m) =>
            renderMessage ? (
              <React.Fragment key={m.id}>{renderMessage(m)}</React.Fragment>
            ) : (
              <HeadlessChatPanel.Message key={m.id} message={m} />
            ),
          )}
          {streaming && streamingText && (
            <div data-freebird-chat-message="" data-role="assistant">
              {streamingText}
              <span aria-hidden="true" style={{ opacity: 0.5 }}>
                {" "}
                ▍
              </span>
            </div>
          )}
        </>
      )}
    </HeadlessChatPanel.Messages>
    <HeadlessChatPanel.Form>
      <HeadlessChatPanel.Input placeholder={placeholder} />
      <HeadlessChatPanel.Submit>{sendLabel}</HeadlessChatPanel.Submit>
    </HeadlessChatPanel.Form>
  </HeadlessChatPanel.Root>
);

// ---------------------------------------------------------------------------
// DynamicGrid (with built-in LockToggle + InfoTrigger overlays)
// ---------------------------------------------------------------------------

export interface StyledDynamicGridProps extends DynamicGridProps {
  /** Show the info "i" button on each cell. Default true. */
  showInfoButtons?: boolean;
}

export const DynamicGrid: React.FC<StyledDynamicGridProps> = ({
  showInfoButtons = true,
  ...rest
}) => (
  <HeadlessDynamicGrid
    {...rest}
    renderCell={(cell, baseWrapper) => {
      if (!React.isValidElement(baseWrapper)) return baseWrapper;
      const base = baseWrapper as React.ReactElement<any>;
      const existing = base.props.children;
      const children = (
        <>
          {existing}
          {rest.showLocks !== false && (
            <LockToggle instanceId={cell.instanceId} title="Lock this component" />
          )}
          {showInfoButtons && (
            <InfoTrigger componentId={cell.componentId} title="Explain this component" />
          )}
        </>
      );
      return React.cloneElement(base, {
        children,
      } as any);
    }}
  />
);

// ---------------------------------------------------------------------------
// LockToggle (pre-iconed)
// ---------------------------------------------------------------------------

export const LockToggle: React.FC<Omit<LockToggleProps, "render" | "children">> = (
  props,
) => (
  <HeadlessLockToggle
    {...props}
    render={({ locked }) => (
      <span aria-hidden="true">{locked ? "🔒" : "🔓"}</span>
    )}
  />
);

// ---------------------------------------------------------------------------
// InfoTrigger (pre-iconed "i")
// ---------------------------------------------------------------------------

export const InfoTrigger: React.FC<InfoTriggerProps> = ({ children, ...rest }) => (
  <HeadlessInfoTrigger {...rest}>
    {children ?? (
      <span
        aria-hidden="true"
        style={{ fontStyle: "italic", fontWeight: 700, fontSize: 12 }}
      >
        i
      </span>
    )}
  </HeadlessInfoTrigger>
);

// ---------------------------------------------------------------------------
// CustomTabBar (pre-styled with save button)
// ---------------------------------------------------------------------------

export interface StyledCustomTabBarProps {
  saveLabel?: string;
  emptyLabel?: string;
  onTabClick?: (tabId: string) => void;
  className?: string;
}

export const CustomTabBar: React.FC<StyledCustomTabBarProps> = ({
  saveLabel = "Save tab",
  emptyLabel,
  onTabClick,
  className,
}) => (
  <HeadlessCustomTabBar.Root className={className}>
    <HeadlessCustomTabBar.List>
      {(tab) => (
        <HeadlessCustomTabBar.Item
          tab={tab}
          onSelect={onTabClick ? (t) => onTabClick(t.id) : undefined}
        >
          {tab.title}
        </HeadlessCustomTabBar.Item>
      )}
    </HeadlessCustomTabBar.List>
    <HeadlessCustomTabBar.Save>{saveLabel}</HeadlessCustomTabBar.Save>
    {emptyLabel && (
      <span data-freebird-tabs-empty="" style={{ color: "var(--freebird-muted)", fontSize: 12 }}>
        {emptyLabel}
      </span>
    )}
  </HeadlessCustomTabBar.Root>
);

// Re-export for convenience
export { freebirdColors, freebirdPlugin } from "./plugin.js";
