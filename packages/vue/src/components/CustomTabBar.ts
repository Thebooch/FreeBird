import { defineComponent, h, ref, type PropType } from "vue";
import type { CustomTab } from "@freebirdai/core";
import { useCustomTabs } from "../composables/useCustomTabs.js";
import { useLayout } from "../composables/useLayout.js";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export const CustomTabBarRoot = defineComponent({
  name: "FreeBirdCustomTabBarRoot",
  setup(_, { slots }) {
    return () =>
      h(
        "div",
        { "data-freebird-tabs": "" },
        slots.default ? slots.default() : undefined,
      );
  },
});

// ---------------------------------------------------------------------------
// List (scoped slot: each tab)
// ---------------------------------------------------------------------------
export const CustomTabBarList = defineComponent({
  name: "FreeBirdCustomTabBarList",
  setup(_, { slots }) {
    const { tabs } = useCustomTabs();
    return () =>
      h(
        "div",
        { "data-freebird-tabs-list": "" },
        tabs.value.map((t) => (slots.default ? slots.default({ tab: t }) : null)),
      );
  },
});

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------
export const CustomTabBarItem = defineComponent({
  name: "FreeBirdCustomTabBarItem",
  props: {
    tab: { type: Object as PropType<CustomTab>, required: true },
    onSelect: {
      type: Function as PropType<(tab: CustomTab) => void>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const { load } = useCustomTabs();
    return () =>
      h(
        "button",
        {
          type: "button",
          "data-freebird-tab": "",
          "data-id": props.tab.id,
          "data-slug": props.tab.slug,
          "data-has-digest": props.tab.digest ? "" : undefined,
          onClick: (e: MouseEvent) => {
            if (e.defaultPrevented) return;
            if (props.onSelect) props.onSelect(props.tab);
            else void load(props.tab.id);
          },
        },
        slots.default ? slots.default() : props.tab.title,
      );
  },
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
export const CustomTabBarSave = defineComponent({
  name: "FreeBirdCustomTabBarSave",
  props: {
    promptTitle: {
      type: Function as PropType<() => string | null | Promise<string | null>>,
      default: undefined,
    },
    onSaved: {
      type: Function as PropType<(tab: CustomTab) => void>,
      default: undefined,
    },
    disabled: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const { save } = useCustomTabs();
    const { plan } = useLayout();
    const saving = ref(false);

    const handle = async () => {
      if (!plan.value || saving.value) return;
      saving.value = true;
      try {
        const title = props.promptTitle
          ? await props.promptTitle()
          : typeof window !== "undefined"
            ? window.prompt("Name this tab:")
            : "Custom tab";
        if (!title) return;
        const tab = await save({ title, layout: plan.value });
        props.onSaved?.(tab);
      } finally {
        saving.value = false;
      }
    };

    return () =>
      h(
        "button",
        {
          type: "button",
          disabled: !plan.value || saving.value || props.disabled,
          "data-freebird-tabs-save": "",
          "data-saving": saving.value ? "" : undefined,
          onClick: (e: MouseEvent) => {
            if (!e.defaultPrevented) void handle();
          },
        },
        slots.default ? slots.default() : "Save tab",
      );
  },
});

export const CustomTabBar = {
  Root: CustomTabBarRoot,
  List: CustomTabBarList,
  Item: CustomTabBarItem,
  Save: CustomTabBarSave,
};
