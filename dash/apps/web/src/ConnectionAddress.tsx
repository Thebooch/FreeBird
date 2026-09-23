import { looksLikePlaceholder, resolveServerUrl } from "@freebirdai/dash-spec";
import { useState } from "react";
import { api, type ConnectionSummary } from "./api.js";

/**
 * Where this connection's API lives.
 *
 * Two kinds of API reach this step, and they need different questions:
 *
 * - **One hosted per account.** The documentation writes the address with a
 *   blank — `https://{account}.rentvine.com/api/manager` — and only the person
 *   connecting knows what goes in it. Each blank is asked for on its own, with
 *   the documentation's own description beside it, and the finished address
 *   shown as it is typed.
 * - **One whose documentation never said.** The import had to guess, usually
 *   the site the docs are on. The whole address is asked for, with the guess
 *   filled in to correct.
 *
 * Either can switch to typing the whole address, because an import can be
 * wrong about both and "any API from any website" includes the ones whose
 * documentation is.
 *
 * Nothing is sent to the API until this is answered: the connection refuses
 * to make a request while its address is unconfirmed.
 */
export const ConnectionAddress = ({
  connection,
  onSaved,
  onBack,
}: {
  connection: ConnectionSummary;
  onSaved: (updated: ConnectionSummary) => void;
  onBack?: (() => void) | undefined;
}): JSX.Element => {
  const server = connection.server;
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(server?.values ?? {}) }));
  const [whole, setWhole] = useState(!server);
  const [address, setAddress] = useState(connection.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = server && !whole ? resolveServerUrl(server, values) : null;
  const ready = whole ? /^https?:\/\/\S+$/i.test(address.trim()) : Boolean(filled?.url);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setAddress(
        connection.id,
        whole ? { baseUrl: address.trim() } : { values },
      );
      onSaved(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That address could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  /** The template with its blanks shown as the names somebody will fill. */
  const shownTemplate = server?.url.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_raw, name: string) => {
    const label = server.variables.find((one) => one.name === name)?.label ?? name;
    return `‹${label.toLowerCase()}›`;
  });

  return (
    <section data-testid="connection-address">
      <h4>Where is your {connection.title} account?</h4>

      {server && !whole && (
        <p className="dash-page__description">
          {connection.title} gives every account its own address:{" "}
          <code data-testid="address-template">{shownTemplate}</code>. Fill in yours — it is usually
          part of the address you sign in at.
        </p>
      )}
      {!server && (
        <div className="dash-callout dash-callout--info" data-testid="address-guessed">
          {connection.addressPending
            ? `The documentation did not say where ${connection.title}'s API lives, so the address below is a guess — the site the documentation is on. Enter the address requests should go to; the docs' example requests usually show it.`
            : `Requests to ${connection.title} go to this address.`}
        </div>
      )}

      {error && (
        <p role="alert" className="dash-callout dash-callout--bad">
          {error}
        </p>
      )}

      {server && !whole ? (
        <>
          {server.variables.map((variable) => {
            const placeholder = variable.default ?? "";
            return (
              <div className="dash-field" key={variable.name}>
                <label htmlFor={`addr-${variable.name}`}>{variable.label ?? variable.name}</label>
                {variable.options && variable.options.length > 0 ? (
                  <select
                    id={`addr-${variable.name}`}
                    data-testid={`address-${variable.name}`}
                    value={values[variable.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [variable.name]: event.target.value }))
                    }
                  >
                    <option value="" disabled>
                      Choose…
                    </option>
                    {variable.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`addr-${variable.name}`}
                    data-testid={`address-${variable.name}`}
                    value={values[variable.name] ?? ""}
                    /* A documented placeholder is a hint, never a value. */
                    placeholder={looksLikePlaceholder(variable) && placeholder ? `e.g. ${placeholder}` : placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [variable.name]: event.target.value }))
                    }
                  />
                )}
                {variable.description && <span className="dash-hint">{variable.description}</span>}
              </div>
            );
          })}
          <p className="dash-hint" data-testid="address-preview">
            {filled?.url ? (
              <>
                Requests will go to <code>{filled.url}</code>
              </>
            ) : filled && filled.invalid.length > 0 ? (
              "Only letters, numbers, dots, dashes and underscores — no slashes or spaces."
            ) : (
              "Fill in the blanks to see the address."
            )}
          </p>
        </>
      ) : (
        <div className="dash-field">
          <label htmlFor="addr-whole">API address</label>
          <input
            id="addr-whole"
            data-testid="address-whole"
            value={address}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
          <span className="dash-hint">
            Everything before the endpoint paths — the same for every request.
          </span>
        </div>
      )}

      <div className="dash-row dash-row--end" style={{ marginTop: 12, gap: 8 }}>
        {server && (
          <button
            className="dash-control"
            data-testid="address-toggle"
            disabled={busy}
            onClick={() => {
              setWhole((previous) => !previous);
              setError(null);
            }}
          >
            {whole ? "Fill in the blanks instead" : "Type the whole address instead"}
          </button>
        )}
        {onBack && (
          <button className="dash-control" disabled={busy} onClick={onBack}>
            Back
          </button>
        )}
        <button
          className="dash-control dash-control--primary"
          data-testid="address-save"
          disabled={busy || !ready}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Use this address"}
        </button>
      </div>
    </section>
  );
};
