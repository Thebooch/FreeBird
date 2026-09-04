import { z } from "zod";
import { componentIdSchema, contractFor } from "./contracts.js";
import { dashboardParamsSchema } from "./params.js";
import { highlightSchema, pipelineSchema } from "./pipeline.js";
import { presentationSchema } from "./presentation.js";
import { formatSchema } from "./semantics.js";

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]");

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const parseDuration = (source: string): number | null => {
  const match = DURATION_RE.exec(source.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  return Number(amount) * DURATION_UNIT_MS[unit as keyof typeof DURATION_UNIT_MS];
};

const durationSchema = z
  .string()
  .refine((value) => parseDuration(value) !== null, 'expected a duration like "30s", "5m", "1h"');

export const refreshSchema = z.object({
  /** How often to re-fetch while the dashboard is open. Omit for manual only. */
  every: durationSchema.optional(),
  /** After this long the widget shows a "stale" badge instead of pretending. */
  staleAfter: durationSchema.default("15m"),
});

export const widgetStatesSchema = z.object({
  empty: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});

export const widgetSourceSchema = z.object({
  connection: idSchema,
  op: idSchema,
  /** Merged over the op's own query. Values may carry `{{…}}` params. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/**
 * One endpoint inside a multi-source widget.
 *
 * `as` names the result so `combine` can refer to it, and so joined columns
 * can be traced back to where they came from.
 */
export const namedSourceSchema = widgetSourceSchema.extend({
  as: idSchema,
  /**
   * What to call this source's rows where a person will read the name.
   *
   * `as` is an identifier — it prefixes columns and keys the plan — so it is
   * the op id, which is not a thing to show anybody. A union writes one of
   * these into every row it contributes, and "Retrieve all listings" belongs
   * in a chart legend where `externalapilistings_getlistingsasync` does not.
   */
  label: z.string().min(1).max(80).optional(),
  /** Shaping applied to this endpoint alone, before any join. */
  pipeline: pipelineSchema.default([]),
  /**
   * Call this endpoint once per row of another source.
   *
   * The last resort, for APIs that cannot filter by the foreign key. It is one
   * request per row, so it is capped and the cap is reported rather than
   * quietly truncating — an incomplete answer that looks complete is the worst
   * outcome this product can produce.
   */
  fanOut: z
    .object({
      /** The source whose rows drive the calls. */
      from: idSchema,
      /** Field on those rows supplying this endpoint's input. */
      field: z.string().min(1).max(120),
      /** Which input it feeds. Defaults to `field`. */
      as: z.string().min(1).max(120).optional(),
      maxRows: z.number().int().min(1).max(100).default(25),
    })
    .optional(),
  /**
   * Fetched to drive a fan-out, and not part of the result.
   *
   * A nested collection can only be reached through its parent's ids, so
   * measuring one across a whole account needs the parent fetched too — and
   * the parent is not one of the things being measured. Counting applications
   * per month needs the applicants they hang off; nobody asked to see a line
   * for applicants.
   *
   * Without this the union stacks every source it is given, so the driver
   * appeared in the chart as a third series that nobody asked for and that
   * measures something else entirely. It is still fetched, still counted in
   * the request budget, and still reported — just not drawn.
   */
  hidden: z.boolean().default(false),
});

/**
 * How two sources become one dataset.
 *
 * Right-hand columns are always prefixed with the right source's name —
 * `orders_Id`, never a bare `Id` that may or may not have been overwritten.
 * One unconditional rule beats a collision-dependent one, because a shape that
 * changes based on whether names happened to clash is impossible to write a
 * pipeline against with confidence.
 */
export const combineSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("join"),
    left: idSchema,
    right: idSchema,
    on: z.object({ left: z.string().min(1), right: z.string().min(1) }),
    kind: z.enum(["inner", "left"]).default("left"),
  }),
  /**
   * Every source's rows, one after another, tagged with where each came from.
   *
   * A join answers "what else is true of this row". This answers a different
   * question — "how do these two compare" — and a join cannot: asked for the
   * number of listings per month against the number of applications per month,
   * a row-level join has nothing to match on, because neither set of rows is
   * an attribute of the other. They are two measurements sharing an axis.
   *
   * The components want that in long form: one row per bucket per series, with
   * a column naming the series. So each source shapes itself down to the same
   * columns — a bucket and a number — and this stacks them and writes the
   * label in. Requires nothing of the two schemas beyond the pipelines already
   * having made them agree, which is the source's own business.
   */
  z.object({
    op: z.literal("union"),
    /** Column written into every row, holding the source's label. */
    as: z.string().min(1).max(120).default("series"),
  }),
]);

