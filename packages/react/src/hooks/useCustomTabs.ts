import { useCallback, useEffect } from "react";
import type { CustomTab, DigestConfig, LayoutPlan } from "@freebirdai/core";
import { useFreeBird } from "../provider.js";

export interface UseCustomTabsReturn {
  tabs: CustomTab[];
  refresh: () => Promise<void>;
  save: (input: { title: string; layout?: LayoutPlan; digest?: DigestConfig }) => Promise<CustomTab>;
  update: (id: string, input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>) => Promise<CustomTab>;
  remove: (id: string) => Promise<void>;
  /** Replace the live layout with a saved tab's layout. */
  load: (id: string) => Promise<void>;
}

export const useCustomTabs = (): UseCustomTabsReturn => {
  const fb = useFreeBird();

  useEffect(() => {
    // best-effort initial load
    fb.refreshTabs().catch(() => {});
  }, []); // mount-only by design

  const save = useCallback(
    async ({
      title,
      layout,
      digest,
    }: {
      title: string;
      layout?: LayoutPlan;
      digest?: DigestConfig;
    }) => {
      const target = layout ?? fb.layout;
      if (!target) throw new Error("useCustomTabs.save: no layout to save.");
      const tab = await fb.transport.saveTab({ title, layout: target, digest });
      fb.setTabs([...fb.tabs, tab]);
      return tab;
    },
    [fb],
  );

  const update = useCallback(
    async (id: string, input: Partial<Pick<CustomTab, "title" | "layout" | "digest">>) => {
      const tab = await fb.transport.updateTab(id, input);
      fb.setTabs(fb.tabs.map((t) => (t.id === id ? tab : t)));
      return tab;
    },
    [fb],
  );

  const remove = useCallback(
    async (id: string) => {
      await fb.transport.deleteTab(id);
      fb.setTabs(fb.tabs.filter((t) => t.id !== id));
    },
    [fb],
  );

  const load = useCallback(
    async (id: string) => {
      const tab = await fb.transport.getTab(id);
      if (tab) fb.setLayout(tab.layout);
    },
    [fb],
  );

  return {
    tabs: fb.tabs,
    refresh: fb.refreshTabs,
    save,
    update,
    remove,
    load,
  };
};
