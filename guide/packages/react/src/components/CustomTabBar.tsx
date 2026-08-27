import React, { useState } from "react";
import type { CustomTab } from "@freebirdai/core";
import { useCustomTabs } from "../hooks/useCustomTabs.js";
import { useLayout } from "../hooks/useLayout.js";
import { slotWith, type SlotProps } from "./Slot.js";

export interface CustomTabBarRootProps
  extends React.HTMLAttributes<HTMLDivElement>,
    SlotProps {}

const Root: React.FC<CustomTabBarRootProps> = (props) =>
  slotWith("div", { ...props, "data-freebird-tabs": "" } as any);

export interface CustomTabBarListProps {
  children: (tab: CustomTab) => React.ReactNode;
  className?: string;
}

const List: React.FC<CustomTabBarListProps> = ({ children, className }) => {
  const { tabs } = useCustomTabs();
  return (
    <div data-freebird-tabs-list="" className={className}>
      {tabs.map((t) => (
        <React.Fragment key={t.id}>{children(t)}</React.Fragment>
      ))}
    </div>
  );
};

export interface CustomTabBarItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">,
    SlotProps {
  tab: CustomTab;
  /** Called when the item is clicked. Defaults to loading the tab into live layout. */
  onSelect?: (tab: CustomTab) => void;
}

const Item: React.FC<CustomTabBarItemProps> = ({ tab, onSelect, onClick, children, ...rest }) => {
  const { load } = useCustomTabs();
  return slotWith("button", {
    type: "button",
    ...rest,
    "data-freebird-tab": "",
    "data-id": tab.id,
    "data-slug": tab.slug,
    "data-has-digest": tab.digest ? "" : undefined,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      if (onSelect) onSelect(tab);
      else void load(tab.id);
    },
    children: children ?? tab.title,
  } as any);
};

export interface CustomTabBarSaveProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSubmit">,
    SlotProps {
  /**
   * How the title is collected. Default: window.prompt.
   * Override to integrate with your own dialog system.
   */
  promptTitle?: () => string | null | Promise<string | null>;
  /** Called after a successful save. */
  onSaved?: (tab: CustomTab) => void;
}

const Save: React.FC<CustomTabBarSaveProps> = ({
  promptTitle,
  onSaved,
  onClick,
  children,
  ...rest
}) => {
  const { save } = useCustomTabs();
  const { plan } = useLayout();
  const [saving, setSaving] = useState(false);

  const handle = async () => {
    if (!plan || saving) return;
    setSaving(true);
    try {
      const title = promptTitle
        ? await promptTitle()
        : typeof window !== "undefined"
          ? window.prompt("Name this tab:")
          : "Custom tab";
      if (!title) return;
      const tab = await save({ title, layout: plan });
      onSaved?.(tab);
    } finally {
      setSaving(false);
    }
  };

  return slotWith("button", {
    type: "button",
    disabled: !plan || saving || rest.disabled,
    ...rest,
    "data-freebird-tabs-save": "",
    "data-saving": saving ? "" : undefined,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) void handle();
    },
    children: children ?? "Save tab",
  } as any);
};

export const CustomTabBar = { Root, List, Item, Save };