export const widgetSchema = z
  .object({
  id: idSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  component: componentIdSchema,
  /** The single-endpoint form. Mutually exclusive with `sources`. */
  source: widgetSourceSchema.optional(),
  pipeline: pipelineSchema.default([]),
  /** role → column name, or a list of column names for multi roles. */
  roles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  format: z.record(z.string(), formatSchema).default({}),
  refresh: refreshSchema.default({ staleAfter: "15m" }),
  states: widgetStatesSchema.default({}),
  /** Hash of the response schema this binding was built against. */
  schemaHash: z.string().optional(),
  /**
   * Which model produced this binding, and when.
   *
   * Recorded because the models are no longer one: each AI action routes to
   * its own, so two widgets on the same board can have been designed by
   * different models, and "why did this one bind the wrong field" is not
   * answerable without knowing which. Written once, when the widget is built,
   * and never on an edit — a person changing a column has not made the model
   * responsible for their choice.
   *
   * Optional, so every widget written before this still parses. Descriptive
   * rather than load-bearing: nothing reads it to decide anything.
   */
  producedBy: z
    .object({
      model: z.string().min(1).max(120),
      /** ISO 8601. */
      at: z.string().min(1).max(40),
    })
    .optional(),
  /**
   * Ambiguities a human resolved, e.g. "amount:cents". Recorded so the agent
   * never re-guesses something that has already been answered.
   */
  confirmed: z.array(z.string()).default([]),
  /**
   * Rows worth a second look, and why.
   *
   * Evaluated after the pipeline against the finished rows, so a predicate
   * names the columns actually rendered — including any a `rename` produced —
   * and the rule that a pipeline extracts exactly once, at index 0, is
   * untouched by it.
   */
  highlights: z.array(highlightSchema).max(8).default([]),
  /**
   * Two or more endpoints combined into one dataset.
   *
   * Present instead of `source`, never alongside it. Each entry is fetched
   * and shaped independently, `combine` joins them, and the widget's own
   * `pipeline` then runs over the joined rows — so the existing rule that a
   * pipeline extracts exactly once, at index 0, still holds inside each one.
   */
  sources: z.array(namedSourceSchema).max(4).default([]),
  combine: combineSchema.optional(),
  /**
   * How this one widget looks, overriding every wider layer.
   *
   * Presentation is deliberately separate from `roles` and `format`: those say
   * what the data *is*, this says how it is shown. A widget that changes its
   * density has not changed what it is bound to, so nothing needs revalidating
   * and no binding warning can be produced by editing it.
   */
  presentation: presentationSchema.optional(),
  /**
   * What clicking a row opens.
   *
   * The detail view is itself a widget, executed through the same compile →
   * run → validate path with `params.row` populated — so the pipeline,
   * formatting and inspector all work unchanged rather than being duplicated
   * for a second rendering surface.
   */
  drilldown: z
    .object({
      /** The by-id endpoint, on the same connection as `source`. */
      op: idSchema,
      /** Path/query inputs for that op, e.g. `{ leaseId: "{{row.Id}}" }`. */
      params: z.record(z.string(), z.string()).default({}),
      // A record view, not a one-row table. The thing being opened is one
      // thing, and a table of it puts the values off the right-hand edge.
      component: componentIdSchema.default("record"),
      title: z.string().max(120).optional(),
      /** Pipeline for the detail response. Usually just an extract. */
      pipeline: pipelineSchema.default([]),
      roles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
      highlights: z.array(highlightSchema).max(8).default([]),
      /**
       * Where the record opens.
       *
       * A sheet is right for a look: it keeps the board behind it and closes
       * with Escape. A page is right for work: it has room for tabs, long
       * field lists and a header, and it has a URL somebody can send to a
       * colleague. Most records want both, so that is the default — the sheet
       * on a row click, with a control to go wide.
       */
      layout: z.enum(["sheet", "page", "both"]).default("both"),
      /**
       * The identity block at the top of the record.
       *
       * Without this a record view opens on a wall of label-and-value pairs
       * with nothing saying what you are looking at. `facts` are the two or
       * three fields worth reading before the rest.
       */
      header: z
        .object({
          title: z.string().max(120).optional(),
          subtitle: z.string().max(120).optional(),
          status: z.string().max(120).optional(),
          facts: z.array(z.string().max(120)).max(4).default([]),
        })
        .optional(),
      /**
       * Field sections.
       *
       * Anything not named by a group falls into an unnamed section at the
       * end, so adding a group never hides a field — the failure mode would
       * be silent and the data would look like it had gone missing.
       */
      groups: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            fields: z.array(z.string().min(1).max(120)).min(1),
          }),
        )
        .max(8)
        .default([]),
      /**
       * Collections belonging to the record, shown underneath it.
       *
       * This is where the value usually is. A parent record is often little
       * more than an identifier and a name; the interesting fields — price,
       * size, status — live in the collections the parent's id keys. Each
       * section is an ordinary widget fed by `{{row.<idField>}}` and run
       * through the same compile → run → validate path, so nothing about
       * pipelines, formatting or caching is duplicated for it.
       *
       * Capped at four: every section is a request when the sheet opens.
       */
      related: z
        .array(
          z.object({
            id: idSchema,
            title: z.string().min(1).max(120),
            op: idSchema,
            params: z.record(z.string(), z.string()).default({}),
            component: componentIdSchema.default("table"),
            pipeline: pipelineSchema.default([]),
            roles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
            format: z.record(z.string(), formatSchema).default({}),
            highlights: z.array(highlightSchema).max(8).default([]),
            /**
             * A tab on the page, or a section stacked down the sheet.
             *
             * The sheet ignores this and always stacks: tabs in a 560px
             * drawer put the labels on two lines and hide most of what is
             * there behind a control you have to notice first.
             */
            display: z.enum(["tab", "section"]).default("tab"),
            /**
             * What clicking a row of this section opens.
             *
             * Deliberately not a recursive `drilldown`: a self-referencing
             * schema is the shape that breaks the flat tool-schema
             * conversion, and unbounded depth is a navigation problem rather
             * than a feature. Two levels is what a parent-and-children view
             * actually needs.
             */
            opensRecord: z
              .object({
                op: idSchema,
                params: z.record(z.string(), z.string()).default({}),
                component: componentIdSchema.default("record"),
                pipeline: pipelineSchema.default([]),
                roles: z
                  .record(z.string(), z.union([z.string(), z.array(z.string())]))
                  .default({}),
              })
              .optional(),
          }),
        )
        .max(4)
        .default([]),
    })
    .optional(),
  })
  .superRefine((widget, ctx) => {
    const single = widget.source !== undefined;
    const multi = widget.sources.length > 0;

    if (single === multi) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: single
          ? "a widget declares either `source` or `sources`, never both"
          : "a widget needs a `source`, or two or more `sources`",
        path: ["source"],
      });
      return;
    }
    if (!multi) return;

    const names = new Set<string>();
    for (const source of widget.sources) {
      if (names.has(source.as)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `two sources are both named "${source.as}"`,
          path: ["sources"],
        });
      }
      names.add(source.as);
    }

    // Fan-out drives one endpoint from another's rows, so the source it reads
    // must exist and must not be itself.
    for (const source of widget.sources) {
      if (!source.fanOut) continue;
      if (source.fanOut.from === source.as) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${source.as}" cannot fan out from itself`,
          path: ["sources"],
        });
      } else if (!names.has(source.fanOut.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${source.as}" fans out from "${source.fanOut.from}", which is not a source`,
          path: ["sources"],
        });
      }
    }

    /*
     * A hidden source is fetched and not shown, which is only defensible if
     * something reads it. One that drives nothing is a request spent on data
     * nobody sees — silent, and exactly the kind of waste this codebase
     * refuses to let a spec express.
     */
    const driven = new Set(
      widget.sources.map((source) => source.fanOut?.from).filter(Boolean) as string[],
    );
    for (const source of widget.sources) {
      if (source.hidden && !driven.has(source.as)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${source.as}" is hidden but nothing fans out from it, so it would be fetched and never used`,
          path: ["sources"],
        });
      }
    }

    if (widget.sources.length > 1 && !widget.combine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "two or more sources need a `combine` saying how they combine",
        path: ["combine"],
      });
      return;
    }
    if (!widget.combine) return;

    /*
     * A union names no sides — every source contributes, in order — so the
     * only thing to check is that each one says what to call its rows. Without
     * a label the series column would carry an op id, which is a legend nobody
     * can read.
     */
    if (widget.combine.op === "union") {
      for (const source of widget.sources) {
        // A hidden source contributes no rows, so it has nothing to be called.
        if (source.hidden) continue;
        if (!source.label) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `source "${source.as}" needs a \`label\` — a union writes it into every row`,
            path: ["sources"],
          });
        }
      }
      return;
    }

    for (const side of ["left", "right"] as const) {
      if (!names.has(widget.combine[side])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `combine.${side} names "${widget.combine[side]}", which is not a source`,
          path: ["combine", side],
        });
      }
    }
    if (widget.combine.left === widget.combine.right) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a join needs two different sources",
        path: ["combine"],
      });
    }
  });

