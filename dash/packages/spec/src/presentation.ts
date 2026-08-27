import { z } from "zod";
import type { BuiltinComponentId, ComponentId } from "./contracts.js";

/**
 * How a component looks, as data.
 *
 * The product ships one implementation of each component and every deployment
 * wants a slightly different one — a denser table, no badges in the header,
 * fields in a different order. Forking a renderer to get that is how a
 * component library becomes unmaintainable, so the variation lives here
 * instead: a validated object describing which slots are shown, in what order,
 * at what density, with which tokens.
 *
 * Nothing here executes. That is the load-bearing property — a presentation
 * can be stored in a database, sent over HTTP and applied to another tenant's
 * dashboard, which is exactly what `CodePart` cannot do. React never appears
 * in this file so the server, the authoring agent and the chat can all reason
 * about a customisation without a DOM.
 */

/**
 * Keys that must never reach a plain object used as a map.
 *
 * The same rule the expression parser applies: reject at parse time rather
 * than defending at every read. `slots["__proto__"] = x` does not create an
 * own property, it walks the prototype — so a merge written the obvious way is
 * a prototype-pollution bug unless the key was refused up front.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const safeKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "names must start with a letter and be [a-zA-Z0-9_-]")
  .refine((key) => !FORBIDDEN_KEYS.has(key), "that name is reserved");

/** Padding and row height only. Density never changes *what* is shown. */
export const densitySchema = z.enum(["compact", "cozy", "comfortable"]);
export type Density = z.infer<typeof densitySchema>;

export const DENSITIES: readonly Density[] = ["compact", "cozy", "comfortable"];

/** A setting's value. Scalars only, so a presentation stays inspectable. */
export const settingValueSchema = z.union([z.string().max(200), z.number(), z.boolean()]);
export type SettingValue = z.infer<typeof settingValueSchema>;

/**
 * Only this product's own custom properties, and only tame values.
 *
 * Tokens are rendered into CSS. Inline styles go through CSSOM and are hard to
 * escape from, but the same objects are also emitted into a `<style>` element
 * for board-level theming, and there a value carrying a semicolon or a closing
 * brace would end the declaration and start writing arbitrary rules. Guarding
 * the value here means every consumer is safe rather than the careful ones.
 */
export const tokenNameSchema = z
  .string()
  .regex(/^--dash-[a-z0-9-]+$/, "tokens must be --dash-* custom properties");

