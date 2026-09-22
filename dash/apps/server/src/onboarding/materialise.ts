import type {
  CategorySpec,
  ConnectionSpec,
  DashboardSpec,
  EntitySpec,
  LayoutCell,
  PlacementRequest,
  StarterSpec,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import {
  compileBrief,
  entityById,
  parseDashboard,
  solveLayout,
} from "@freebirdai/dash-spec";

/**
 * Turning a chosen set of categories into boards somebody can look at.
 *
 * The deterministic half of onboarding, and deliberately pure: no model, no
 * store, no clock. Everything interesting has already been decided — which
 * parts of the API somebody wants, and what each part opens with — so this is
 * a compile and a pack, and it is testable without any of the machinery around
 * it.
 *
 * Three things it is responsible for, each of which has a wrong answer worth
 * naming:
 *
 * **Compiling against this connection, not against the catalog.** The starter
 * sets describe the API; a connection may hold a subset of its endpoints. A
 * widget over an endpoint this connection does not carry is one nothing could
 * ever fetch, so it is dropped here with the compiler's own sentence rather
 * than saved to fail in front of somebody.
 *
 * **Placing the widgets.** The board is laid out before any browser sees it,
 * which is what makes a starting dashboard look designed rather than stacked.
 * `solveLayout` reads each starter's importance and requested size and packs
 * the grid; nothing here writes a rectangle of its own, so nothing can overlap
 * or run past the last column — both of which `dashboardSchema` refuses
 * outright, costing the whole board rather than the one widget.
 *
 * **Saying what it could not do.** A board quietly shorter than the one that
 * was designed is the failure mode here: nothing on screen says which widget
 * is missing or why. Every drop carries a reason out.
 */

/**
 * How many widgets one board opens with when several parts share it.
 *
 * Three categories at six widgets each is eighteen tiles on one screen, which
 * is not a starting point — it is a wall. The cap bites only on the combined
 * layout; a board per category keeps whatever its own set holds.
 */
export const COMBINED_WIDGET_MAX = 12;

export interface MaterialiseSource {
  readonly connection: ConnectionSpec;
  readonly entities: readonly EntitySpec[];
}

export interface MaterialiseInput {
  readonly source: MaterialiseSource;
  /** The categories that were chosen, in the order they were offered. */
  readonly categories: readonly CategorySpec[];
  readonly layout: "single" | "per-category";
  /**
   * Make an empty board with this title and return it, ids and all.
   *
   * Injected because board ids are unique across the whole instance and only
   * the store knows what is taken — and because a materialise that created
   * nothing would be much harder to test than one that is handed a maker.
   */
  readonly createBoard: (title: string) => DashboardSpec;
}

export interface MaterialisedBoard {
  readonly category?: string | undefined;
  readonly board: DashboardSpec;
  readonly widgets: readonly WidgetSpec[];
}

export interface MaterialiseResult {
  readonly boards: readonly MaterialisedBoard[];
  /** Where the result differs from what was designed, in a reader's words. */
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

/** One compiled starter, still attached to the sizing it asked for. */
interface Built {
  readonly widget: WidgetSpec;
  readonly starter: StarterSpec;
  readonly category: string;
}

const pathOf = (connection: ConnectionSpec, op: string | undefined): string | undefined =>
  op ? connection.ops.find((one) => one.id === op)?.path : undefined;

/**
 * The rest of the API, for a starter that names two record types.
 *
 * The catalog's record types paired with *this connection's* endpoints — the
 * same pairing the brief route makes, and for the same reason: the catalog
 * describes the whole API and a link naming an endpoint this connection does
 * not carry is one nothing here could fetch.
 */
const relatedFor = (source: MaterialiseSource) => ({
  entities: source.entities,
  resources: source.connection.resources,
  ops: source.connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
});

/** A widget id from a title, unique against what the board already holds. */
const widgetIdFor = (title: string, taken: ReadonlySet<string>): string => {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "widget";
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${taken.size}`;
};

/**
 * Compile one category's starter set against this connection.
 *
 * Exported for the tests, which is worth it: this is where a shared artifact
 * meets one account, and it is the only place a starter can be lost.
 */
export const buildCategory = (input: {
  readonly source: MaterialiseSource;
  readonly category: CategorySpec;
  readonly taken: Set<string>;
}): { built: readonly Built[]; notes: readonly string[] } => {
  const { source, category, taken } = input;
  const notes: string[] = [];
  const built: Built[] = [];

  for (const starter of category.starters) {
    const entity = entityById(source.entities, starter.brief.entity);
    const resource = entity
      ? source.connection.resources.find((one) => one.id === entity.resource)
      : undefined;
    if (!entity || !resource) {
      notes.push(
        `${category.title}: this connection does not carry the records one of its widgets is about.`,
      );
      continue;
    }

    const title = starter.brief.title ?? entity.name.many;
    const id = widgetIdFor(title, taken);
    const compiled = compileBrief({
      brief: starter.brief,
      entity,
      resource,
      connection: source.connection.id,
      id,
      listPath: pathOf(source.connection, resource.listOp),
      related: relatedFor(source),
    });

    if (!compiled.widget) {
      notes.push(
        `${category.title}: “${title}” could not be built — ${
          compiled.errors[0] ?? compiled.notes[0] ?? "it did not compile against this connection."
        }`,
      );
      continue;
    }

    /*
     * The compiler's own notes are carried, not swallowed. They are where it
     * says it did something other than what the brief asked for — a view that
     * would not bind, a date axis bucketed by month — and a starter set nobody
     * wrote by hand is exactly the case where somebody wants to know.
     */
    notes.push(...compiled.notes.map((note) => `${category.title}: ${note}`));
    taken.add(compiled.widget.id);
    built.push({ widget: compiled.widget, starter, category: category.id });
  }

  return { built, notes };
};

/** Placement requests, in the order and at the sizes the starters asked for. */
const placementsFor = (built: readonly Built[]): PlacementRequest[] =>
  built.map((one) => ({
    widgetId: one.widget.id,
    component: one.widget.component,
    importance: one.starter.importance,
    ...(one.starter.size ? { size: one.starter.size } : {}),
  }));

/**
 * Take the best of each category, turn by turn, up to what one board holds.
 *
 * Round-robin rather than category by category, because the alternative puts
 * the whole of the first category above the fold and none of the second — and
 * somebody who asked for leasing *and* maintenance on one tab wants to see
 * both when it opens. Within a turn the most important widget goes first, so
 * the tiles that survive the cap are each category's headline numbers rather
 * than whichever category was listed first.
 */
export const interleave = (
  built: readonly Built[],
  limit = COMBINED_WIDGET_MAX,
): readonly Built[] => {
  const queues = new Map<string, Built[]>();
  for (const one of built) {
    const queue = queues.get(one.category) ?? [];
    queue.push(one);
    queues.set(one.category, queue);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => (b.starter.importance ?? 3) - (a.starter.importance ?? 3));
  }

  const taken: Built[] = [];
  let moved = true;
  while (moved && taken.length < limit) {
    moved = false;
    for (const queue of queues.values()) {
      if (taken.length >= limit) break;
      const next = queue.shift();
      if (!next) continue;
      taken.push(next);
      moved = true;
    }
  }
  return taken;
};

const withWidgets = (
  board: DashboardSpec,
  built: readonly Built[],
): { board: DashboardSpec | null; error?: string } => {
  const cells: LayoutCell[] = solveLayout(placementsFor(built), {
    gridCols: board.layout.gridCols,
  }).cells;

  const parsed = parseDashboard({
    ...board,
    widgets: built.map((one) => one.widget),
    layout: { ...board.layout, cells },
  });
  return parsed.ok && parsed.value
    ? { board: parsed.value }
    : { board: null, error: parsed.errors.join("; ") || "the board did not validate" };
};

export const materialise = (input: MaterialiseInput): MaterialiseResult => {
  const notes: string[] = [];
  const errors: string[] = [];

  if (input.categories.length === 0) {
    return { boards: [], notes, errors: ["nothing was chosen"] };
  }

  /*
   * Widget ids are unique per board, but kept unique across the whole run: a
   * combined board holds every category's widgets, and two categories both
   * opening with "Tasks" would otherwise collide on the one board that holds
   * both.
   */
  const taken = new Set<string>();
  const perCategory = input.categories.map((category) => {
    const result = buildCategory({ source: input.source, category, taken });
    notes.push(...result.notes);
    return { category, built: result.built };
  });

  if (input.layout === "single") {
    const built = interleave(perCategory.flatMap((one) => one.built));
    const dropped = perCategory.reduce((sum, one) => sum + one.built.length, 0) - built.length;
    if (dropped > 0) {
      notes.push(
        `${dropped} widget(s) were left off: one board opens with at most ${COMBINED_WIDGET_MAX}. Everything else is a question away.`,
      );
    }
    if (built.length === 0) {
      return { boards: [], notes, errors: ["none of the widgets could be built"] };
    }

    const empty = input.createBoard(input.source.connection.title);
    const filled = withWidgets(empty, built);
    if (!filled.board) {
      return { boards: [], notes, errors: [filled.error ?? "the board did not validate"] };
    }
    return {
      boards: [{ board: filled.board, widgets: filled.board.widgets }],
      notes,
      errors,
    };
  }

  const boards: MaterialisedBoard[] = [];
  for (const { category, built } of perCategory) {
    if (built.length === 0) {
      notes.push(
        `${category.title}: no board was made — none of its widgets could be built against this connection.`,
      );
      continue;
    }
    const empty = input.createBoard(category.title);
    const filled = withWidgets(empty, built);
    if (!filled.board) {
      errors.push(`${category.title}: ${filled.error ?? "the board did not validate"}`);
      continue;
    }
    boards.push({
      category: category.id,
      board: filled.board,
      widgets: filled.board.widgets,
    });
  }

  if (boards.length === 0 && errors.length === 0) {
    errors.push("none of the widgets could be built");
  }
  return { boards, notes, errors };
};