export type WidgetSpec = z.infer<typeof widgetSchema>;

export type NamedSource = z.infer<typeof namedSourceSchema>;

/**
 * Every endpoint a widget reads, in one shape.
 *
 * Callers should not branch on which form was declared — a single-source
 * widget is just a plan with one unnamed step, and treating it that way keeps
 * fetching, caching and inspection identical for both.
 */
export const widgetSources = (widget: WidgetSpec): NamedSource[] =>
  widget.source
    ? [{ as: "main", ...widget.source, pipeline: [], hidden: false }]
    : widget.sources;

export const layoutCellSchema = z.object({
  widgetId: idSchema,
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(200),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  locked: z.boolean().default(false),
  sizeVariant: z.string().optional(),
  /**
   * The group this widget is shown inside, if any.
   *
   * On the cell rather than on the widget, and that is the whole design. Two
   * things somebody wants side by side, or behind tabs, are still two widgets:
   * two datasets, two components, two caches, two refresh clocks. Nothing
   * about wanting to see them together makes them one, and a `panes` array on
   * the widget would have made composition a data concern — every role
   * contract, every validation and the whole runtime would have had to learn
   * about sub-widgets to render what is really an arrangement.
   *
   * So a group is a fact about the layout. Members keep their own cells, which
   * keeps the invariant the whole layout layer rests on — a cell names a real
   * widget — and means ungrouping restores positions that were never lost.
   */
  group: idSchema.optional(),
});