export const tokenValueSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[#a-zA-Z0-9 ,.()%/_-]+$/, "token values may not contain ; { } : or quotes");

/**
 * One named region of a component.
 *
 * `order` is a sort key rather than an index so a layer can move one slot
 * without restating every other — a partial override is the whole point.
 */
export const slotSpecSchema = z.object({
  hidden: z.boolean().optional(),
  order: z.number().int().min(-99).max(99).optional(),
  variant: z.string().min(1).max(40).optional(),
  /** Rename what this region is called. An empty string is not a rename. */
  label: z.string().min(1).max(120).optional(),
  settings: z.record(safeKeySchema, settingValueSchema).default({}),
});
export type SlotSpec = z.infer<typeof slotSpecSchema>;

export const presentationSchema = z.object({
  /** A named preset the component understands, e.g. "bare" or "card". */
  variant: z.string().min(1).max(40).optional(),
  density: densitySchema.optional(),
  slots: z.record(safeKeySchema, slotSpecSchema).default({}),
  tokens: z.record(tokenNameSchema, tokenValueSchema).default({}),
  /** Component-wide switches, e.g. `{ zebra: true, pageSize: 25 }`. */
  settings: z.record(safeKeySchema, settingValueSchema).default({}),
});

/** What a caller writes. `slots`/`tokens`/`settings` may be omitted. */
export type PresentationInput = z.input<typeof presentationSchema>;
/** What comes out of a parse — the containers are always present. */
export type Presentation = z.infer<typeof presentationSchema>;

export const EMPTY_PRESENTATION: Presentation = Object.freeze({
  slots: {},
  tokens: {},
  settings: {},
});

const mergeSlot = (base: SlotSpec, next: SlotSpec): SlotSpec => ({
  ...base,
  ...next,
  // Spreading `next` alone would drop settings the base layer set, which turns
  // a one-field override into a silent reset of everything beside it.
  settings: { ...base.settings, ...next.settings },
});

/**
 * Collapse a stack of layers into the one presentation a component renders.
 *
 * Order is lowest-priority first, so the call site reads as the precedence
 * rule it implements: `builtin -> project -> user -> dashboard -> widget`.
 * Undefined layers are skipped rather than treated as empty — "this layer said
 * nothing" and "this layer said no variant" have to stay distinguishable.
 */
export const resolvePresentation = (
  layers: readonly (Presentation | undefined | null)[],
): Presentation => {
  const slots: Record<string, SlotSpec> = {};
  const tokens: Record<string, string> = {};
  const settings: Record<string, SettingValue> = {};
  let variant: string | undefined;
  let density: Density | undefined;

  for (const layer of layers) {
    if (!layer) continue;
    if (layer.variant !== undefined) variant = layer.variant;
    if (layer.density !== undefined) density = layer.density;

    for (const [id, slot] of Object.entries(layer.slots)) {
      if (FORBIDDEN_KEYS.has(id)) continue;
      const previous = slots[id];
      slots[id] = previous ? mergeSlot(previous, slot) : slot;
    }
    for (const [name, value] of Object.entries(layer.tokens)) tokens[name] = value;
    for (const [name, value] of Object.entries(layer.settings)) {
      if (FORBIDDEN_KEYS.has(name)) continue;
      settings[name] = value;
    }
  }

  return {
    ...(variant !== undefined ? { variant } : {}),
    ...(density !== undefined ? { density } : {}),
    slots,
    tokens,
    settings,
  };
};

/* ── reading a resolved presentation ──────────────────────────────────────
 * Helpers rather than inline lookups, because every component asks the same
 * few questions and a component that forgets to check `hidden` is a slot that
 * cannot be turned off.
 */

export const slotOf = (presentation: Presentation | undefined, id: string): SlotSpec | undefined =>
  presentation?.slots[id];

export const isSlotHidden = (presentation: Presentation | undefined, id: string): boolean =>
  presentation?.slots[id]?.hidden === true;

export const slotLabel = (
  presentation: Presentation | undefined,
  id: string,
  fallback: string,
): string => presentation?.slots[id]?.label ?? fallback;

/**
 * `Address_City` → `Address · City`; `unitNumber` → `Unit number`.
 *
 * Presentation only — no vocabulary, no vendor. Field names arrive in whatever
 * casing the API uses, and a label that still reads `postalCodeExtension` in a
 * record view makes the product look like a database browser.
 *
 * It sits in the spec rather than in the component library because the
 * concierge asks its questions on the server, where React cannot go, and the
 * label it puts on an option has to be the one the widget will later show.
 */
export const humanLabel = (name: string): string => {
  // Only `.` separates levels. An underscore separates words *within* a
  // level, so `postal_code` is one label and `Address.City` is two.
  const parts = name.split(".").filter((part) => part.length > 0);

  /*
   * Past two levels, the middle is a container and the ends carry the meaning.
   *
   * `Property.Address.City` is a city, and the fact that it reached it through
   * an address object is plumbing — the reader already knows an address has a
   * city in it. Printing every level gives "Property · Address · City", which
   * is the database-browser look this function exists to avoid, and it gets
   * worse the deeper a schema goes.
   *
   * Root and leaf keeps the one thing the middle was carrying: *whose* city it
   * is. That matters, because a row holding both a property's and a unit's
   * address needs them told apart, and "City" twice would be worse than
   * either.
   */
  const spoken = parts.length > 2 ? [parts[0]!, parts[parts.length - 1]!] : parts;

  const words = spoken.map((part) =>
    part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_+/g, " ")
      .trim()
      .toLowerCase(),
  );

  // Sentence case, not Title Case — "Unit number", because "Unit Number" reads
  // as a proper noun. Only the first level is capitalised where several are
  // spoken: "Property city", not "Property · City".
  const joined = parts.length > 2 ? words.join(" ") : words.map(sentenceCase).join(" · ");
  return parts.length > 2 ? sentenceCase(joined) : joined;
};

const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Every field label in one API, keyed by the name the response carries.
 *
 * Produced once by the labelling pass and stored on the catalog entry, so it
 * says nothing about anybody's data and can be shared with the map.
 */
export type FieldLabels = Readonly<Record<string, string>>;

