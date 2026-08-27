import { Button, Checkbox, Field, Message, StatusPill, Toolbar } from "@freebirdai/dash-components";
import {
  DENSITIES,
  EMPTY_PRESENTATION,
  WIDGET_CHROME_ID,
  defaultPresentationFor,
  presentationSchema,
} from "@freebirdai/dash-spec";
import type {
  DashboardSpec,
  Density,
  Presentation,
  PresentationManifest,
  SettingDef,
  SettingValue,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { type PresentationResult, api } from "./api.js";

/**
 * Change how something looks, and choose how far the change reaches.
 *
 * The scope switch is the whole point. Restyling one widget, restyling every
 * table on this board, and restyling every table in the product are three
 * different intentions, and a customisation UI that guesses which one you
 * meant is one you stop trusting. Each lands in a different place: the widget
 * spec, the dashboard spec, or a stored part.
 */
export type Scope = "widget" | "board" | "everywhere";

export const PresentationEditor = ({
  widget,
  dashboard,
  onSaveDashboard,
  onChanged,
  onClose,
}: {
  readonly widget: WidgetSpec;
  readonly dashboard: DashboardSpec;
  readonly onSaveDashboard: (next: DashboardSpec) => Promise<void>;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}): JSX.Element => {
  const [loaded, setLoaded] = useState<PresentationResult | null>(null);
  const [scope, setScope] = useState<Scope>("widget");
  /** Only what this editing session changed, keyed by component id. */
  const [edits, setEdits] = useState<Record<string, Presentation>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.presentation();
        if (!cancelled) setLoaded(result);
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "Could not read the current look.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The frame and the component are edited together but stored apart, because
   * "every table everywhere" and "every widget frame everywhere" are different
   * parts. Within one widget they share a namespace, which is what lets a
   * single per-widget override carry both.
   */
  const targets = useMemo(
    () => [WIDGET_CHROME_ID, widget.component],
    [widget.component],
  );

  const startingFor = (id: string): Presentation => {
    if (!loaded) return defaultPresentationFor(id);
    if (scope === "everywhere") return loaded.presentation[id] ?? defaultPresentationFor(id);
    if (scope === "board") return dashboard.presentation[id] ?? EMPTY_PRESENTATION;
    return widget.presentation ?? EMPTY_PRESENTATION;
  };

  const currentFor = (id: string): Presentation => edits[id] ?? startingFor(id);

  const update = (id: string, change: (previous: Presentation) => Presentation): void => {
    setEdits((previous) => ({ ...previous, [id]: change(previous[id] ?? startingFor(id)) }));
  };

  if (error) return <Panel onClose={onClose}><Message>{error}</Message></Panel>;
  if (!loaded) return <Panel onClose={onClose}><Message>Reading the current look…</Message></Panel>;

  const manifests = targets
    .map((id) => loaded.manifests[id])
    .filter((manifest): manifest is PresentationManifest => manifest !== undefined);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (scope === "everywhere") {
        for (const [id, presentation] of Object.entries(edits)) {
          // Whole-part semantics: send the merged object, not the delta.
          await api.putPresentation(id, presentationSchema.parse(presentation));
        }
      } else if (scope === "board") {
        await onSaveDashboard({
          ...dashboard,
          presentation: { ...dashboard.presentation, ...edits },
        });
      } else {
        /*
         * One object for the widget, because chrome slots and component slots
         * do not collide — the widget-level override is deliberately flat.
         */
        const merged = targets.reduce<Presentation>(
          (into, id) => {
            const part = edits[id];
            if (!part) return into;
            return {
              ...into,
              ...(part.density !== undefined ? { density: part.density } : {}),
              slots: { ...into.slots, ...part.slots },
              tokens: { ...into.tokens, ...part.tokens },
              settings: { ...into.settings, ...part.settings },
            };
          },
          widget.presentation ?? EMPTY_PRESENTATION,
        );
        await onSaveDashboard({
          ...dashboard,
          widgets: dashboard.widgets.map((entry) =>
            entry.id === widget.id ? { ...entry, presentation: merged } : entry,
          ),
        });
      }
      onChanged();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save that.");
      setBusy(false);
    }
  };

  const revert = async (): Promise<void> => {
    setBusy(true);
    try {
      for (const id of targets) await api.revertPresentation(id);
      onChanged();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not revert that.");
      setBusy(false);
    }
  };

  return (
    <Panel onClose={onClose} title={`Customise “${widget.title}”`}>
      <Field label="Apply this to" hint="Where the change is stored, and how far it reaches.">
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as Scope);
              // The starting point differs per scope, so edits made against
              // one would be a lie against another.
              setEdits({});
            }}
            data-testid="scope"
          >
            <option value="widget">Just this widget</option>
            <option value="board">Every {widget.component} on this board</option>
            <option value="everywhere">Every {widget.component} everywhere</option>
          </select>
        )}
      </Field>

      {manifests.length === 0 && (
        <Message>This component offers nothing to change yet.</Message>
      )}

      {manifests.map((manifest) => {
        const value = currentFor(manifest.component);
        return (
          <section className="dash-customise" key={manifest.component}>
            <h4 className="dash-customise__title">{manifest.title}</h4>

            {manifest.supportsDensity && (
              <Field label="Density">
                {(id) => (
                  <select
                    id={id}
                    className="dash-control"
                    value={value.density ?? ""}
                    onChange={(event) =>
                      update(manifest.component, (previous) => ({
                        ...previous,
                        density: (event.target.value || undefined) as Density | undefined,
                      }))
                    }
                    data-testid={`density-${manifest.component}`}
                  >
                    <option value="">— inherit —</option>
                    {DENSITIES.map((density) => (
                      <option key={density} value={density}>
                        {density}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {manifest.slots.length > 0 && (
              <div className="dash-customise__group">
                <span className="dash-customise__label">Show</span>
                {manifest.slots.map((slot) => (
                  <Checkbox
                    key={slot.id}
                    label={slot.label}
                    meta={slot.description}
                    checked={value.slots[slot.id]?.hidden !== true}
                    onChange={(on) =>
                      update(manifest.component, (previous) => ({
                        ...previous,
                        slots: {
                          ...previous.slots,
                          [slot.id]: {
                            ...(previous.slots[slot.id] ?? { settings: {} }),
                            hidden: !on,
                          },
                        },
                      }))
                    }
                    testId={`slot-${manifest.component}-${slot.id}`}
                  />
                ))}
              </div>
            )}

            {manifest.settings.map((setting) => (
              <SettingControl
                key={setting.id}
                component={manifest.component}
                setting={setting}
                value={value.settings[setting.id]}
                onChange={(next) =>
                  update(manifest.component, (previous) => ({
                    ...previous,
                    settings: { ...previous.settings, [setting.id]: next },
                  }))
                }
              />
            ))}
          </section>
        );
      })}

      <Toolbar
        end={
          <>
            {scope === "everywhere" && (
              <Button onClick={() => void revert()} busy={busy} testId="revert">
                Back to the default
              </Button>
            )}
            <Button
              tone="primary"
              onClick={() => void save()}
              busy={busy}
              disabled={Object.keys(edits).length === 0}
              testId="save-presentation"
            >
              Save
            </Button>
          </>
        }
      >
        {Object.keys(edits).length === 0 && <span className="dash-hint">Nothing changed yet.</span>}
      </Toolbar>
    </Panel>
  );
};

const SettingControl = ({
  component,
  setting,
  value,
  onChange,
}: {
  readonly component: string;
  readonly setting: SettingDef;
  readonly value: SettingValue | undefined;
  readonly onChange: (value: SettingValue) => void;
}): JSX.Element => {
  const testId = `setting-${component}-${setting.id}`;

  if (setting.type === "boolean") {
    return (
      <Checkbox
        label={setting.label}
        meta={setting.description}
        checked={value === true}
        onChange={onChange}
        testId={testId}
      />
    );
  }

  if (setting.type === "enum") {
    return (
      <Field label={setting.label} hint={setting.description}>
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
            data-testid={testId}
          >
            {(setting.values ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }

  return (
    <Field label={setting.label} hint={setting.description}>
      {(id) => (
        <input
          id={id}
          type="number"
          min={setting.min}
          max={setting.max}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const next = Number(event.target.value);
            // An empty box is not zero. Leaving it alone beats writing a value
            // the reader did not choose.
            if (event.target.value !== "" && Number.isFinite(next)) onChange(next);
          }}
          data-testid={testId}
        />
      )}
    </Field>
  );
};

const Panel = ({
  children,
  onClose,
  title = "Customise",
}: {
  readonly children: React.ReactNode;
  readonly onClose: () => void;
  readonly title?: string;
}): JSX.Element => (
  <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
    <aside
      className="dash-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="dash-sheet__head">
        <span className="dash-sheet__title">{title}</span>
        <button className="dash-control" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="dash-sheet__body">{children}</div>
    </aside>
  </div>
);

/** Shown beside a component that has a stored override, so it is visible. */
export const CustomisedBadge = (): JSX.Element => (
  <StatusPill tone="neutral" label="customised" />
);
