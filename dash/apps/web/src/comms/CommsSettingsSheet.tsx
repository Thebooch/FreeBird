import type { CommsSettings } from "@freebirdai/dash-spec";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { FormRow, SheetSection, TextInput } from "../agent/calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../agent/calendar/scheduling/SetupSheet.jsx";

/**
 * Communications' own settings: where team notices go when a member has no
 * email of their own, and which senders are never made into contacts.
 */
export const CommsSettingsSheet = ({ onClose }: { readonly onClose: () => void }): JSX.Element => {
  const [held, setHeld] = useState<CommsSettings | null>(null);
  const [noticesTo, setNoticesTo] = useState("");
  const [ignore, setIgnore] = useState("");
  useEffect(() => {
    void api.commsSettings().then((settings) => {
      setHeld(settings);
      setNoticesTo(settings.noticesTo ?? "");
      setIgnore(settings.contactIgnore.join("\n"));
    });
  }, []);
  return (
    <SetupSheet
      trail="Communications"
      title="Comms settings"
      testId="comms-settings"
      onClose={onClose}
      onSave={async () => {
        await api.putCommsSettings({
          ...(held ?? { contactIgnore: [] }),
          noticesTo: noticesTo.trim(),
          contactIgnore: ignore.split(/\r?\n|,/).map((one) => one.trim()).filter(Boolean),
        });
        onClose();
      }}
    >
      <SheetSection title="Team notices" description="Approval requests, booking changes and agents' highlights go to each teammate's own email. Anyone without one, and everything when nobody signs in, goes here. Sent with the server's own email (DASH_EMAIL), like reports.">
        <FormRow label="Send to">{(id) => <TextInput id={id} type="email" value={noticesTo} onChange={setNoticesTo} placeholder="office@example.com" testId="comms-notices-to" />}</FormRow>
      </SheetSection>
      <SheetSection title="Never made contacts" description="One per line: an address, name@* for any domain, or *@domain.">
        <textarea className="dash-sched-input" rows={8} value={ignore} onChange={(event) => setIgnore(event.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
      </SheetSection>
    </SetupSheet>
  );
};