export type LayoutCell = z.infer<typeof layoutCellSchema>;

/**
 * Several widgets drawn inside one frame.
 *
 * `display` is a preference rather than a guarantee: a frame too narrow for
 * tabs stacks instead, the same way a record sheet does. The renderer decides,
 * because only it knows how much room there is.
 */
export const widgetGroupSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(120),
  display: z.enum(["tabs", "row", "stack"]).default("tabs"),
});

export type WidgetGroup = z.infer<typeof widgetGroupSchema>;

export const layoutSchema = z.object({
  gridCols: z.literal(12).default(12),
  cells: z.array(layoutCellSchema).default([]),
});

export type Layout = z.infer<typeof layoutSchema>;

/** A group's cells, in the order they are drawn. */
export const groupMembers = (
  layout: Layout,
  groupId: string,
): readonly LayoutCell[] =>
  layout.cells
    .filter((cell) => cell.group === groupId)
    .sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * The cell whose geometry the whole group occupies.
 *
 * A group is one rectangle on the grid, so exactly one of its members has to
 * own the position — otherwise dragging it would have to rewrite every
 * member's cell and the packer would have several rectangles claiming the same
 * space. The first member reading top-left is that one; the others keep their
 * geometry untouched and unread, waiting for the group to be dissolved.
 */
export const anchorCell = (
  layout: Layout,
  groupId: string,
): LayoutCell | undefined => groupMembers(layout, groupId)[0];

