import { defineComponent, h, type PropType, type VNodeChild } from "vue";
import type { ChatMessage, CustomTab, GridCell } from "@freebirdai/core";
import {
  ChatPanelRoot,
  ChatPanelMessages,
  ChatPanelForm,
  ChatPanelInput,
  ChatPanelSubmit,
  ChatPanelMessage,
  DynamicGrid as HeadlessDynamicGrid,
  LockToggle as HeadlessLockToggle,
  InfoTrigger as HeadlessInfoTrigger,
  CustomTabBarRoot,
  CustomTabBarList,
  CustomTabBarItem,
  CustomTabBarSave,
} from "@freebirdai/vue";

/**
 * Pre-styled FreeBird Vue components built on `@freebirdai/vue` primitives.
 * All styling is governed by the CSS variables declared in
 * `./styles.css` (which you import once at your app root).
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
export const ChatPanel = defineComponent({
  name: "FreeBirdTailwindChatPanel",
  props: {
    sendLabel: { type: String, default: "Send" },
    placeholder: { type: String, default: "Ask anything…" },
    renderMessage: {
      type: Function as PropType<(m: ChatMessage) => VNodeChild>,
      default: undefined,
    },
  },
  setup(props) {
    return () =>
      h(ChatPanelRoot, null, {
        default: () => [
          h(ChatPanelMessages, null, {
            default: (slotProps: {
              messages: ChatMessage[];
              streamingText: string;
              streaming: boolean;
            }) => [
              ...slotProps.messages.map((m) =>
                props.renderMessage
                  ? props.renderMessage(m)
                  : h(ChatPanelMessage, { key: m.id, message: m }),
              ),
              slotProps.streaming && slotProps.streamingText
                ? h(
                    "div",
                    {
                      "data-freebird-chat-message": "",
                      "data-role": "assistant",
                    },
                    [
                      slotProps.streamingText,
                      h(
                        "span",
                        {
                          "aria-hidden": "true",
                          style: { opacity: 0.5 },
                        },
                        " \u258D",
                      ),
                    ],
                  )
                : null,
            ],
          }),
          h(ChatPanelForm, null, {
            default: () => [
              h(ChatPanelInput, { placeholder: props.placeholder }),
              h(ChatPanelSubmit, null, { default: () => props.sendLabel }),
            ],
          }),
        ],
      });
  },
});

// ---------------------------------------------------------------------------
// DynamicGrid (auto-adds LockToggle + InfoTrigger overlays via the `cell`
// scoped slot — identical result to the React Tailwind preset)
// ---------------------------------------------------------------------------
export const DynamicGrid = defineComponent({
  name: "FreeBirdTailwindDynamicGrid",
  props: {
    showInfoButtons: { type: Boolean, default: true },
    showLocks: { type: Boolean, default: true },
    gridCols: { type: Number, default: undefined },
    rowHeightPx: { type: Number, default: 72 },
    gapPx: { type: Number, default: 12 },
  },
  setup(props) {
    return () =>
      h(HeadlessDynamicGrid, {
        showLocks: props.showLocks,
        gridCols: props.gridCols,
        rowHeightPx: props.rowHeightPx,
        gapPx: props.gapPx,
        // Rebuild the cell wrapper so LockToggle + InfoTrigger render
        // inside the cell (so their absolute-positioned CSS anchors to
        // the cell, matching the React Tailwind preset 1:1).
        renderCell: (cell: GridCell, _wrapped: VNodeChild, inner: VNodeChild) =>
          h(
            "div",
            {
              key: cell.instanceId,
              "data-freebird-cell": "",
              "data-component": cell.componentId,
              "data-locked": cell.locked ? "" : undefined,
              "data-importance": cell.importance,
              "data-orientation": cell.orientation,
              style: {
                gridColumn: `${cell.x + 1} / span ${cell.w}`,
                gridRow: `${cell.y + 1} / span ${cell.h}`,
              },
            },
            [
              inner,
              props.showLocks
                ? h(LockToggle, {
                    instanceId: cell.instanceId,
                    title: "Lock this component",
                  })
                : null,
              props.showInfoButtons
                ? h(InfoTrigger, {
                    componentId: cell.componentId,
                    title: "Explain this component",
                  })
                : null,
            ],
          ),
      });
  },
});

// ---------------------------------------------------------------------------
// LockToggle (pre-iconed 🔒 / 🔓)
// ---------------------------------------------------------------------------
export const LockToggle = defineComponent({
  name: "FreeBirdTailwindLockToggle",
  props: {
    instanceId: { type: String, required: true },
    title: { type: String, default: undefined },
  },
  setup(props, { attrs }) {
    return () =>
      h(
        HeadlessLockToggle,
        { instanceId: props.instanceId, ...attrs, title: props.title },
        {
          default: ({ locked }: { locked: boolean }) =>
            h("span", { "aria-hidden": "true" }, locked ? "\uD83D\uDD12" : "\uD83D\uDD13"),
        },
      );
  },
});

// ---------------------------------------------------------------------------
// InfoTrigger (pre-iconed "i")
// ---------------------------------------------------------------------------
export const InfoTrigger = defineComponent({
  name: "FreeBirdTailwindInfoTrigger",
  props: {
    componentId: { type: String, required: true },
    title: { type: String, default: undefined },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        HeadlessInfoTrigger,
        { componentId: props.componentId, ...attrs, title: props.title },
        {
          default: () =>
            slots.default
              ? slots.default()
              : h(
                  "span",
                  {
                    "aria-hidden": "true",
                    style: {
                      fontStyle: "italic",
                      fontWeight: 700,
                      fontSize: "12px",
                    },
                  },
                  "i",
                ),
        },
      );
  },
});

// ---------------------------------------------------------------------------
// CustomTabBar (pre-styled with save button)
// ---------------------------------------------------------------------------
export const CustomTabBar = defineComponent({
  name: "FreeBirdTailwindCustomTabBar",
  props: {
    saveLabel: { type: String, default: "Save tab" },
    emptyLabel: { type: String, default: undefined },
    onTabClick: {
      type: Function as PropType<(tabId: string) => void>,
      default: undefined,
    },
  },
  setup(props) {
    return () =>
      h(CustomTabBarRoot, null, {
        default: () => [
          h(CustomTabBarList, null, {
            default: ({ tab }: { tab: CustomTab }) =>
              h(
                CustomTabBarItem,
                {
                  tab,
                  onSelect: props.onTabClick
                    ? (t: CustomTab) => props.onTabClick!(t.id)
                    : undefined,
                },
                { default: () => tab.title },
              ),
          }),
          h(CustomTabBarSave, null, { default: () => props.saveLabel }),
          props.emptyLabel
            ? h(
                "span",
                {
                  "data-freebird-tabs-empty": "",
                  style: { color: "var(--freebird-muted)", fontSize: "12px" },
                },
                props.emptyLabel,
              )
            : null,
        ],
      });
  },
});

// Re-export theme helpers for convenience
export { freebirdColors, freebirdPlugin } from "./plugin.js";
