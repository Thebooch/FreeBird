import { Tabs } from "@freebirdai/dash-components";
import { ROLE_PERMISSIONS, type Principal } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api } from "../../api.js";
import type { Route } from "../../route.js";
import { ContactsTab } from "./ContactsTab.jsx";
import { FieldsTab } from "./FieldsTab.jsx";

/**
 * The Contacts section on the Agent side: the people who book, one per
 * email or phone, and how their fields are filled.
 *
 * Its tabs are addresses (`#/agent/contacts/<tab>`), like the calendar's.
 * The CRM grows this section rather than replacing it.
 */

export const CONTACTS_TABS = [
  { id: "people", label: "Contacts" },
  { id: "fields", label: "Contact fields" },
] as const;
type ContactsTabId = (typeof CONTACTS_TABS)[number]["id"];

const LEDES: Readonly<Record<ContactsTabId, string>> = {
  people: "Everyone who has booked or been added, each found by their email or phone.",
  fields: "The facts contacts hold, where each comes from, and how contacts are matched to your records.",
};

export const ContactsSection = ({ tab, onNavigate }: { readonly tab: string | null; readonly onNavigate: (route: Route) => void }): JSX.Element => {
  const active: ContactsTabId = CONTACTS_TABS.some((one) => one.id === tab) ? (tab as ContactsTabId) : "people";
  const [me, setMe] = useState<Principal | null>(null);
  useEffect(() => {
    void api.me().then((who) => setMe(who.principal), () => undefined);
  }, []);
  const canManage = me ? ROLE_PERMISSIONS[me.role].includes("contacts.manage") : false;
  const go = (id: ContactsTabId) => onNavigate({ kind: "agent", section: "contacts", ...(id === "people" ? {} : { id }) });

  return (
    <div className="dash-cal-page" data-testid="contacts-section">
      <header className="dash-cal-page__head">
        <div>
          <h1 className="dash-cal-page__title">Contacts</h1>
          <p className="dash-cal-page__lede">{LEDES[active]}</p>
        </div>
      </header>
      <div className="dash-cal-page__tabs">
        <Tabs label="Contacts" tabs={CONTACTS_TABS} activeId={active} onSelect={(id) => go(id as ContactsTabId)} />
      </div>
      {active === "people" && <ContactsTab canManage={canManage} onSetUpFields={() => go("fields")} />}
      {active === "fields" && <FieldsTab canManage={canManage} />}
    </div>
  );
};
