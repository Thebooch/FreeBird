import { EmptyState } from "@freebirdai/dash-components";

/**
 * Comms: calls, texts and email, in a section of their own.
 *
 * There will be a lot here to watch, so it is not one of the Agent side's
 * sections. Until those arrive it says what will live here; the email,
 * phone and text steps each drop their view into this slot.
 */
export const CommsShell = (): JSX.Element => (
  <div className="dash-page dash-agent" data-testid="comms-section">
    <div className="dash-agent__inner">
      <EmptyState
        glyph="✉"
        title="Comms: coming soon"
        body="Email, texts and calls your agents have read, drafted and sent on your behalf."
      />
    </div>
  </div>
);
