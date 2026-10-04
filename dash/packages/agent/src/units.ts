/**
 * A unit written where a field was meant.
 *
 * Asked for "delivered kilograms", a brief named the field `kilograms` — the
 * unit the request was in — where the record type holds the number as
 * `weight_kg`. No record has a field called that, so the widget could not be
 * built, and the brief said "none of these" rather than count the wrong
 * thing. A field whose name carries the unit is the field the unit was
 * written for, when exactly one does.
 *
 * Spellings of one unit, most specific first. No single letters: `m` or `s` at
 * the end of a field name is too often something else.
 */
const UNITS: readonly (readonly string[])[] = [
  ["kilogram", "kilograms", "kilo", "kilos", "kg", "kgs"],
  ["gram", "grams", "gr"],
  ["pound", "pounds", "lb", "lbs"],
  ["ounce", "ounces", "oz"],
  ["tonne", "tonnes", "ton", "tons"],
  ["kilometre", "kilometres", "kilometer", "kilometers", "km", "kms"],
  ["metre", "metres", "meter", "meters"],
  ["mile", "miles", "mi"],
  ["foot", "feet", "ft"],
  ["litre", "litres", "liter", "liters", "ltr"],
  ["gallon", "gallons", "gal"],
  ["hour", "hours", "hr", "hrs"],
  ["minute", "minutes", "min", "mins"],
  ["second", "seconds", "sec", "secs"],
  ["cent", "cents"],
  ["percent", "percentage", "pct"],
];

const UNIT_OF = new Map<string, number>(
  UNITS.flatMap((spellings, index) => spellings.map((spelling) => [spelling, index] as const)),
);

/** A name's words: `weightKg`, `weight_kg` and "weight kg" all read as weight, kg. */
export const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);

/** The units a name mentions, by index into `UNITS`. */
const unitsIn = (name: string): Set<number> => {
  const found = new Set<number>();
  for (const word of wordsOf(name)) {
    const unit = UNIT_OF.get(word);
    if (unit !== undefined) found.add(unit);
  }
  return found;
};

/** The fields whose names carry a unit the written name mentions, best match first. */
export const unitCarriers = <Field extends { readonly path: string; readonly label: string }>(
  fields: readonly Field[],
  named: string,
): Field[] => {
  const units = unitsIn(named);
  if (units.size === 0) return [];
  const other = new Set(wordsOf(named).filter((word) => !UNIT_OF.has(word)));
  const scored = fields
    .map((field) => {
      const carried = new Set([...unitsIn(field.path), ...unitsIn(field.label)]);
      if (![...units].some((unit) => carried.has(unit))) return null;
      /* "delivered kilograms" is `delivered_kg` before `returned_kg`. */
      const shared = new Set([...wordsOf(field.path), ...wordsOf(field.label)].filter((word) => other.has(word)));
      return { field, shared: shared.size };
    })
    .filter((one): one is { field: Field; shared: number } => one !== null);
  return scored.sort((a, b) => b.shared - a.shared).map((one) => one.field);
};

/** The one field a unit was written for, where one clearly is. */
export const unitCarrier = <Field extends { readonly path: string; readonly label: string }>(
  fields: readonly Field[],
  named: string,
): Field | undefined => {
  const carriers = unitCarriers(fields, named);
  if (carriers.length === 0) return undefined;
  if (carriers.length === 1) return carriers[0];
  /* Two that match as well as each other are a question, not an answer. */
  const other = new Set(wordsOf(named).filter((word) => !UNIT_OF.has(word)));
  const score = (field: Field) =>
    new Set([...wordsOf(field.path), ...wordsOf(field.label)].filter((word) => other.has(word))).size;
  return score(carriers[0]!) > score(carriers[1]!) ? carriers[0] : undefined;
};