/**
 * What to call a field on screen.
 *
 * The one resolver, used on both sides of the wire: the concierge builds its
 * option cards on the server and a table draws its headers in the browser, and
 * a field wearing two different names in those two places is the drift that
 * moved `humanLabel` into this package in the first place.
 *
 * Falls back to `humanLabel` for a name the lexicon does not cover — an API
 * that was never mapped, an install with no AI key, or a field the pass did
 * not see. That fallback is what the whole product used before this existed,
 * so nothing degrades to worse than it was.
 */
export const fieldLabel = (name: string, labels?: FieldLabels): string => {
  const given = labels?.[name];
  return given && given.trim().length > 0 ? given : humanLabel(name);
};

/** Sort ids by their declared order, keeping the given order as the tiebreak. */
export const orderedSlots = (
  presentation: Presentation | undefined,
  ids: readonly string[],
): string[] =>
  ids
    .map((id, index) => ({ id, index, order: presentation?.slots[id]?.order ?? 0 }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.id);

export const settingBool = (
  presentation: Presentation | undefined,
  name: string,
  fallback: boolean,
): boolean => {
  const value = presentation?.settings[name];
  return typeof value === "boolean" ? value : fallback;
};

export const settingNumber = (
  presentation: Presentation | undefined,
  name: string,
  fallback: number,
): number => {
  const value = presentation?.settings[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export const settingString = (
  presentation: Presentation | undefined,
  name: string,
  fallback: string,
): string => {
  const value = presentation?.settings[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
};

/* ── the manifest ─────────────────────────────────────────────────────────
 * What a component actually offers.
 *
 * An editor cannot enumerate customisations from a presentation object — that
 * only holds the overrides someone already made. This is the list of what
 * *can* be changed, and it is the reason the editor is generic rather than a
 * hand-written form per component.
 *
 * Entries are added as each component learns to honour them. A manifest that
 * advertises a control the renderer ignores is worse than no manifest: the
 * toggle moves and nothing happens.
 */

export interface SlotDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly hideable: boolean;
  readonly orderable: boolean;
  readonly variants?: readonly string[];
}

export interface SettingDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: "boolean" | "number" | "enum";
  /** Required when `type` is "enum". */
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

export interface PresentationManifest {
  readonly component: ComponentId;
  readonly title: string;
  readonly slots: readonly SlotDef[];
  readonly settings: readonly SettingDef[];
  readonly variants: readonly string[];
  readonly supportsDensity: boolean;
}

/**
 * The shell every widget wears, customisable in its own right.
 *
 * Keyed by a pseudo-component id because the chrome is not a component in the
 * registry — but it has slots, it is overridable per widget, and an editor
 * should not need a second code path to say so.
 */
export const WIDGET_CHROME_ID = "widget";

const CHROME_MANIFEST: PresentationManifest = {
  component: WIDGET_CHROME_ID,
  title: "Widget frame",
  slots: [
    {
      id: "title",
      label: "Title",
      description: "The widget's name, in the header.",
      hideable: true,
      orderable: true,
    },
    {
      id: "subtitle",
      label: "Description",
      description: "The widget's description, on its own line under the title.",
      hideable: true,
      orderable: true,
    },
    {
      id: "badges",
      label: "Status badges",
      description: "Stale and binding-warning markers beside the title.",
      hideable: true,
      orderable: true,
    },
    {
      id: "actions",
      label: "Actions",
      description: "The menu holding refresh, inspect and remove.",
      hideable: true,
      orderable: true,
    },
    {
      id: "footer",
      label: "Footer",
      description: "Row count and how long ago the data arrived.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "border",
      label: "Border",
      description: "Draw the card outline and shadow. Off gives a flat, bare widget.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const TABLE_MANIFEST: PresentationManifest = {
  component: "table",
  title: "Table",
  slots: [
    {
      id: "header",
      label: "Column headers",
      description: "The header row.",
      hideable: true,
      orderable: false,
    },
    {
      id: "pills",
      label: "Highlight pills",
      description: "Labelled status pills rendered inside the first bound cell.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "zebra",
      label: "Striped rows",
      description: "Alternate row backgrounds. Helps at width, adds noise when narrow.",
      type: "boolean",
    },
    {
      id: "stickyFirstColumn",
      label: "Freeze first column",
      description: "Keep the leading column visible while scrolling sideways.",
      type: "boolean",
    },
    {
      id: "sortable",
      label: "Sortable columns",
      description: "Click a header to sort. Sorts what is on screen, not the whole endpoint.",
      type: "boolean",
    },
    {
      id: "searchable",
      label: "Search box",
      description: "Filter the rows already fetched by what they show.",
      type: "boolean",
    },
    {
      id: "pageSize",
      label: "Rows per page",
      description: "Zero scrolls the whole set instead of paging it.",
      type: "number",
      min: 0,
      max: 500,
    },
    {
      id: "columnPicker",
      label: "Column picker",
      description: "Let the reader hide columns for their own view.",
      type: "boolean",
    },
    {
      id: "totals",
      label: "Column totals",
      description: "Sum every numeric column in a footer row.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const METRIC_ROW_MANIFEST: PresentationManifest = {
  component: "metricRow",
  title: "Metric row",
  slots: [
    {
      id: "delta",
      label: "Change",
      description: "The arrow and percentage against the comparison value.",
      hideable: true,
      orderable: false,
    },
    {
      id: "caption",
      label: "Caption",
      description: "The note under each number.",
      hideable: true,
      orderable: false,
    },
    {
      id: "track",
      label: "Target track",
      description: "The bar showing progress toward the target.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "align",
      label: "Alignment",
      description: "Where each tile's contents sit.",
      type: "enum",
      values: ["start", "center"],
    },
    {
      id: "dividers",
      label: "Dividers",
      description: "Hairlines between the tiles.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const CARDS_MANIFEST: PresentationManifest = {
  component: "cards",
  title: "Cards",
  slots: [
    {
      id: "image",
      label: "Thumbnail",
      description: "The picture at the top of each card.",
      hideable: true,
      orderable: false,
    },
    {
      id: "subtitle",
      label: "Subtitle",
      description: "The line under each heading.",
      hideable: true,
      orderable: false,
    },
    {
      id: "meta",
      label: "Facts",
      description: "The label-and-value pairs along the bottom.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "minWidth",
      label: "Minimum card width",
      description: "Cards per row follow from this and the widget's width.",
      type: "number",
      min: 120,
      max: 480,
    },
  ],
  variants: [],
  supportsDensity: true,
};

const RECORD_MANIFEST: PresentationManifest = {
  component: "record",
  title: "Record",
  slots: [
    {
      id: "heading",
      label: "Heading",
      description: "The record's title, above the fields.",
      hideable: true,
      orderable: true,
    },
    {
      id: "marks",
      label: "Status marks",
      description: "Highlight pills for the record as a whole.",
      hideable: true,
      orderable: true,
    },
  ],
  settings: [
    {
      id: "hideEmpty",
      label: "Hide empty fields",
      description: "Leave out fields with no value rather than showing a blank row.",
      type: "boolean",
    },
    {
      id: "columns",
      label: "Field columns",
      description: "How many columns the label-and-value pairs run in.",
      type: "number",
      min: 1,
      max: 3,
    },
  ],
  variants: [],
  supportsDensity: true,
};

const RECORD_HEADER_MANIFEST: PresentationManifest = {
  component: "recordHeader",
  title: "Record header",
  slots: [
    {
      id: "subtitle",
      label: "Subtitle",
      description: "The line under the record's name.",
      hideable: true,
      orderable: false,
    },
    {
      id: "facts",
      label: "Key facts",
      description: "The strip of leading fields under the name.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [],
  variants: [],
  supportsDensity: true,
};

const LIST_MANIFEST: PresentationManifest = {
  component: "list",
  title: "List",
  slots: [
    {
      id: "subtitle",
      label: "Subtitle",
      description: "The secondary line under each item.",
      hideable: true,
      orderable: false,
    },
    {
      id: "meta",
      label: "Meta",
      description: "The trailing value on each row.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [],
  variants: [],
  supportsDensity: true,
};

const BOARD_MANIFEST: PresentationManifest = {
  component: "board",
  title: "Board",
  slots: [
    {
      id: "subtitle",
      label: "Subtitle",
      description: "The line under each card heading.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "columnWidth",
      label: "Column width",
      description: "How wide each status column is before the board scrolls sideways.",
      type: "number",
      min: 140,
      max: 400,
    },
    {
      id: "counts",
      label: "Column counts",
      description: "Show how many records are in each column.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const FEED_MANIFEST: PresentationManifest = {
  component: "feed",
  title: "Activity feed",
  slots: [
    {
      id: "subtitle",
      label: "Subtitle",
      description: "The detail line under each entry.",
      hideable: true,
      orderable: false,
    },
  ],
  settings: [
    {
      id: "groupByDay",
      label: "Group by day",
      description: "Put a date heading above each day's entries.",
      type: "boolean",
    },
    {
      id: "avatars",
      label: "Avatars",
      description: "Show initials beside each entry when an actor is bound.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const PROGRESS_MANIFEST: PresentationManifest = {
  component: "progress",
  title: "Progress bars",
  slots: [],
  settings: [
    {
      id: "showValue",
      label: "Show the number",
      description: "Print the value at the end of each bar, not just the bar.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const FUNNEL_MANIFEST: PresentationManifest = {
  component: "funnel",
  title: "Funnel",
  slots: [],
  settings: [
    {
      id: "showDropOff",
      label: "Show the drop",
      description: "Print how many were lost between each stage.",
      type: "boolean",
    },
  ],
  variants: [],
  supportsDensity: true,
};

const MANIFESTS: readonly PresentationManifest[] = [
  BOARD_MANIFEST,
  FEED_MANIFEST,
  PROGRESS_MANIFEST,
  FUNNEL_MANIFEST,
  CHROME_MANIFEST,
  TABLE_MANIFEST,
  METRIC_ROW_MANIFEST,
  CARDS_MANIFEST,
  RECORD_MANIFEST,
  RECORD_HEADER_MANIFEST,
  LIST_MANIFEST,
];

export const PRESENTATION_MANIFESTS: Readonly<Record<string, PresentationManifest>> =
  Object.fromEntries(MANIFESTS.map((manifest) => [manifest.component, manifest]));

/** Undefined for a component that offers nothing customisable yet. */
export const manifestFor = (id: ComponentId): PresentationManifest | undefined =>
  PRESENTATION_MANIFESTS[id];

/**
 * What ships.
 *
 * Published as parts so a deployment can change the shipped default without
 * editing the product, and so "customised" is answerable by comparing against
 * a real record rather than against a value buried in a renderer.
 */
export const PRESENTATION_DEFAULTS: Readonly<
  Record<BuiltinComponentId | typeof WIDGET_CHROME_ID, Presentation>
> = {
  widget: { density: "cozy", slots: {}, tokens: {}, settings: { border: true } },
  table: {
    density: "cozy",
    slots: {},
    tokens: {},
    settings: {
      zebra: false,
      stickyFirstColumn: false,
      sortable: true,
      searchable: false,
      // Zero means scroll rather than page. A table on a dashboard is usually
      // a top-N that already fits, and a pager under twelve rows is furniture.
      pageSize: 0,
      columnPicker: false,
      totals: false,
    },
  },
  metricRow: {
    density: "cozy",
    slots: {},
    tokens: {},
    settings: { align: "start", dividers: true },
  },
  cards: {
    density: "cozy",
    slots: {},
    tokens: {},
    settings: { minWidth: 200 },
  },
  board: { density: "cozy", slots: {}, tokens: {}, settings: { columnWidth: 210, counts: true } },
  timeline: { density: "cozy", slots: {}, tokens: {}, settings: {} },
  feed: { density: "cozy", slots: {}, tokens: {}, settings: { groupByDay: true, avatars: true } },
  progress: { density: "cozy", slots: {}, tokens: {}, settings: { showValue: true } },
  funnel: { density: "cozy", slots: {}, tokens: {}, settings: { showDropOff: true } },
  calendar: { density: "cozy", slots: {}, tokens: {}, settings: {} },
  record: {
    density: "cozy",
    slots: {},
    tokens: {},
    settings: { hideEmpty: false, columns: 1 },
  },
  recordHeader: { density: "cozy", slots: {}, tokens: {}, settings: {} },
  list: { density: "cozy", slots: {}, tokens: {}, settings: {} },
  stat: { slots: {}, tokens: {}, settings: {} },
  timeseries: { slots: {}, tokens: {}, settings: {} },
  bar: { slots: {}, tokens: {}, settings: {} },
  distribution: { slots: {}, tokens: {}, settings: {} },
  statusGrid: { slots: {}, tokens: {}, settings: {} },
  gauge: { slots: {}, tokens: {}, settings: {} },
};

export const defaultPresentationFor = (id: string): Presentation =>
  (PRESENTATION_DEFAULTS as Readonly<Record<string, Presentation>>)[id] ?? EMPTY_PRESENTATION;
