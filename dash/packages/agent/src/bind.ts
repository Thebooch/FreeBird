import type { ComponentContract, RoleContract, ValueType, WidgetSpec } from "@freebirdai/dash-spec";
import { parseWidget } from "@freebirdai/dash-spec";

/**
 * Binding a component to real fields, without a model.
 *
 * The authoring agent is source-first: you pick an endpoint and it proposes a
 * widget. This is the other direction — pick the component you want, then say
 * which field fills each role — and it is entirely deterministic, so it works
 * with no API key and produces the same widget every time.
 *
 * It lives here rather than in the web app because three surfaces now need it:
 * the widget palette in the browser, and the concierge's question derivation
 * and widget construction on the server. A second copy would be a second set
 * of rules about which fields may fill which role, and the two would drift.
 */

/**
 * The least a field has to be for these rules to read it.
 *
 * Structural rather than one concrete type, so both `FieldInfo` from the shape
 * inferrer (`format?: FieldFormat`) and the browser's sampled field
 * (`format: string | null`) satisfy it without either being converted.
 */
export interface BindableField {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly format?: string | null;
}

const DATE_FORMATS = new Set(["iso8601", "unix_seconds", "unix_millis"]);

const isDated = (field: BindableField): boolean =>
  typeof field.format === "string" && DATE_FORMATS.has(field.format);

/**
 * What a sampled field can be used as.
 *
 * `kinds` is what the JSON actually held; `format` is what the shape inferrer
 * recognised it as. A date arrives as a string, so without the format check a
 * timeline would be offered no fields at all on an API that reports ISO dates
 * — which is most of them.
 */
export const valueTypesOf = (field: BindableField): readonly ValueType[] => {
  const types = new Set<ValueType>();

  if (isDated(field)) types.add("temporal");
  for (const kind of field.kinds) {
    if (kind === "number") {
      types.add("numeric");
      // A unix timestamp is a number that is also a time.
      if (field.format === "unix_seconds" || field.format === "unix_millis") types.add("temporal");
    } else if (kind === "boolean") types.add("boolean");
    else if (kind === "string") {
      types.add("text");
      types.add("categorical");
    }
    // Objects and arrays fill no role: every component reads scalars, and
    // offering one would produce "[object Object]" in a cell.
  }

  return [...types];
};

/**
 * The fields worth offering for a role.
 *
 * A field the role cannot accept is left out rather than shown and rejected
 * later — the contract already knows, so making somebody discover it by
 * choosing wrong is a worse use of their time.
 *
 * Time roles get one extra rule. Their contract accepts `numeric` because a
 * unix timestamp is a number, which means every id and count on the endpoint
 * technically qualifies — so a timeline would offer "PropertyId" as a date.
 * Where the endpoint has fields that really are dates, only those are offered;
 * the raw numbers come back as candidates only when there is nothing better,
 * which is the case that rule exists for.
 */
export const fieldsForRole = <T extends BindableField>(
  role: RoleContract,
  fields: readonly T[],
): readonly T[] => {
  const usable = fields.filter((field) => {
    /*
     * Nested paths used to be excluded here, because the builder could not
     * flatten one and a role naming `Unit.UnitNumber` would have bound to
     * nothing. It derives them now, so the only question left is the one that
     * was always the real one: can this field fill this role?
     *
     * `valueTypesOf` already answers no for a container, so an object or an
     * array still falls out — on the honest grounds that it cannot be drawn
     * rather than on where it sits.
     */
    const types = valueTypesOf(field);
    return types.some((type) => role.accepts.includes(type));
  });

  /*
   * Only for a role that is *about* time. A table's `columns` accepts every
   * type including temporal, and narrowing that to dates would offer a table
   * nothing but its timestamp column — so the test is that the role does not
   * also take text.
   */
  const timeRole = role.accepts.includes("temporal") && !role.accepts.includes("text");
  if (!timeRole) return usable;

  const dated = usable.filter(isDated);
  return dated.length > 0 ? dated : usable;
};

