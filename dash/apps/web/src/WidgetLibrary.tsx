import {
  Button,
  Checkbox,
  Field,
  Message,
  StatusPill,
  Toolbar,
} from "@freebirdai/dash-components";
import { COMPONENT_CONTRACTS, COMPONENT_IDS, contractFor } from "@freebirdai/dash-spec";
import type { ComponentContract, ConnectionSpec, WidgetSpec } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { type SampleResult, api } from "./api.js";
import {
  type RoleBinding,
  buildWidget,
  fieldsForRole,
  missingRoles,
  unfillableRoles,
  widgetId,
} from "./binder.js";

/**
 * Pick a component, then say what fills it.
 *
 * The other half of the authoring story. The assistant is source-first — you
 * choose an endpoint and it proposes something — which is the right shape when
 * you do not know what is possible. This is for when you do: you want a board,
 * or a funnel, and you already know which field is the status.
 *
 * Entirely deterministic. No model, no API key, and the same picks always
 * produce the same widget.
 */
export const WidgetLibrary = ({
  connections,
  takenIds,
  onSave,
  onClose,
}: {
  readonly connections: readonly ConnectionSpec[];
  readonly takenIds: ReadonlySet<string>;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  const [component, setComponent] = useState<string | null>(null);
  const contract = component ? contractFor(component) : undefined;

  return (
    <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
      <aside
        className="dash-sheet dash-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Add a widget"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dash-sheet__head">
          <span className="dash-sheet__title">
            {contract ? (
              <>
                <button
                  type="button"
                  className="dash-sheet__crumb"
                  onClick={() => setComponent(null)}
                >
                  Components
                </button>
                <span className="dash-sheet__crumb-sep"> › </span>
                {contract.title}
              </>
            ) : (
              "Add a widget"
            )}
          </span>
          <button className="dash-control" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="dash-sheet__body">
          {contract ? (
            <BindStep
              contract={contract}
              connections={connections}
              takenIds={takenIds}
              onSave={onSave}
              onClose={onClose}
            />
          ) : (
            <ComponentGrid onPick={setComponent} />
          )}
        </div>
      </aside>
    </div>
  );
};

/**
 * The catalogue.
 *
 * Read from the shipped contracts rather than a hand-kept list, so a component
 * added to the product appears here without anybody remembering to add it —
 * the failure mode that leaves a working component undiscoverable.
 */
const ComponentGrid = ({ onPick }: { readonly onPick: (id: string) => void }): JSX.Element => (
  <>
    <p className="dash-hint">
      Every component here binds to data you have already connected. Pick one and you will be asked
      which field fills each part of it.
    </p>
    <div className="dash-cards">
      {COMPONENT_IDS.map((id) => {
        const contract = COMPONENT_CONTRACTS[id];
        const required = contract.roles.filter((role) => role.required);
        return (
          <button
            type="button"
            className="dash-card"
            key={id}
            onClick={() => onPick(id)}
            data-testid={`pick-${id}`}
          >
            <span className="dash-card__title">{contract.title}</span>
            <span className="dash-card__meta">{contract.description}</span>
            <span className="dash-card__badges">
              {/* What it will ask for, before you commit to picking it. */}
              {required.map((role) => (
                <StatusPill key={role.role} tone="neutral" label={role.role} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  </>
);

const BindStep = ({
  contract,
  connections,
  takenIds,
  onSave,
  onClose,
}: {
  readonly contract: ComponentContract;
  readonly connections: readonly ConnectionSpec[];
  readonly takenIds: ReadonlySet<string>;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  /*
   * Only the picks are state; the effective connection and op are derived from
   * the live list. Seeding state from props is the bug class this codebase has
   * hit three times — a drawer opened while the list was still loading kept an
   * empty id forever.
   */
  const [pickedConnection, setPickedConnection] = useState<string | null>(null);
  const [pickedOp, setPickedOp] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleBinding>({});
  const [title, setTitle] = useState("");
  const [sample, setSample] = useState<SampleResult | null>(null);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const connection =
    connections.find((entry) => entry.id === pickedConnection) ?? connections[0] ?? null;
  const ops = connection?.ops ?? [];
  const op = ops.find((entry) => entry.id === pickedOp) ?? ops[0] ?? null;

  useEffect(() => {
    if (!connection || !op) return;
    let cancelled = false;
    setSampling(true);
    setError(null);
    void (async () => {
      try {
        const result = await api.sample(connection.id, op.id);
        if (!cancelled) {
          setSample(result);
          // The fields changed, so bindings against the old ones are stale.
          setRoles({});
        }
      } catch (failure) {
        if (!cancelled) {
          setSample(null);
          setError(failure instanceof Error ? failure.message : "Could not read that endpoint.");
        }
      } finally {
        if (!cancelled) setSampling(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.id, op?.id]);

  const fields = sample?.fields ?? [];
  const blocked = useMemo(() => unfillableRoles(contract, fields), [contract, fields]);
  const missing = missingRoles(contract, roles);

  if (connections.length === 0) {
    return <Message>Connect an API first — there is nothing to bind this to yet.</Message>;
  }

  const save = async (): Promise<void> => {
    if (!connection || !op) return;
    setSaving(true);
    setError(null);
    const built = buildWidget({
      id: widgetId(title || contract.title, takenIds),
      title: title.trim() || contract.title,
      component: contract.id,
      connection: connection.id,
      op: op.id,
      rowsPath: sample?.rowsPath ?? "$",
      roles,
      fields,
      ...(sample?.schemaHash ? { schemaHash: sample.schemaHash } : {}),
    });

    if (!built.widget) {
      setError(built.errors.join("; ") || "That binding did not make a valid widget.");
      setSaving(false);
      return;
    }
    try {
      await onSave(built.widget);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add that widget.");
      setSaving(false);
    }
  };

  return (
    <>
      <p className="dash-hint">{contract.description}</p>

      <Field label="Data from">
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={connection?.id ?? ""}
            onChange={(event) => {
              setPickedConnection(event.target.value);
              setPickedOp(null);
            }}
            data-testid="library-connection"
          >
            {connections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title ?? entry.id}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Endpoint">
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={op?.id ?? ""}
            onChange={(event) => setPickedOp(event.target.value)}
            data-testid="library-op"
          >
            {ops.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title ?? entry.id}
              </option>
            ))}
          </select>
        )}
      </Field>

      {sampling && <p className="dash-hint">Reading a few rows so the fields are real…</p>}
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}

      {!sampling && sample && (
        <>
          {blocked.length > 0 && (
            <p className="dash-callout dash-callout--bad">
              {/* Said before the picking starts, not after. */}
              This endpoint has nothing that can fill{" "}
              {blocked.map((role) => `“${role.role}”`).join(" or ")}, which a {contract.title} needs.
              Try another endpoint.
            </p>
          )}

          {contract.roles.map((role) => {
            const options = fieldsForRole(role, fields);
            const value = roles[role.role];

            return (
              <div className="dash-bind-role" key={role.role}>
                <Field
                  label={`${role.role}${role.required ? " (required)" : ""}`}
                  hint={role.description}
                >
                  {(id) =>
                    role.multi ? (
                      <div className="dash-bind-multi" id={id} data-testid={`role-${role.role}`}>
                        {options.map((field) => {
                          const chosen = Array.isArray(value) ? value : [];
                          return (
                            <Checkbox
                              key={field.name}
                              label={field.name}
                              meta={field.format ?? field.kinds.join("/")}
                              checked={chosen.includes(field.name)}
                              onChange={(on) =>
                                setRoles((previous) => ({
                                  ...previous,
                                  [role.role]: on
                                    ? [...chosen, field.name]
                                    : chosen.filter((name) => name !== field.name),
                                }))
                              }
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <select
                        id={id}
                        className="dash-control"
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          setRoles((previous) => ({ ...previous, [role.role]: event.target.value }))
                        }
                        data-testid={`role-${role.role}`}
                      >
                        <option value="">
                          {options.length === 0 ? "nothing here fits" : "— choose a field —"}
                        </option>
                        {options.map((field) => (
                          <option key={field.name} value={field.name}>
                            {field.name}
                            {field.format ? ` · ${field.format}` : ""}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
              </div>
            );
          })}

          <Field label="Title" hint="What this widget is called on the board.">
            {(id) => (
              <input
                id={id}
                value={title}
                placeholder={contract.title}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="library-title"
              />
            )}
          </Field>

          <Toolbar
            end={
              <Button
                tone="primary"
                onClick={() => void save()}
                disabled={missing.length > 0 || blocked.length > 0}
                busy={saving}
                testId="library-add"
              >
                Add to dashboard
              </Button>
            }
          >
            {missing.length > 0 && (
              <span className="dash-hint">
                Still needs {missing.map((role) => `“${role}”`).join(" and ")}.
              </span>
            )}
          </Toolbar>
        </>
      )}
    </>
  );
};
