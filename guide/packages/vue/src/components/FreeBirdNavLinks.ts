import { defineComponent, computed, type PropType } from "vue";
import type { CustomTab } from "@freebirdai/core";
import { useCustomTabs } from "../composables/useCustomTabs.js";

/**
 * Helper that iterates saved custom tabs into a router's nav. Uses a
 * scoped slot so the host app supplies the real `<router-link>`:
 *
 *   <FreeBirdNavLinks base-href="/dashboard" #default="{ tab, href }">
 *     <RouterLink :key="tab.id" :to="href">{{ tab.title }}</RouterLink>
 *   </FreeBirdNavLinks>
 */
export const FreeBirdNavLinks = defineComponent({
  name: "FreeBirdNavLinks",
  props: {
    baseHref: { type: String, default: "/tabs" },
    filter: {
      type: Function as PropType<(tab: CustomTab) => boolean>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const { tabs } = useCustomTabs();
    const filtered = computed<CustomTab[]>(() =>
      props.filter ? tabs.value.filter(props.filter) : tabs.value,
    );
    return () =>
      filtered.value.map((tab) => {
        const href = `${props.baseHref.replace(/\/+$/, "")}/${tab.slug ?? tab.id}`;
        return slots.default ? slots.default({ tab, href }) : null;
      });
  },
});
