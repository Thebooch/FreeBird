import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { itemAttrs, screenAttrs, useChatFocus, useScreenChanged } from "../chatScreen.js";
import {
  CONTACT_FIELD_KINDS,
  type ContactFieldDef,
  type ContactFieldDefInput,
  type ContactFieldKind,
  type ContactFieldSource,
  type ContactMatchRule,
  type ContactMatchRuleInput,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { api, type ContactSetup, type ContactSource } from "../../api.js";
import { Segmented, Switch } from "../calendar/controls.jsx";
import { ChipsInput, FormRow, SheetSection, TextInput } from "../calendar/scheduling/inputs.jsx";
import { SetupSheet } from "../calendar/scheduling/SetupSheet.jsx";
import { KIND_WORDS, keyOfLabel, recordTypeWords, sourceWords } from "./model.js";

/**
 * Contact fields: the facts contacts hold, which block rules read as
 * `contact.<key>`, and where each comes from — a field of a record type in
 * one of your connections, with its values mapped to yours ("A" →
 * "existing"), or what the person is asked. Below them, the match rules that
 * link a contact to a record.
 */

const FIELD_SCREENS = ["contactFields"] as const;

export const FieldsTab = ({ canManage }: { readonly canManage: boolean }): JSX.Element => {
  const [setup, setSetup] = useState<ContactSetup | null>(null);
  const [sources, setSources] = useState<ContactSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: "field"; def: ContactFieldDef | null } | { kind: "rule"; rule: ContactMatchRule | null } | null>(null);

  const reload = useCallback(async () => {
    try {
      setSetup(await api.contactSetup());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void reload();
    if (canManage) void api.contactSources().then(setSources, () => undefined);
  }, [reload, canManage]);
  /* What the chat changes here shows at once; what is open is what "this" means to it. */
  useScreenChanged(FIELD_SCREENS, useCallback(() => void reload(), [reload]));
  useChatFocus(
    "contactFields",
    editing?.kind === "field" && editing.def ? { id: editing.def.key, label: editing.def.label } : editing?.kind === "rule" && editing.rule ? { id: editing.rule.id, label: `${editing.rule.connection} ${editing.rule.entity}` } : null,
  );

  if (error && !setup) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!setup) return <p className="dash-hint">Loading…</p>;

  return (
    <div className="dash-sched-tab" data-testid="contact-fields" {...screenAttrs("contactFields")}>
      <div className="dash-sched-columns">
        <section className="dash-sched-panel" aria-labelledby="contact-fields-title">
          <header className="dash-sched-panel__head">
            <div>
              <h2 id="contact-fields-title" className="dash-sched-panel__title">
                Fields
              </h2>
              <p className="dash-sched-panel__lede">What block rules can ask about a contact, and where its value comes from.</p>
            </div>
            {canManage && (
              <Button onClick={() => setEditing({ kind: "field", def: null })} testId="fields-add">
                New field
              </Button>
            )}
          </header>
          {setup.fields.length === 0 ? (
            <EmptyState glyph="◇" title="No fields yet" body="Add the facts your blocks decide on: a service area, a segment, whether they have pets. Each can come from a record, from asking, or from your team." />
          ) : (
            <ul className="dash-sched-list">
              {setup.fields.map((def) => (
                <li key={def.key} {...itemAttrs(def.key)}>
                  <button type="button" className="dash-sched-item" onClick={() => canManage && setEditing({ kind: "field", def })} disabled={!canManage} data-testid="fields-row">
                    <span className="dash-contacts-kind" aria-hidden="true">
                      {KIND_GLYPHS[def.kind]}
                    </span>
                    <span className="dash-sched-item__main">
                      <span className="dash-sched-item__title">
                        {def.label}
                        <code className="dash-contacts-key">contact.{def.key}</code>
                      </span>
                      <span className="dash-sched-item__meta">
                        {KIND_WORDS[def.kind]}
                        {def.kind === "choice" && def.choices ? `: ${def.choices.join(", ")}` : ""}
                        {def.sources.length > 0 ? ` · from ${def.sources.map((source) => sourceWords(source, sources)).join("; ")}` : " · not filled from records"}
                      </span>
                    </span>
                    <span className="dash-sched-item__aside dash-contacts-badges">
                      {def.askable && <Badge tone="accent">Asked</Badge>}
                      {def.trust === "record" && <Badge>Records only</Badge>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dash-sched-panel" aria-labelledby="contact-match-title">
          <header className="dash-sched-panel__head">
            <div>
              <h2 id="contact-match-title" className="dash-sched-panel__title">
                Matching
              </h2>
              <p className="dash-sched-panel__lede">A contact is linked to a record when exactly one record matches. Matching reads as the person who saved the rule.</p>
            </div>
            {canManage && (
              <Button onClick={() => setEditing({ kind: "rule", rule: null })} testId="match-add">
                New rule
              </Button>
            )}
          </header>
          {setup.matchRules.length === 0 ? (
            <EmptyState glyph="⇄" title="No match rules" body="Without one, contacts stay in Dash only and fields with a record source stay empty." />
          ) : (
            <ul className="dash-sched-list">
              {setup.matchRules.map((rule) => (
                <li key={rule.id} {...itemAttrs(rule.id)}>
                  <button type="button" className="dash-sched-item" onClick={() => canManage && setEditing({ kind: "rule", rule })} disabled={!canManage} data-testid="match-row">
                    <span className="dash-contacts-kind" aria-hidden="true">
                      ⇄
                    </span>
                    <span className="dash-sched-item__main">
                      <span className="dash-sched-item__title">{recordTypeWords(rule.connection, rule.entity, sources)}</span>
                      <span className="dash-sched-item__meta">{rule.on.map((pair) => `${pair.contact} = ${pair.record}`).join(" and ")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing?.kind === "field" && (
        <FieldSheet
          def={editing.def}
          taken={setup.fields.map((one) => one.key)}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {editing?.kind === "rule" && (
        <MatchRuleSheet
          rule={editing.rule}
          fields={setup.fields}
          sources={sources}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
};

const KIND_GLYPHS: Readonly<Record<ContactFieldKind, string>> = {
  text: "Aa",
  choice: "◉",
  address: "⌂",
  email: "@",
  phone: "☏",
  number: "#",
  date: "▦",
  boolean: "✓",
};

/* ── a field ───────────────────────────────────────────────────────────── */

const FieldSheet = ({
  def,
  taken,
  sources,
  onClose,
  onSaved,
}: {
  readonly def: ContactFieldDef | null;
  readonly taken: readonly string[];
  readonly sources: readonly ContactSource[];
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): JSX.Element => {
  const [draft, setDraft] = useState<ContactFieldDefInput>(() =>
    def
      ? { label: def.label, kind: def.kind, ...(def.choices ? { choices: def.choices } : {}), askable: def.askable, ...(def.ask ? { ask: def.ask } : {}), trust: def.trust, sources: def.sources }
      : { label: "", kind: "text", askable: false, trust: "any", sources: [] },
  );
  const [key, setKey] = useState(def?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(false);
  const set = <K extends keyof ContactFieldDefInput>(name: K, value: ContactFieldDefInput[K]) => setDraft((held) => ({ ...held, [name]: value }));
  const fieldSources = draft.sources ?? [];

  return (
    <SetupSheet
      trail="Contacts / Contact fields"
      title={def ? def.label : "New field"}
      wide
      testId="field-sheet"
      onClose={onClose}
      onSave={async () => {
        const finalKey = def?.key ?? (key.trim() || keyOfLabel(draft.label ?? ""));
        if (!def && taken.includes(finalKey)) throw new Error(`There is already a field "${finalKey}".`);
        await api.putContactField(finalKey, { ...draft, label: (draft.label ?? "").trim(), sources: fieldSources.filter((one) => one.connection && one.entity && one.field) });
        await onSaved();
      }}
      {...(def
        ? {
            onRemove: async () => {
              await api.removeContactField(def.key);
              await onSaved();
            },
          }
        : {})}
    >
      <SheetSection title="Field" description="Rules read it as contact.<key>. The key can't change once the field exists.">
        <FormRow label="Name">
          {(field) => (
            <TextInput
              id={field}
              value={draft.label ?? ""}
              placeholder="Service area"
              maxLength={80}
              onChange={(label) => {
                set("label", label);
                if (!def && !keyTouched) setKey(keyOfLabel(label));
              }}
              testId="field-label"
            />
          )}
        </FormRow>
        <FormRow label="Key" hint="Letters and digits, used in rules.">
          {(field) =>
            def ? (
              <code className="dash-contacts-key dash-contacts-key--large">contact.{def.key}</code>
            ) : (
              <div className="dash-contacts-keyinput">
                <span className="dash-contacts-keyinput__prefix">contact.</span>
                <input
                  id={field}
                  className="dash-sched-input"
                  value={key}
                  placeholder="serviceArea"
                  onChange={(event) => {
                    setKeyTouched(true);
                    setKey(event.target.value.replace(/[^a-zA-Z0-9_]/g, ""));
                  }}
                  data-testid="field-key"
                />
              </div>
            )
          }
        </FormRow>
        <FormRow label="Kind" hint="How values compare: addresses and phones are normalized, choices are one of a list.">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.kind} onChange={(event) => set("kind", event.target.value as ContactFieldKind)}>
              {CONTACT_FIELD_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_WORDS[kind]}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        {draft.kind === "choice" && (
          <FormRow label="Choices">{(field) => <ChipsInput id={field} values={draft.choices ?? []} placeholder="new, existing" onChange={(choices) => set("choices", choices)} testId="field-choices" />}</FormRow>
        )}
      </SheetSection>

      <SheetSection title="Asking" description="Whether the booking page and agents may ask the person for it. Leave it off for anything they could answer to their own advantage.">
        <FormRow label="Ask for it">
          {() => <Switch checked={draft.askable ?? false} onChange={(askable) => set("askable", askable)} label={draft.askable ? "Asked when it decides which times show" : "Never asked"} />}
        </FormRow>
        {draft.askable && (
          <FormRow label="Question">{(field) => <TextInput id={field} value={draft.ask ?? ""} placeholder="Which part of town is the visit in?" maxLength={200} onChange={(ask) => set("ask", ask)} />}</FormRow>
        )}
        <FormRow label="Rules trust" hint="Records only: what the person said counts as unknown, and the block's “when unknown” decides.">
          {() => (
            <Segmented
              label="Which values rules trust"
              value={draft.trust ?? "any"}
              options={[
                { value: "any", label: "Any value" },
                { value: "record", label: "Records and your team only" },
              ]}
              onChange={(trust) => set("trust", trust)}
            />
          )}
        </FormRow>
      </SheetSection>

      <SheetSection
        title="Filled from records"
        description="When a contact is linked to a record of this type, the value is copied once, and again on Refresh."
        actions={
          <Button size="sm" tone="ghost" onClick={() => set("sources", [...fieldSources, { connection: sources[0]?.connection ?? "", entity: "", field: "" }])} disabled={sources.length === 0 || fieldSources.length >= 10}>
            + Source
          </Button>
        }
      >
        {sources.length === 0 && fieldSources.length === 0 ? (
          <p className="dash-contacts-note">No connections you can read have record types yet. Connect one, and its fields show here.</p>
        ) : fieldSources.length === 0 ? (
          <p className="dash-contacts-note">Not filled from records. Add a source to copy it from a field in one of your connections.</p>
        ) : (
          fieldSources.map((source, index) => (
            <SourceEditor
              key={index}
              source={source}
              kind={draft.kind ?? "text"}
              choices={draft.choices ?? []}
              sources={sources}
              onChange={(next) => set("sources", fieldSources.map((one, at) => (at === index ? next : one)))}
              onRemove={() => set("sources", fieldSources.filter((_, at) => at !== index))}
            />
          ))
        )}
      </SheetSection>
    </SetupSheet>
  );
};

/** One source: a connection, a record type, a field in it, and its values mapped to ours. */
const SourceEditor = ({
  source,
  kind,
  choices,
  sources,
  onChange,
  onRemove,
}: {
  readonly source: ContactFieldSource;
  readonly kind: ContactFieldKind;
  readonly choices: readonly string[];
  readonly sources: readonly ContactSource[];
  readonly onChange: (source: ContactFieldSource) => void;
  readonly onRemove: () => void;
}): JSX.Element => {
  const connection = sources.find((one) => one.connection === source.connection);
  const entity = connection?.entities.find((one) => one.entity === source.entity);
  const field = entity?.fields.find((one) => one.path === source.field);
  const samples = field?.samples ?? [];
  const map = source.map ?? {};
  return (
    <div className="dash-contact-source" data-testid="field-source">
      <div className="dash-contact-source__pick">
        <select className="dash-sched-input" aria-label="Connection" value={source.connection} onChange={(event) => onChange({ connection: event.target.value, entity: "", field: "" })}>
          <option value="">Connection…</option>
          {source.connection && !connection && <option value={source.connection}>{source.connection} (not available)</option>}
          {sources.map((one) => (
            <option key={one.connection} value={one.connection}>
              {one.title}
            </option>
          ))}
        </select>
        <select className="dash-sched-input" aria-label="Record type" value={source.entity} disabled={!connection} onChange={(event) => onChange({ connection: source.connection, entity: event.target.value, field: "" })}>
          <option value="">Record type…</option>
          {source.entity && !entity && <option value={source.entity}>{source.entity}</option>}
          {connection?.entities.map((one) => (
            <option key={one.entity} value={one.entity}>
              {one.name}
            </option>
          ))}
        </select>
        <select className="dash-sched-input" aria-label="Field" value={source.field} disabled={!entity} onChange={(event) => onChange({ connection: source.connection, entity: source.entity, field: event.target.value })}>
          <option value="">Field…</option>
          {source.field && !field && <option value={source.field}>{source.field}</option>}
          {entity?.fields.map((one) => (
            <option key={one.path} value={one.path}>
              {one.label ? `${one.label} (${one.path})` : one.path}
            </option>
          ))}
        </select>
        <button type="button" className="dash-sched-rule__remove" aria-label="Remove this source" onClick={onRemove}>
          ✕
        </button>
      </div>
      {samples.length > 0 && (
        <div className="dash-contact-source__map">
          <span className="dash-contact-source__map-title">{kind === "choice" ? "Their values, as yours" : "Values seen in it"}</span>
          {kind === "choice" ? (
            <div className="dash-contact-source__map-rows">
              {samples.map((sample) => (
                <label key={sample} className="dash-contact-source__map-row">
                  <code className="dash-contacts-key">{sample}</code>
                  <span aria-hidden="true">→</span>
                  <select
                    className="dash-sched-input"
                    value={map[sample] ?? ""}
                    onChange={(event) => {
                      const { [sample]: _gone, ...rest } = map;
                      const next = event.target.value ? { ...rest, [sample]: event.target.value } : rest;
                      onChange({ ...source, ...(Object.keys(next).length > 0 ? { map: next } : { map: {} }) });
                    }}
                  >
                    <option value="">{choices.some((choice) => choice.toLowerCase() === sample.toLowerCase()) ? `${sample} (as is)` : "Not mapped"}</option>
                    {choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <span className="dash-contact-source__samples">{samples.slice(0, 8).join(" · ")}</span>
          )}
        </div>
      )}
    </div>
  );
};

/* ── a match rule ──────────────────────────────────────────────────────── */

const MatchRuleSheet = ({
  rule,
  fields,
  sources,
  onClose,
  onSaved,
}: {
  readonly rule: ContactMatchRule | null;
  readonly fields: readonly ContactFieldDef[];
  readonly sources: readonly ContactSource[];
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): JSX.Element => {
  const [draft, setDraft] = useState<ContactMatchRuleInput>(() =>
    rule ? { connection: rule.connection, entity: rule.entity, on: rule.on.map((pair) => ({ ...pair })) } : { connection: sources[0]?.connection ?? "", entity: "", on: [{ contact: "email", record: "" }] },
  );
  const connection = sources.find((one) => one.connection === draft.connection);
  const entity = connection?.entities.find((one) => one.entity === draft.entity);
  const keys = [
    { value: "email", label: "Email" },
    { value: "phone", label: "Phone" },
    ...fields.map((def) => ({ value: def.key, label: def.label })),
  ];
  return (
    <SetupSheet
      trail="Contacts / Matching"
      title={rule ? recordTypeWords(rule.connection, rule.entity, sources) : "New match rule"}
      wide
      testId="match-sheet"
      onClose={onClose}
      onSave={async () => {
        if (!draft.connection || !draft.entity) throw new Error("Pick the connection and record type to match against.");
        if (draft.on.some((pair) => !pair.record)) throw new Error("Pick the record's field for each line.");
        await api.putMatchRule(rule?.id ?? null, draft);
        await onSaved();
      }}
      {...(rule
        ? {
            onRemove: async () => {
              await api.removeMatchRule(rule.id);
              await onSaved();
            },
          }
        : {})}
    >
      <SheetSection title="Match against" description="Saving makes you the person matching reads as: it can only find records you may read.">
        <FormRow label="Connection">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.connection} onChange={(event) => setDraft({ ...draft, connection: event.target.value, entity: "", on: draft.on.map((pair) => ({ ...pair, record: "" })) })}>
              <option value="">Pick one…</option>
              {draft.connection && !connection && <option value={draft.connection}>{draft.connection} (not available)</option>}
              {sources.map((one) => (
                <option key={one.connection} value={one.connection}>
                  {one.title}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label="Record type">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.entity} disabled={!connection} onChange={(event) => setDraft({ ...draft, entity: event.target.value, on: draft.on.map((pair) => ({ ...pair, record: "" })) })}>
              <option value="">Pick one…</option>
              {draft.entity && !entity && <option value={draft.entity}>{draft.entity}</option>}
              {connection?.entities.map((one) => (
                <option key={one.entity} value={one.entity}>
                  {one.name}
                </option>
              ))}
            </select>
          )}
        </FormRow>
      </SheetSection>
      <SheetSection
        title="When these are equal"
        description="Every line must match. Emails and phones are compared the way they are meant, not as typed."
        actions={
          <Button size="sm" tone="ghost" disabled={draft.on.length >= 3} onClick={() => setDraft({ ...draft, on: [...draft.on, { contact: "phone", record: "" }] })}>
            + Line
          </Button>
        }
      >
        {draft.on.map((pair, index) => (
          <div key={index} className="dash-contact-pair">
            <select className="dash-sched-input" aria-label="Contact's" value={pair.contact} onChange={(event) => setDraft({ ...draft, on: draft.on.map((one, at) => (at === index ? { ...one, contact: event.target.value } : one)) })}>
              {keys.map((one) => (
                <option key={one.value} value={one.value}>
                  Contact's {one.label.toLowerCase()}
                </option>
              ))}
            </select>
            <span className="dash-contact-pair__equals" aria-hidden="true">
              =
            </span>
            <select className="dash-sched-input" aria-label="Record's field" value={pair.record} disabled={!entity} onChange={(event) => setDraft({ ...draft, on: draft.on.map((one, at) => (at === index ? { ...one, record: event.target.value } : one)) })}>
              <option value="">Record's field…</option>
              {pair.record && !entity?.fields.some((one) => one.path === pair.record) && <option value={pair.record}>{pair.record}</option>}
              {entity?.fields.map((one) => (
                <option key={one.path} value={one.path}>
                  {one.label ? `${one.label} (${one.path})` : one.path}
                </option>
              ))}
            </select>
            <button type="button" className="dash-sched-rule__remove" aria-label="Remove this line" disabled={draft.on.length === 1} onClick={() => setDraft({ ...draft, on: draft.on.filter((_, at) => at !== index) })}>
              ✕
            </button>
          </div>
        ))}
      </SheetSection>
    </SetupSheet>
  );
};
