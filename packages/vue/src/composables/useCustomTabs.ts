import { onMounted, type ComputedRef } from "vue";
import type { CustomTab, DigestConfig, LayoutPlan } from "@freebirdai/core";
import { useFreeBird } from "./useFreeBird.js";

export interface UseCustomTabsReturn {
  tabs: ComputedRef<CustomTab[]>;
  refresh: () => Promise<void>;
  save: (input: { title: string; layout?: LayoutPlan; digest?: DigestConfig }) => Promise<CustomTab>;
  update: (
    id: string,
    input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>,
  ) => Promise<CustomTab>;
  remove: (id: string) => Promise<void>;
  /** Replace the live layout with a saved tab's layout. */
  load: (id: string) => Promise<void>;
}

export const useCustomTabs = (): UseCustomTabsReturn => {
  const fb = useFreeBird();

  onMounted(() => {
    fb.refreshTabs().catch(() => {});
  });

  const save = async ({
    title,
    layout,
    digest,
  }: {
    title: string;
    layout?: LayoutPlan;
    digest?: DigestConfig;
  }): Promise<CustomTab> => {
    const target = layout ?? fb.layout.value;
    if (!target) throw new Error("useCustomTabs.save: no layout to save.");
    const tab = await fb.transport.saveTab({ title, layout: target, digest });
    fb.setTabs([...fb.tabs.value, tab]);
    return tab;
  };

  const update = async (
    id: string,
    input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>,
  ): Promise<CustomTab> => {
    const tab = await fb.transport.updateTab(id, input);
    fb.setTabs(fb.tabs.value.map((t) => (t.id === id ? tab : t)));
    return tab;
  };

  const remove = async (id: string): Promise<void> => {
    await fb.transport.deleteTab(id);
    fb.setTabs(fb.tabs.value.filter((t) => t.id !== id));
  };

  const load = async (id: string): Promise<void> => {
    const tab = await fb.transport.getTab(id);
    if (tab) fb.setLayout(tab.layout);
  };

  return {
    tabs: fb.tabs,
    refresh: fb.refreshTabs,
    save,
    update,
    remove,
    load,
  };
};
