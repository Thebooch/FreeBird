import { z } from "zod";
import type { SemanticType, ValueType } from "./semantics.js";
import { valueTypeSchema } from "./semantics.js";

/**
 * Components are defined by the data contract they require, not by what they
 * look like. Once a component declares its roles with types and cardinality
 * bounds, validating a binding — including one an LLM proposed — becomes
 * mechanical rather than a matter of a human eyeballing a chart.
 *
 * These contracts are pure data and live here rather than in
 * `@freebirdai/dash-components` so the runtime, the server and the authoring agent can
 * all reason about them without pulling in React.
 */
/**
 * A component id is an open name, not a closed list.
 *
 * It was an enum, which made the eight shipped components the only ones that
 * could ever exist — a spec naming a custom renderer would not parse, so no
 * amount of registry work downstream could have made one usable. Validation is
 * now shape-only; whether a name resolves to something renderable is a
 * question for the registry, and an unknown one produces a clear binding error
 * rather than a parse failure a user cannot act on.
 */
export const componentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "component ids must start with a letter and be [a-zA-Z0-9_-]");

export type ComponentId = string;

/** The ids that ship with the product. */
export type BuiltinComponentId =
  | "stat"
  | "metricRow"
  | "timeseries"
  | "bar"
  | "table"
  | "cards"
  | "board"
  | "timeline"
  | "feed"
  | "progress"
  | "funnel"
  | "calendar"
  | "list"
  | "record"
  | "recordHeader"
  | "distribution"
  | "statusGrid"
  | "gauge";

/** Ported from @freebirdai/core's grid hints so layouts stay interchangeable. */
export const sizeVariantSchema = z.object({
  name: z.string().min(1),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  aspect: z.enum(["wide", "tall", "square", "auto"]).optional(),
});

export type SizeVariant = z.infer<typeof sizeVariantSchema>;

export const gridHintsSchema = z.object({
  sizes: z.array(sizeVariantSchema).min(1),
  preferredSize: z.string().min(1).optional(),
  minSize: z.string().min(1).optional(),
});

export type GridHints = z.infer<typeof gridHintsSchema>;

export const roleContractSchema = z.object({
  role: z.string().min(1),
  accepts: z.array(valueTypeSchema).min(1),
  required: z.boolean(),
  /**
   * The layman line under the question, with an example.
   *
   * Read by a person choosing a field, so it says what the slot is *for* in
   * their vocabulary rather than in the component's. "The primary line" is a
   * true description of where the value lands and no help at all to somebody
   * deciding between `Address` and `UnitCount` — "what each row is known by,
   * like a property's address" is.
   */
  description: z.string().min(1),
  /**
   * The question as a person is asked it.
   *
   * Absent, the question is generated from the slot's own name, which is how
   * we came to ask "Which field should be the title?" — colliding with the
   * widget's own name — and "Which field should be the columns?", which is not
   * even grammatical. The slot names are ours; the question is theirs.
   */
  prompt: z.string().min(1).optional(),
  /** Bound on distinct values — a 400-series line chart is unreadable. */
  maxCardinality: z.number().int().min(1).optional(),
  /** This role takes a list of columns rather than one (table columns). */
  multi: z.boolean().optional(),
});

export type RoleContract = z.infer<typeof roleContractSchema>;

/**
 * What a widget of this kind needs decided beyond its roles.
 *
 * Roles say what a component must be *given*; this says what it can be *set
 * up with*. The distinction earns its keep because the answer differs sharply
 * by component and nothing else knows it: a table of records wants to know
 * what clicking a row opens and which related collections come with it, and a
 * comparison of two counts over time wants none of that — there is no row to
 * click and no record behind a data point.
 *
 * Declared on the component rather than worked out per API, because it is a
 * fact about the component. A table is a table on every API there has ever
 * been, and asking a model to rediscover that for each connection would be
 * paying repeatedly for an answer that never changes.
 */
export interface DetailContract {
  /**
   * Whether clicking a row opens the record behind it.
   *
   * False for anything whose marks are aggregates. A point on a monthly count
   * is not a record and has no detail to open — offering one would promise a
   * view that cannot exist.
   */
  readonly opensRecord: boolean;
  /**
   * Whether that record can carry related collections beside its own fields —
   * a task's notes, a property's units. Only meaningful with `opensRecord`.
   */
  readonly childSections: boolean;
  /**
   * Row-level controls this component could offer.
   *
   * Empty everywhere today and deliberately so: nothing here writes, and the
   * slot exists to keep the shape honest rather than to be filled in quietly.
   * When editing does arrive it belongs here, per component, next to the rest
   * of what a widget of this kind can do.
   */
  readonly actions: readonly string[];
}