/**
 * Take a widget off a board, leaving the board still valid.
 *
 * Removing a widget is three edits, not one, and the third is easy to forget:
 * the widget, its cell, and any frame that just lost its second member. A
 * group of one is a shape this schema refuses — correctly, since it renders as
 * a widget wearing an extra title bar — so forgetting it does not produce a
 * slightly-wrong board, it produces one that will not save at all.
 *
 * That is what happened: two call sites each removed the widget and its cell,
 * neither knew about groups, and deleting either half of a pair made the whole
 * dashboard unsaveable with "invalid". Hence one function, so the rule lives
 * in the same place as the constraint it satisfies.
 */
export const withoutWidget = <T extends DashboardSpec>(dashboard: T, widgetId: string): T => {
  const cells = dashboard.layout.cells.filter((cell) => cell.widgetId !== widgetId);

  /*
   * A frame that has dropped below two members is dissolved rather than
   * emptied. Its survivor goes back to being an ordinary tile, which is what
   * somebody deleting the other one meant to happen.
   */
  const surviving = new Set(
    dashboard.groups
      .map((group) => group.id)
      .filter((id) => cells.filter((cell) => cell.group === id).length >= 2),
  );

  return {
    ...dashboard,
    widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId),
    groups: dashboard.groups.filter((group) => surviving.has(group.id)),
    layout: {
      ...dashboard.layout,
      cells: cells.map((cell) =>
        cell.group && !surviving.has(cell.group)
          ? { ...cell, group: undefined }
          : cell,
      ),
    },
  };
};

/** Rows the tab strip needs above the member it is switching between. */
const TAB_STRIP_ROWS = 1;

/** What one component asks to be drawn at, left to itself. */
const preferredBox = (component: string): { w: number; h: number } => {
  const grid = contractFor(component)?.grid;
  const sizes = grid?.sizes ?? [];
  if (sizes.length === 0) return { w: 6, h: 6 };
  const named = grid?.preferredSize
    ? sizes.find((size) => size.name === grid.preferredSize)
    : undefined;
  const chosen = named ?? [...sizes].sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
  return { w: chosen.w, h: chosen.h };
};

/**
 * The rectangle a group asks for when it is first placed.
 *
 * Only ever a starting point. Once somebody drags the frame, its anchor cell
 * holds the real geometry and this is not consulted again — which is why it
 * can afford to be a simple reading of what the members wanted rather than
 * anything the packer has to agree with.
 *
 * The three arrangements want genuinely different room, and getting that wrong
 * is what makes a new group look broken: tabs show one member at a time and
 * need one member's worth of space plus the strip, a row needs every member's
 * width at once, and a stack needs every member's height.
 */
export const groupSize = (
  components: readonly string[],
  display: "tabs" | "row" | "stack" = "tabs",
  gridCols = 12,
): { w: number; h: number } => {
  const boxes = components.map(preferredBox);
  if (boxes.length === 0) return { w: Math.min(6, gridCols), h: 6 };

  const widest = Math.max(...boxes.map((box) => box.w));
  const tallest = Math.max(...boxes.map((box) => box.h));

  if (display === "row") {
    const total = boxes.reduce((sum, box) => sum + box.w, 0);
    return { w: Math.min(gridCols, total), h: tallest };
  }
  if (display === "stack") {
    const total = boxes.reduce((sum, box) => sum + box.h, 0);
    return { w: Math.min(gridCols, widest), h: total };
  }
  return { w: Math.min(gridCols, widest), h: tallest + TAB_STRIP_ROWS };
};

