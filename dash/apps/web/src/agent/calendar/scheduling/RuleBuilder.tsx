import { FIELD_RULE_OPS, type FieldRule, type RuleSet } from "@freebirdai/dash-spec";
import { Button } from "@freebirdai/dash-components";
import { useId, useState } from "react";
import { ChipsInput } from "./inputs.jsx";
import { FACT_SUGGESTIONS, OP_WORDS, type FieldOption } from "./model.js";

const TAKES_NO_VALUES = new Set<FieldRule["op"]>(["exists", "missing"]);
const ONE_VALUE = new Set<FieldRule["op"]>(["equals", "not_equals", "gte", "lte"]);

/**
 * Who a block (or an approval) applies to, as rows anybody can read: a field,
 * how it compares, and the values. "All of these" must each hold; "any of
 * these" needs one. A field can be any contact field, any answer given while
 * booking, or a count Dash keeps — the suggestions are a start, not a limit.
 * An expression covers what the rows cannot say.
 */
export const RuleBuilder = ({
  value,
  onChange,
  fields = [],
  testId,
}: {
  readonly value: RuleSet;
  readonly onChange: (rules: RuleSet) => void;
  /** Contact fields this workspace has set up, offered first, with their trust and choices. */
  readonly fields?: readonly FieldOption[];
  readonly testId?: string;
}): JSX.Element => {
  const listId = useId();
  const [advanced, setAdvanced] = useState(Boolean(value.expression?.trim()));
  const suggestions: readonly FieldOption[] = [...fields, ...FACT_SUGGESTIONS.filter((one) => !fields.some((field) => field.path === one.path))];
  /** A rule on a field set to trust records starts out wanting a record's value. */
  const ruleOn = (rule: FieldRule, field: string): FieldRule => {
    const { trusted: _trusted, ...rest } = rule;
    const option = suggestions.find((one) => one.path === field);
    return { ...rest, field, ...(option?.trust === "record" || (option === undefined && rule.trusted) ? { trusted: true } : {}) };
  };

  const group = (key: "all" | "any", title: string, hint: string) => {
    const rules = value[key];
    const set = (next: FieldRule[]) => onChange({ ...value, [key]: next });
    return (
      <div className="dash-sched-rules__group">
        <div className="dash-sched-rules__group-head">
          <span className="dash-sched-rules__group-title">{title}</span>
          <span className="dash-hint">{hint}</span>
        </div>
        {rules.length === 0 && <p className="dash-sched-rules__empty">None.</p>}
        {rules.map((rule, index) => (
          <div key={index} className="dash-sched-rule" data-testid="rule-row">
            <input
              className="dash-sched-input dash-sched-rule__field"
              value={rule.field}
              list={listId}
              placeholder="contact.category"
              aria-label="Field"
              onChange={(event) => set(rules.map((one, at) => (at === index ? ruleOn(one, event.target.value.trim()) : one)))}
            />
            <select
              className="dash-sched-input dash-sched-rule__op"
              value={rule.op}
              aria-label="How it compares"
              onChange={(event) => set(rules.map((one, at) => (at === index ? { ...one, op: event.target.value as FieldRule["op"] } : one)))}
            >
              {FIELD_RULE_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_WORDS[op]}
                </option>
              ))}
            </select>
            {TAKES_NO_VALUES.has(rule.op) ? (
              <span className="dash-sched-rule__none" />
            ) : (
              <ChipsInput
                values={rule.values.map(String)}
                {...(suggestions.find((one) => one.path === rule.field)?.choices ? { suggestions: suggestions.find((one) => one.path === rule.field)!.choices! } : {})}
                placeholder={ONE_VALUE.has(rule.op) ? "A value" : rule.op === "between" ? "From, to" : "Values: Enter after each"}
                onChange={(values) => set(rules.map((one, at) => (at === index ? { ...one, values: ONE_VALUE.has(rule.op) ? values.slice(-1) : values } : one)))}
              />
            )}
            <label className="dash-sched-rule__trust" title="Count only a value from a matched record or a team member, not what the person said about themselves.">
              <input type="checkbox" checked={rule.trusted === true} onChange={(event) => set(rules.map((one, at) => (at === index ? { ...one, trusted: event.target.checked || undefined } : one)))} />
              From records only
            </label>
            <button type="button" className="dash-sched-rule__remove" aria-label="Remove this condition" onClick={() => set(rules.filter((_, at) => at !== index))}>
              ✕
            </button>
          </div>
        ))}
        <Button size="sm" tone="ghost" onClick={() => set([...rules, ruleOn({ field: "", op: "in", values: [] }, suggestions[0]?.path ?? "contact.category")])} testId={`rules-add-${key}`}>
          + Add a condition
        </Button>
      </div>
    );
  };

  return (
    <div className="dash-sched-rules" {...(testId ? { "data-testid": testId } : {})}>
      <datalist id={listId}>
        {suggestions.map((one) => (
          <option key={one.path} value={one.path}>
            {one.label}
          </option>
        ))}
      </datalist>
      {group("all", "All of these", "Each must hold.")}
      {group("any", "Any of these", "At least one must hold, when there are any.")}
      {advanced ? (
        <div className="dash-sched-rules__group">
          <div className="dash-sched-rules__group-head">
            <span className="dash-sched-rules__group-title">Expression</span>
            <span className="dash-hint">Also must hold. Reads contact.*, request.* and type.*</span>
          </div>
          <textarea
            className="dash-sched-input dash-sched-textarea"
            value={value.expression ?? ""}
            placeholder='contact.stats.noShows < 2 && contact.category != "inactive"'
            onChange={(event) => onChange({ ...value, ...(event.target.value.trim() ? { expression: event.target.value } : { expression: undefined }) })}
          />
        </div>
      ) : (
        <button type="button" className="dash-sched-link" onClick={() => setAdvanced(true)}>
          Write an expression instead
        </button>
      )}
    </div>
  );
};
