import React from "react";
import type { CustomTab } from "@freebirdai/core";
import { useCustomTabs } from "../hooks/useCustomTabs.js";

export interface NavLinkRenderProps {
  /** Tab identity. */
  tab: CustomTab;
  /** URL built from `baseHref`/`slug`, e.g. `/tabs/q3-review`. */
  href: string;
}

export interface FreeBirdNavLinksProps {
  /** Base path under which tabs live. Default `/tabs`. */
  baseHref?: string;
  /**
   * Render prop. Return an element for each tab — a link, a router
   * `<Link>`, whatever you use. The data is just a list of saved tabs.
   */
  children: (props: NavLinkRenderProps) => React.ReactNode;
  /** Optional filter (e.g. only digest-enabled tabs). */
  filter?: (tab: CustomTab) => boolean;
}

/**
 * Helper that iterates saved custom tabs into whatever navigation system
 * the host app is using. Not a <nav> itself — that stays in your hands.
 *
 * Example with Next.js:
 *
 *   <FreeBirdNavLinks baseHref="/dashboard">
 *     {({ tab, href }) => <Link key={tab.id} href={href}>{tab.title}</Link>}
 *   </FreeBirdNavLinks>
 */
export const FreeBirdNavLinks: React.FC<FreeBirdNavLinksProps> = ({
  baseHref = "/tabs",
  filter,
  children,
}) => {
  const { tabs } = useCustomTabs();
  const filtered = filter ? tabs.filter(filter) : tabs;
  return (
    <>
      {filtered.map((tab) => {
        const href = `${baseHref.replace(/\/+$/, "")}/${tab.slug ?? tab.id}`;
        return (
          <React.Fragment key={tab.id}>
            {children({ tab, href })}
          </React.Fragment>
        );
      })}
    </>
  );
};