export const dashboardSchema = z
  .object({
    specVersion: z.literal(1).default(1),
    id: idSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(400).optional(),
    params: dashboardParamsSchema.default({
      defaultRange: "30d",
      timeZone: "UTC",
      filters: [],
    }),
    widgets: z.array(widgetSchema).default([]),
    layout: layoutSchema.default({ gridCols: 12, cells: [] }),
    /**
     * Frames holding several widgets each.
     *
     * Declared on the board rather than inferred from the cells, so a group
     * has a title and a preferred arrangement of its own — an inferred one
     * would have nowhere to put either, and "Properties" above two tabs is
     * most of what makes a group read as one thing.
     */
    groups: z.array(widgetGroupSchema).default([]),
    /**
     * Board-wide look, keyed by component id (plus `widget` for the frame).
     *
     * Sits between the stored parts and a widget's own override, so "every
     * table on this dashboard" is expressible without changing the default for
     * every other dashboard — which is the distinction people actually reach
     * for when they say a board should look different.
     */
    presentation: z.record(z.string().max(64), presentationSchema).default({}),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .superRefine((dashboard, ctx) => {
    const seen = new Set<string>();
    dashboard.widgets.forEach((widget, index) => {
      if (seen.has(widget.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate widget id "${widget.id}"`,
          path: ["widgets", index, "id"],
        });
      }
      seen.add(widget.id);
    });

    dashboard.layout.cells.forEach((cell, index) => {
      if (!seen.has(cell.widgetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `layout references unknown widget "${cell.widgetId}"`,
          path: ["layout", "cells", index, "widgetId"],
        });
      }
      if (cell.x + cell.w > dashboard.layout.gridCols) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cell for "${cell.widgetId}" runs past the grid (x ${cell.x} + w ${cell.w} > ${dashboard.layout.gridCols})`,
          path: ["layout", "cells", index],
        });
      }
    });

    const groupIds = new Set<string>();
    dashboard.groups.forEach((group, index) => {
      if (groupIds.has(group.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate group id "${group.id}"`,
          path: ["groups", index, "id"],
        });
      }
      groupIds.add(group.id);
    });

    dashboard.layout.cells.forEach((cell, index) => {
      if (cell.group !== undefined && !groupIds.has(cell.group)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cell for "${cell.widgetId}" names group "${cell.group}", which is not declared`,
          path: ["layout", "cells", index, "group"],
        });
      }
    });

    /*
     * A group of one is not a group, and the failure it produces is silent.
     *
     * The frame would render a tab strip with one tab, or a row with one
     * column — a widget wearing a second title bar and looking, to anyone who
     * did not build it, like the other half failed to load. Refusing here is
     * the same call the widget schema makes about a join needing two different
     * sources: a shape that cannot mean anything should not be storable.
     */
    dashboard.groups.forEach((group, index) => {
      const members = dashboard.layout.cells.filter((cell) => cell.group === group.id);
      if (members.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `group "${group.id}" holds ${members.length} widget(s) — a group needs at least two`,
          path: ["groups", index],
        });
      }
    });

    const filterKeys = new Set(dashboard.params.filters.map((filter) => filter.key));
    for (const filter of dashboard.params.filters) {
      if (filter.type === "select" && (!filter.options || filter.options.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `select filter "${filter.key}" needs options`,
          path: ["params", "filters"],
        });
      }
    }

    // A widget referencing {{param.x}} for an undeclared x always resolves to
    // an empty string, which is a confusing silent failure — catch it here.
    const referenced = new Set<string>();
    const scan = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/\{\{\s*param\.([a-zA-Z0-9_]+)/g)) {
          if (match[1]) referenced.add(match[1]);
        }
      } else if (Array.isArray(value)) {
        value.forEach(scan);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(scan);
      }
    };
    dashboard.widgets.forEach((widget) => {
      scan(widget.source);
      scan(widget.pipeline);
      // A `{{param.x}}` inside a highlight predicate is held to exactly the
      // same declared-filter rule as one anywhere else.
      scan(widget.highlights);
      // Drill-down inputs are scanned too, so a `{{param.x}}` used there is
      // held to the same rule. `{{row.x}}` is a different prefix and passes
      // through untouched — it is row-scoped, not dashboard-declared.
      scan(widget.drilldown);
    });
    for (const key of referenced) {
      if (!filterKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `{{param.${key}}} is used but no filter declares "${key}"`,
          path: ["params", "filters"],
        });
      }
    }
  });

export type DashboardSpec = z.infer<typeof dashboardSchema>;

/** A named set of fields, for a record view that sections its fields. */
export interface FieldGroup {
  readonly title: string;
  readonly fields: readonly string[];
}

export interface ParseResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  /** Flat, human-readable messages — also what the agent's repair loop reads. */
  readonly errors: readonly string[];
}

const flatten = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

export const parseDashboard = (input: unknown): ParseResult<DashboardSpec> => {
  const result = dashboardSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data, errors: [] }
    : { ok: false, errors: flatten(result.error) };
};

export const parseWidget = (input: unknown): ParseResult<WidgetSpec> => {
  const result = widgetSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data, errors: [] }
    : { ok: false, errors: flatten(result.error) };
};
