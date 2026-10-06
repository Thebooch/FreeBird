import { Button } from "@freebirdai/dash-components";
import { useState } from "react";
import { api } from "../api";

/**
 * A text box with a Generate button beside its label.
 *
 * Generate sends what was typed to the model, which structures it into a
 * prompt a model follows well, and puts the draft in the box. Nothing is saved
 * until the agent is. The text it replaced is kept for one Undo, because a
 * draft that lost a rule somebody typed should cost one click to get back.
 */
export const GenerateField = ({
  id,
  label,
  hint,
  field,
  value,
  onChange,
  agent,
  rows = 5,
  maxLength,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly field: "role" | "instructions" | "personality" | "knowledge";
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** What the rest of the agent says, so a draft fits it. */
  readonly agent: { name?: string; role?: string };
  readonly rows?: number;
  readonly maxLength?: number;
  readonly placeholder?: string;
}): JSX.Element => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { text } = await api.assistAgent({ field, text: value, agent });
      setBefore(value);
      onChange(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-field dash-genfield">
      <div className="dash-genfield__head">
        <label htmlFor={id}>{label}</label>
        <span className="dash-genfield__actions">
          {before !== null && (
            <button
              type="button"
              className="dash-genfield__undo"
              onClick={() => {
                onChange(before);
                setBefore(null);
              }}
            >
              Undo
            </button>
          )}
          <Button
            size="sm"
            busy={busy}
            onClick={() => void generate()}
            title="Structure what you typed into a prompt the model follows well"
            testId={`agent-generate-${field}`}
          >
            ✦ Generate
          </Button>
        </span>
      </div>
      <textarea
        id={id}
        rows={rows}
        value={value}
        {...(maxLength ? { maxLength } : {})}
        {...(placeholder ? { placeholder } : {})}
        onChange={(event) => {
          setBefore(null);
          onChange(event.target.value);
        }}
      />
      {hint && <span className="dash-hint">{hint}</span>}
      {error && (
        <span className="dash-hint dash-genfield__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
