import { LAYER_KEYS, resolveSettings, type PartialSettings, type SchedulingSettings } from "@freebirdai/dash-spec";
import { Button, ErrorState } from "@freebirdai/dash-components";
import { useEffect, useState } from "react";
import { api } from "../../../api.js";
import { SettingsEditor } from "./editors.jsx";
import { SheetSection } from "./inputs.jsx";
import { useSetup } from "./useSetup.js";

/**
 * The workspace's own scheduling defaults: what applies everywhere unless a
 * person's profile, an appointment type or a block says otherwise. The
 * buffer between appointments lives here, or on a block.
 */

const GROUPS: ReadonlyArray<{ readonly title: string; readonly description: string; readonly keys: readonly (keyof SchedulingSettings)[] }> = [
  { title: "Time between appointments", description: "One buffer for everyone. A block can set its own for its hours.", keys: ["buffer"] },
  { title: "Booking", description: "How long appointments take, when they start, and how far ahead.", keys: ["length", "slotStep", "capacity", "stackOnlySame", "minNotice", "horizon", "maxPerDay"] },
  { title: "Approval", description: "Whether a team member approves a booking before it is confirmed.", keys: ["approval", "approvalWhen"] },
  { title: "Grouping", description: "Offer times that put appointments sharing a field together.", keys: ["consolidate"] },
  { title: "Holds and changes", description: "How long requests and suggested times hold, and how late a booking can be changed online.", keys: ["holdFor", "suggestionHoldFor", "cancelCutoff", "rescheduleCutoff", "maxReschedules", "showHostName"] },
];

export const SettingsTab = (): JSX.Element => {
  const { setup, error, canManage, reload } = useSetup();
  const [draft, setDraft] = useState<PartialSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (setup && draft === null) setDraft(setup.defaults);
  }, [setup, draft]);

  if (error && !setup) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!setup || !draft) return <p className="dash-hint">Loading…</p>;
  const inherited = resolveSettings([]);
  const changed = JSON.stringify(draft) !== JSON.stringify(setup.defaults);

  return (
    <div className="dash-sched-tab dash-sched-tab--narrow" data-testid="scheduling-settings">
      <header className="dash-sched-tab__head">
        <p className="dash-sched-panel__lede">What applies to every booking unless a person, an appointment type or a block says otherwise.</p>
        {canManage && (
          <div className="dash-sched-inline">
            {failed && <span className="dash-sched-error">{failed}</span>}
            {saved && !changed && <span className="dash-hint">{saved}</span>}
            <Button tone="ghost" disabled={!changed || saving} onClick={() => setDraft(setup.defaults)}>
              Discard
            </Button>
            <Button
              tone="primary"
              busy={saving}
              disabled={!changed}
              testId="settings-save"
              onClick={async () => {
                setSaving(true);
                setFailed(null);
                try {
                  setDraft(await api.schedulingDefaults(draft));
                  await reload();
                  setSaved("Saved.");
                } catch (cause) {
                  setFailed(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save settings
            </Button>
          </div>
        )}
      </header>
      <div className="dash-sched-settings-page">
        {GROUPS.map((group) => (
          <SheetSection key={group.title} title={group.title} description={group.description}>
            <SettingsEditor keys={group.keys.filter((key) => LAYER_KEYS.workspace.includes(key))} value={draft} inherited={inherited} onChange={setDraft} />
          </SheetSection>
        ))}
      </div>
    </div>
  );
};