export interface ComponentContract {
  readonly id: ComponentId;
  readonly title: string;
  readonly description: string;
  readonly roles: readonly RoleContract[];
  readonly grid: GridHints;
  /** Absent means the same as all-false: no rows, nothing to open. */
  readonly detail?: DetailContract;
}

/** A component whose marks are records: clicking one opens the thing itself. */
const RECORDS: DetailContract = { opensRecord: true, childSections: true, actions: [] };

/** A component whose marks are aggregates: there is no record behind them. */
const AGGREGATES: DetailContract = { opensRecord: false, childSections: false, actions: [] };

const NUMERIC: ValueType[] = ["numeric"];
const TEMPORAL: ValueType[] = ["temporal", "numeric"];
const CATEGORICAL: ValueType[] = ["categorical", "text", "boolean"];
const ANY: ValueType[] = ["numeric", "temporal", "categorical", "text", "boolean", "unknown"];

export const COMPONENT_CONTRACTS: Readonly<Record<BuiltinComponentId, ComponentContract>> = {
  stat: {
    id: "stat",
    title: "Stat",
    description: "A single headline number, optionally with a comparison and a sparkline.",
    roles: [
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "compare",
        accepts: NUMERIC,
        required: false,
        description: "Shown as a rise or fall beside the current one.",
        prompt: "Which field holds the earlier number to compare against?",
      },
      {
        role: "series",
        accepts: NUMERIC,
        required: false,
        description: "One line or group per distinct value — leave it out for a single line.",
        prompt: "Which field should split this into separate lines?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "sm", w: 3, h: 3, aspect: "square" },
        { name: "md", w: 4, h: 3, aspect: "wide" },
        { name: "lg", w: 6, h: 4, aspect: "wide" },
      ],
      preferredSize: "sm",
      minSize: "sm",
    },
  },
  metricRow: {
    id: "metricRow",
    title: "Metric row",
    description:
      "A row of headline numbers, one per record. The strip most dashboards open with.",
    roles: [
      {
        role: "label",
        accepts: CATEGORICAL,
        required: true,
        description: "The text shown beside each value.",
        prompt: "Which field names each one?",
        maxCardinality: 8,
      },
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "compare",
        accepts: NUMERIC,
        required: false,
        description: "Shown as a rise or fall beside the current one.",
        prompt: "Which field holds the earlier number to compare against?",
      },
      {
        role: "target",
        accepts: NUMERIC,
        required: false,
        description: "Drawn as a marker, so progress toward it is visible.",
        prompt: "Which field holds the number being aimed at?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
      {
        role: "caption",
        accepts: ANY,
        required: false,
        description: "A short line of context under the number.",
        prompt: "Which field holds a note to show underneath?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      // A strip, never a block: the whole point is a row of numbers across the
      // top, so even the small variant spans half the grid.
      sizes: [
        { name: "md", w: 6, h: 3, aspect: "wide" },
        { name: "lg", w: 12, h: 3, aspect: "wide" },
        { name: "full", w: 12, h: 4, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  timeseries: {
    id: "timeseries",
    title: "Time series",
    description: "A value over time, optionally split into a few named series.",
    roles: [
      {
        role: "time",
        accepts: TEMPORAL,
        required: true,
        description: "When each record happened. Entries are grouped by day.",
        prompt: "Which field holds the date to order by?",
      },
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "series",
        accepts: CATEGORICAL,
        required: false,
        description: "One line or group per distinct value — leave it out for a single line.",
        prompt: "Which field should split this into separate lines?",
        maxCardinality: 12,
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 5, aspect: "wide" },
        { name: "lg", w: 8, h: 6, aspect: "wide" },
        { name: "full", w: 12, h: 6, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  bar: {
    id: "bar",
    title: "Bar chart",
    description: "A value compared across categories.",
    roles: [
      {
        role: "category",
        accepts: CATEGORICAL,
        required: true,
        description: "One bar or slice per distinct value — a status, a type, an owner.",
        prompt: "Which field should the records be grouped by?",
        maxCardinality: 40,
      },
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "series",
        accepts: CATEGORICAL,
        required: false,
        description: "One line or group per distinct value — leave it out for a single line.",
        prompt: "Which field should split this into separate lines?",
        maxCardinality: 8,
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 5, aspect: "wide" },
        { name: "lg", w: 8, h: 6, aspect: "wide" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  table: {
    id: "table",
    title: "Table",
    description: "Rows and columns, formatted by semantic type.",
    roles: [
      {
        role: "columns",
        accepts: ANY,
        required: true,
        description: "One column each, in the order you pick them.",
        prompt: "Which fields should the table show?",
        multi: true,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 6, aspect: "auto" },
        { name: "lg", w: 8, h: 7, aspect: "wide" },
        { name: "full", w: 12, h: 8, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  /*
   * One thing, rather than many.
   *
   * Every other component answers a question about a set of records. This one
   * answers "what is this?" about a single record, which is what a drill-down
   * actually opens. A one-row table was the only option before, and it reads
   * as a table with a missing body: the labels run along the top, the values
   * run off the right, and a nested object has nowhere to go.
   *
   * Deliberately has no `status` role. Highlights are the mechanism for "this
   * needs attention", and two ways to say the same thing is how the two drift.
   */
  record: {
    id: "record",
    title: "Record",
    description: "One thing's fields, as label and value pairs.",
    roles: [
      {
        role: "fields",
        accepts: ANY,
        required: true,
        description: "Listed in the order you pick them.",
        prompt: "Which fields should the record show?",
        multi: true,
      },
      {
        role: "title",
        accepts: ANY,
        required: false,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 6, aspect: "tall" },
        { name: "lg", w: 6, h: 7, aspect: "tall" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  cards: {
    id: "cards",
    title: "Cards",
    description: "A card per record, for browsing entities rather than reading a grid.",
    roles: [
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "meta",
        accepts: ANY,
        required: false,
        multi: true,
        description: "A small trailing detail — a date, an amount, a count.",
        prompt: "Which field goes on the right?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
      {
        role: "image",
        accepts: ["text"],
        required: false,
        description: "An https link to a picture, used as the thumbnail.",
        prompt: "Which field holds an image address?",
      },
      {
        role: "href",
        accepts: ["text"],
        required: false,
        description: "Makes each record clickable through to wherever that link goes.",
        prompt: "Which field holds a link?",
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 6, aspect: "auto" },
        { name: "lg", w: 8, h: 7, aspect: "auto" },
        { name: "full", w: 12, h: 8, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  board: {
    id: "board",
    title: "Board",
    description:
      "Records in columns, grouped by a status. Read-only: this product only ever reads an API, so a card cannot be dragged to change what it says.",
    roles: [
      {
        role: "group",
        accepts: CATEGORICAL,
        required: true,
        description: "One column per distinct value — usually a status or a stage.",
        prompt: "Which field decides the column each record sits in?",
        maxCardinality: 8,
      },
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "meta",
        accepts: ANY,
        required: false,
        description: "A small trailing detail — a date, an amount, a count.",
        prompt: "Which field goes on the right?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 8, h: 7, aspect: "wide" },
        { name: "lg", w: 12, h: 8, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  timeline: {
    id: "timeline",
    title: "Timeline",
    description: "Events down a rail, in the order they happened.",
    roles: [
      {
        role: "time",
        accepts: TEMPORAL,
        required: true,
        description: "When each record happened. Entries are grouped by day.",
        prompt: "Which field holds the date to order by?",
      },
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 6, aspect: "tall" },
        { name: "lg", w: 6, h: 8, aspect: "tall" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  feed: {
    id: "feed",
    title: "Activity feed",
    description: "What happened lately, grouped by day.",
    roles: [
      {
        role: "time",
        accepts: TEMPORAL,
        required: true,
        description: "When each record happened. Entries are grouped by day.",
        prompt: "Which field holds the date to order by?",
      },
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "actor",
        accepts: ANY,
        required: false,
        description: "The person or account behind each entry.",
        prompt: "Which field says who did it?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "meta",
        accepts: ANY,
        required: false,
        description: "A small trailing detail — a date, an amount, a count.",
        prompt: "Which field goes on the right?",
      },
      {
        role: "href",
        accepts: ["text"],
        required: false,
        description: "Makes each record clickable through to wherever that link goes.",
        prompt: "Which field holds a link?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 7, aspect: "tall" },
        { name: "lg", w: 6, h: 8, aspect: "tall" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  progress: {
    id: "progress",
    title: "Progress bars",
    description: "How far along each thing is, as a row of meters.",
    roles: [
      {
        role: "label",
        accepts: CATEGORICAL,
        required: true,
        description: "The text shown beside each value.",
        prompt: "Which field names each one?",
        maxCardinality: 20,
      },
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "max",
        accepts: NUMERIC,
        required: false,
        description: "What counts as complete. Without it, the largest record sets the scale.",
        prompt: "Which field holds the full amount?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 5, aspect: "auto" },
        { name: "lg", w: 6, h: 6, aspect: "auto" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  funnel: {
    id: "funnel",
    title: "Funnel",
    description: "Stages narrowing toward an outcome, with the drop between each.",
    roles: [
      {
        role: "stage",
        accepts: CATEGORICAL,
        required: true,
        description: "Read in the order the records come back in.",
        prompt: "Which field names each stage?",
        maxCardinality: 12,
      },
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 6, aspect: "tall" },
        { name: "lg", w: 6, h: 7, aspect: "tall" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  calendar: {
    id: "calendar",
    title: "Calendar",
    description: "A month, with each record on the day it falls.",
    roles: [
      {
        role: "start",
        accepts: TEMPORAL,
        required: true,
        description: "The day each record lands on.",
        prompt: "Which field holds the start date?",
      },
      {
        role: "end",
        accepts: TEMPORAL,
        required: false,
        description: "For anything spanning more than a day. Leave it out for single days.",
        prompt: "Which field holds the end date?",
      },
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 8, aspect: "auto" },
        { name: "lg", w: 8, h: 9, aspect: "auto" },
        { name: "full", w: 12, h: 10, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  list: {
    id: "list",
    title: "List",
    description: "An activity feed or list of records.",
    roles: [
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "meta",
        accepts: ANY,
        required: false,
        description: "A small trailing detail — a date, an amount, a count.",
        prompt: "Which field goes on the right?",
      },
      {
        role: "href",
        accepts: ["text"],
        required: false,
        description: "Makes each record clickable through to wherever that link goes.",
        prompt: "Which field holds a link?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
    ],
    detail: RECORDS,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 6, aspect: "tall" },
        { name: "lg", w: 6, h: 7, aspect: "tall" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  recordHeader: {
    id: "recordHeader",
    title: "Record header",
    description: "The identity block at the top of a record: who it is, and the facts worth leading with.",
    roles: [
      {
        role: "title",
        accepts: ANY,
        required: true,
        description: "What each one is known by — a property's address, a task's name. It is the line people read first.",
        prompt: "Which field names each record?",
      },
      {
        role: "subtitle",
        accepts: ANY,
        required: false,
        description: "A supporting detail under the name, like a status or an owner.",
        prompt: "Which field goes on the second line?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: false,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
      {
        role: "facts",
        accepts: ANY,
        required: false,
        multi: true,
        description: "Shown at the top, before the rest of the record.",
        prompt: "Which two or three fields matter most?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 3, aspect: "wide" },
        { name: "lg", w: 12, h: 3, aspect: "wide" },
      ],
      preferredSize: "lg",
      minSize: "md",
    },
  },
  distribution: {
    id: "distribution",
    title: "Distribution",
    description: "How often values fall into each bucket.",
    roles: [
      {
        role: "bucket",
        accepts: ANY,
        required: true,
        description: "The label or lower bound of each group.",
        prompt: "Which field names each band?",
        maxCardinality: 60,
      },
      {
        role: "count",
        accepts: NUMERIC,
        required: true,
        description: "The height of each bar.",
        prompt: "Which field holds how many fell in each band?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 6, h: 5, aspect: "wide" },
        { name: "lg", w: 8, h: 5, aspect: "wide" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  statusGrid: {
    id: "statusGrid",
    title: "Status grid",
    description: "A tile per thing, coloured by state.",
    roles: [
      {
        role: "label",
        accepts: ANY,
        required: true,
        description: "The text shown beside each value.",
        prompt: "Which field names each one?",
      },
      {
        role: "status",
        accepts: CATEGORICAL,
        required: true,
        description: "Shown as a coloured pill, so states stand out without reading.",
        prompt: "Which field says what state each record is in?",
        maxCardinality: 12,
      },
      {
        role: "meta",
        accepts: ANY,
        required: false,
        description: "A small trailing detail — a date, an amount, a count.",
        prompt: "Which field goes on the right?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "md", w: 4, h: 4, aspect: "auto" },
        { name: "lg", w: 6, h: 5, aspect: "wide" },
      ],
      preferredSize: "md",
      minSize: "md",
    },
  },
  gauge: {
    id: "gauge",
    title: "Gauge",
    description: "Progress toward a target.",
    roles: [
      {
        role: "value",
        accepts: NUMERIC,
        required: true,
        description: "The amount each record contributes to the total.",
        prompt: "Which field holds the number being measured?",
      },
      {
        role: "max",
        accepts: NUMERIC,
        required: false,
        description: "What counts as complete. Without it, the largest record sets the scale.",
        prompt: "Which field holds the full amount?",
      },
      {
        role: "target",
        accepts: NUMERIC,
        required: false,
        description: "Drawn as a marker, so progress toward it is visible.",
        prompt: "Which field holds the number being aimed at?",
      },
    ],
    detail: AGGREGATES,
    grid: {
      sizes: [
        { name: "sm", w: 3, h: 3, aspect: "square" },
        { name: "md", w: 4, h: 4, aspect: "square" },
      ],
      preferredSize: "sm",
      minSize: "sm",
    },
  },
};

export const COMPONENT_IDS = Object.keys(COMPONENT_CONTRACTS) as BuiltinComponentId[];

/**
 * The contract for a component id, or undefined when nothing ships one.
 *
 * Callers must handle undefined: with open ids, a widget can legitimately
 * name a component supplied by a part rather than by this table.
 */
export const contractFor = (id: string): ComponentContract | undefined =>
  (COMPONENT_CONTRACTS as Readonly<Record<string, ComponentContract>>)[id];

/** What the runtime reports about each column it produced. */
export interface ColumnMeta {
  readonly name: string;
  /**
   * What to call this column on screen, when something knows better than the
   * name does.
   *
   * Stamped on by the host from the connection's label lexicon; absent when
   * the API was never mapped, which every renderer handles by falling back to
   * `humanLabel`. Deliberately carried on the column rather than looked up per
   * component: the runtime hands every component the same `columns`, so this
   * reaches all of them without any of them learning what a connection is.
   */
  readonly label?: string;
  readonly valueType: ValueType;
  readonly semantic?: SemanticType;
  /** How many rows had null/undefined here — surfaced in the inspector. */
  readonly nullCount?: number;
  readonly distinctCount?: number;
}

export interface BindingIssue {
  readonly role: string;
  readonly message: string;
}

export interface BindingValidation {
  readonly ok: boolean;
  readonly errors: readonly BindingIssue[];
  readonly warnings: readonly BindingIssue[];
}

/**
 * Check a role→column binding against a component's contract.
 *
 * Errors mean the widget cannot render. Warnings mean it will render but
 * probably badly — too many series, a numeric column bound to a label — and
 * are shown to the user rather than silently swallowed.
 */
export const validateBinding = (
  contract: ComponentContract,
  roles: Readonly<Record<string, string | readonly string[]>>,
  columns: readonly ColumnMeta[],
): BindingValidation => {
  const errors: BindingIssue[] = [];
  const warnings: BindingIssue[] = [];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const known = new Set(contract.roles.map((role) => role.role));

  for (const role of Object.keys(roles)) {
    if (!known.has(role)) {
      errors.push({
        role,
        message: `"${contract.id}" has no role "${role}" (expected: ${[...known].join(", ")})`,
      });
    }
  }

  for (const contractRole of contract.roles) {
    const bound = roles[contractRole.role];

    if (bound === undefined || (Array.isArray(bound) && bound.length === 0)) {
      if (contractRole.required) {
        errors.push({
          role: contractRole.role,
          message: `"${contractRole.role}" is required — ${contractRole.description}`,
        });
      }
      continue;
    }

    const names = Array.isArray(bound) ? [...bound] : [bound as string];

    if (!contractRole.multi && names.length > 1) {
      errors.push({
        role: contractRole.role,
        message: `"${contractRole.role}" takes a single column, got ${names.length}`,
      });
      continue;
    }

    for (const name of names) {
      const column = byName.get(name);
      if (!column) {
        errors.push({
          role: contractRole.role,
          message: `"${contractRole.role}" points at "${name}", which the pipeline does not produce`,
        });
        continue;
      }

      if (column.valueType !== "unknown" && !contractRole.accepts.includes(column.valueType)) {
        errors.push({
          role: contractRole.role,
          message: `"${contractRole.role}" needs ${contractRole.accepts.join(" or ")}, but "${name}" is ${column.valueType}`,
        });
        continue;
      }

      if (
        contractRole.maxCardinality !== undefined &&
        column.distinctCount !== undefined &&
        column.distinctCount > contractRole.maxCardinality
      ) {
        warnings.push({
          role: contractRole.role,
          message: `"${name}" has ${column.distinctCount} distinct values; "${contractRole.role}" reads well up to ${contractRole.maxCardinality}`,
        });
      }

      if (column.nullCount !== undefined && column.nullCount > 0) {
        warnings.push({
          role: contractRole.role,
          message: `"${name}" is empty in ${column.nullCount} row(s)`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
};