/** Roles with nothing to fill them, which is worth saying before the picking starts. */
export const unfillableRoles = (
  contract: ComponentContract,
  fields: readonly BindableField[],
): readonly RoleContract[] =>
  contract.roles.filter((role) => role.required && fieldsForRole(role, fields).length === 0);

/**
 * Whether this component can be built at all from these fields.
 *
 * The question a concierge asks before offering a view: a component whose
 * required roles nothing here can fill is not a choice, it is a dead end
 * somebody would have to back out of.
 */
export const componentFits = (
  contract: ComponentContract,
  fields: readonly BindableField[],
): boolean => unfillableRoles(contract, fields).length === 0;

export type RoleBinding = Readonly<Record<string, string | readonly string[]>>;

/** Which required roles are still empty. */
export const missingRoles = (
  contract: ComponentContract,
  bound: RoleBinding,
): readonly string[] =>
  contract.roles
    .filter((role) => {
      if (!role.required) return false;
      const value = bound[role.role];
      if (value === undefined) return true;
      return Array.isArray(value) ? value.length === 0 : value === "";
    })
    .map((role) => role.role);

/**
 * The coercions a set of bindings needs to be usable.
 *
 * A date arrives as a string and stays text until something says otherwise, so
 * a temporal role bound to an ISO field needs this or the binding check
 * refuses it. Shared because the concierge builds the same pipeline for a
 * joined widget, where the same reasoning applies per source.
 */
export const coercionsFor = (
  roles: RoleBinding,
  fields: readonly BindableField[],
): Record<string, string> => {
  const coercions: Record<string, string> = {};
  const byName = new Map(fields.map((field) => [field.name, field]));

  for (const value of Object.values(roles)) {
    for (const name of Array.isArray(value) ? value : [value as string]) {
      const field = byName.get(name);
      if (!field) continue;
      if (field.format === "iso8601") coercions[name] = "iso->datetime";
      else if (field.format === "unix_seconds") coercions[name] = "unix_s->datetime";
      else if (field.format === "unix_millis") coercions[name] = "unix_ms->datetime";
    }
  }
  return coercions;
};

export interface BuildInput {
  readonly id: string;
  readonly title: string;
  readonly component: string;
  readonly connection: string;
  readonly op: string;
  readonly rowsPath: string;
  readonly roles: RoleBinding;
  readonly fields: readonly BindableField[];
  readonly schemaHash?: string;
}

/**
 * Turn the picks into a widget.
 *
 * Runs through `parseWidget` rather than being trusted: this builds the same
 * shape the authoring agent produces, so it goes through the same validation
 * and fails the same way when something does not fit.
 */
export const buildWidget = (
  input: BuildInput,
): { widget: WidgetSpec | null; errors: readonly string[] } => {
  const pipeline: unknown[] = [{ op: "extract", path: input.rowsPath || "$" }];

  const coercions = coercionsFor(input.roles, input.fields);
  if (Object.keys(coercions).length > 0) pipeline.push({ op: "coerce", fields: coercions });

  const format: Record<string, { semantic: string }> = {};
  for (const name of Object.keys(coercions)) format[name] = { semantic: "timestamp" };

  const parsed = parseWidget({
    id: input.id,
    title: input.title,
    component: input.component,
    source: { connection: input.connection, op: input.op, params: {} },
    pipeline,
    roles: input.roles,
    format,
    ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
  });

  return { widget: parsed.value ?? null, errors: parsed.errors ?? [] };
};

/**
 * A widget id from a title, unique against what is already there.
 *
 * The same rule the server uses for dashboards: slugify, then suffix. A
 * collision otherwise makes the whole save fail on a name somebody chose
 * innocently.
 */
export const widgetId = (title: string, taken: ReadonlySet<string>): string => {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "widget";

  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};
