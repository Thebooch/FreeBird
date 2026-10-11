import { FIELD_RULE_WORDS, WEEKDAYS, ruleSetIsEmpty, type FieldRule, type RuleSet, type WeeklyHours } from "@freebirdai/dash-spec";

/**
 * Rules and hours in words, for an approval card: what a person would read on
 * the screen ("party size is at most 8 and segment is one of members"), never
 * the JSON behind it.
 */

const ruleInWords = (rule: FieldRule): string => {
  const field = rule.field.replace(/^(contact|request|type)\./, "");
  const op = FIELD_RULE_WORDS[rule.op];
  const values = rule.op === "exists" || rule.op === "missing" ? "" : rule.op === "between" ? ` ${rule.values[0] ?? "?"} and ${rule.values[1] ?? "?"}` : ` ${rule.values.join(", ")}`;
  return `${field} ${op}${values}${rule.trusted ? " (from records only)" : ""}`;
};

export const rulesInWords = (rules: RuleSet | undefined): string => {
  if (!rules || ruleSetIsEmpty(rules)) return "Anyone";
  const parts = [
    ...(rules.all.length > 0 ? [rules.all.map(ruleInWords).join(" and ")] : []),
    ...(rules.any.length > 0 ? [`${rules.all.length > 0 ? "and any of: " : "any of: "}${rules.any.map(ruleInWords).join(" or ")}`] : []),
    ...(rules.expression?.trim() ? [`and ${rules.expression.trim()}`] : []),
  ];
  return parts.join(", ");
};

const DAY_WORDS: Readonly<Record<(typeof WEEKDAYS)[number], string>> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** "Mon–Fri 09:00–17:00; Sat 10:00–14:00", days with the same hours grouped. */
export const hoursInWords = (hours: WeeklyHours | undefined | null): string => {
  if (!hours) return "Each host's own hours";
  const ranges = (day: (typeof WEEKDAYS)[number]) => hours[day].map((one) => `${one.from}–${one.to}`).join(", ");
  const groups: Array<{ days: string[]; ranges: string }> = [];
  for (const day of WEEKDAYS) {
    const these = ranges(day);
    if (!these) continue;
    const last = groups[groups.length - 1];
    if (last && last.ranges === these && WEEKDAYS.indexOf(day) === WEEKDAYS.indexOf(last.days[last.days.length - 1] as (typeof WEEKDAYS)[number]) + 1) last.days.push(day);
    else groups.push({ days: [day], ranges: these });
  }
  if (groups.length === 0) return "Closed every day";
  return groups
    .map((group) => {
      const first = DAY_WORDS[group.days[0] as (typeof WEEKDAYS)[number]];
      const label = group.days.length === 1 ? first : `${first}–${DAY_WORDS[group.days[group.days.length - 1] as (typeof WEEKDAYS)[number]]}`;
      return `${label} ${group.ranges}`;
    })
    .join("; ");
};
