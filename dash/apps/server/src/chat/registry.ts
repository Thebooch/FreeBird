import type { AuthoredWidget } from "@freebirdai/dash-agent";
import { conciergeActions, conciergeKnowledge, type ConciergeOps } from "./concierge-actions.js";
import type {
  CapabilityReport,
  DashboardSpec,
  RangePreset,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import { parseWidget, rangePresetSchema, widgetSources } from "@freebirdai/dash-spec";
import type { ComponentDefinition } from "@freebirdai/core";
import { createComponentRegistry } from "@freebirdai/core";
import { z } from "zod";

/**
 * The dashboard, described to the chat engine.
 *
 * FreeBird reasons about *components*, and Dash already has a precise notion of
 * one: a widget bound to an endpoint, whose fields sampling has actually seen.
 * So the registry is generated from the board and its capability report rather
 * than hand-written — which means the model is told what exists, not what a
 * developer remembered to describe.
 *
 * Nothing here is a live data path. Widgets fetch through the existing query
 * route; this only tells the model what is on screen and what may be done to it.
 */

/** What a chat action needs in order to change the board. */
export interface BoardOps {
  readonly getDashboard: () => DashboardSpec | null;
  readonly putDashboard: (spec: DashboardSpec) => void;
  /** Authored elsewhere (rules, review, or this chat turn) and already parsed. */
  readonly onChanged?: () => void;
  /** Create a board from a title, applying the server's own slug rules. */
  readonly createDashboard?: (title: string) => DashboardSpec;
  readonly deleteDashboard?: (id: string) => void;
  readonly getDashboardById?: (id: string) => DashboardSpec | null;
}

/** A connection as the assistant needs to see it: name, and whether it is read. */
export interface ConnectionSummary {
  readonly id: string;
  readonly title: string;
  /** A report exists and still matches the connection's endpoints. */
  readonly read: boolean;
  /** A report exists but describes different endpoints. */
  readonly stale: boolean;
}

export interface BuildChatRegistryInput {
  readonly dashboard: DashboardSpec;
  readonly reports: readonly CapabilityReport[];
  readonly board: BoardOps;
  /** Offers the chat may pick from when asked to add something. */
  readonly suggestions?: readonly AuthoredWidget[];
  /** Every board, so "what tabs do I have?" is answerable. */
  readonly allDashboards?: ReadonlyArray<{ id: string; title: string }>;
  /** Every connection, so "what am I connected to?" is answerable. */
  readonly connections?: readonly ConnectionSummary[];
  /**
   * Guided setup, when there is anything to guide.
   *
   * Absent means the three setup actions are simply not registered, so a
   * model with no connections to build against cannot offer a flow that would
   * dead-end on its first question.
   */
  readonly concierge?: ConciergeOps;
}

/* ── actions ──────────────────────────────────────────────────────────── */

const addWidgetSchema = z.object({
  widgetId: z
    .string()
    .min(1)
    .describe("Id of a suggested widget to add. Must be one you were shown."),
});

const removeWidgetSchema = z.object({
  widgetId: z.string().min(1).describe("Id of a widget currently on the dashboard."),
});

const setRangeSchema = z.object({
  preset: rangePresetSchema.describe("One of 24h, 7d, 30d, 90d, 12mo."),
});

const openWidgetSchema = z.object({
  widgetId: z.string().min(1).describe("Id of a widget currently on the dashboard."),
});

const switchDashboardSchema = z.object({
  dashboardId: z.string().min(1).describe("Id of a dashboard from the TABS list."),
});

const createDashboardSchema = z.object({
  title: z.string().min(1).describe("What to call the new tab, in the user's own words."),
});

const renameDashboardSchema = z.object({
  dashboardId: z.string().min(1).describe("Id of a dashboard from the TABS list."),
  title: z.string().min(1).describe("The new name."),
});

const deleteDashboardSchema = z.object({
  dashboardId: z.string().min(1).describe("Id of a dashboard from the TABS list."),
});

const readConnectionSchema = z.object({
  connectionId: z.string().min(1).describe("Id of a connection from the CONNECTIONS list."),
});

/**
 * Actions that only move the view.
 *
 * `requiresConfirmation: "none"` is defensible *here* and nowhere else in this
 * file: changing a time range or opening a panel is local, instantly visible,
 * and undone by doing the opposite. Nothing leaves the browser and no stored
 * spec changes.
 */
const viewActions = (): ComponentDefinition["actions"] => [
  {
    id: "set_time_range",
    description: "Change the dashboard's time range.",
    schema: setRangeSchema,
    requiresConfirmation: "none",
    // Executed client-side; the handler exists so the contract is complete.
    handler: async (args: { preset: RangePreset }) => ({ preset: args.preset }),
  },
  {
    id: "open_widget",
    description: "Open a widget's inspector so the user can see its data and request.",
    schema: openWidgetSchema,
    requiresConfirmation: "none",
    handler: async (args: { widgetId: string }) => ({ widgetId: args.widgetId }),
  },
  {
    id: "switch_dashboard",
    description: "Move to a different tab. Only ids from the TABS list are valid.",
    schema: switchDashboardSchema,
    requiresConfirmation: "none",
    handler: async (args: { dashboardId: string }) => ({ dashboardId: args.dashboardId }),
  },
  /*
   * Opening a panel is not doing the thing the panel does.
   *
   * Connecting an API means choosing one, pasting a credential and approving a
   * read — decisions the user has to make. The assistant can put them in front
   * of it, which is the whole of what these two do.
   */
  {
    id: "open_connections",
    description:
      "Open the Connections panel so the user can attach a new API or manage an existing one.",
    schema: z.object({}),
    requiresConfirmation: "none",
    handler: async () => ({ opened: "connections" }),
  },
  {
    id: "open_add_widget",
    description: "Open the Add-a-widget panel so the user can build one from a connection.",
    schema: z.object({}),
    requiresConfirmation: "none",
    handler: async () => ({ opened: "add-widget" }),
  },
];

/**
 * Actions that write the stored dashboard.
 *
 * Both are `"preview"`, both carry an `authorize` gate, and neither will ever
 * be `"none"`. A spec-mutating action with no confirmation is a straight line
 * from a model's guess to a changed file, and the preview card is the only
 * thing standing in it.
 */
const boardActions = (input: BuildChatRegistryInput): ComponentDefinition["actions"] => {
  const suggestionById = new Map(
    (input.suggestions ?? []).map((offer) => [offer.id, offer]),
  );

  return [
    {
      id: "add_widget",
      description:
        "Add one of the suggested widgets to the dashboard. Only ids you were shown are valid.",
      schema: addWidgetSchema,
      requiresConfirmation: "preview",
      authorize: (args: { widgetId: string }) =>
        suggestionById.has(args.widgetId) || {
          ok: false as const,
          reason: `"${args.widgetId}" is not one of the widgets offered for this dashboard.`,
          status: 403,
        },
      readCurrent: () => ({
        widgetCount: input.board.getDashboard()?.widgets.length ?? 0,
      }),
      handler: async (args: { widgetId: string }) => {
        const offer = suggestionById.get(args.widgetId);
        const current = input.board.getDashboard();
        if (!offer || !current) throw new Error("that widget is no longer available");

        /*
         * Re-parse rather than trust the offer. It was built server-side and
         * validated once, but this is the step that writes a file — a spec
         * that cannot execute must never reach disk.
         */
        const parsed = parseWidget(offer.widget);
        if (!parsed.ok || !parsed.value) {
          throw new Error(
            `that widget no longer validates: ${parsed.errors.join("; ") || "unknown"}`,
          );
        }
        const widget: WidgetSpec = parsed.value;
        if (current.widgets.some((existing) => existing.id === widget.id)) {
          return { added: false, reason: "already on the dashboard", widgetId: widget.id };
        }

        input.board.putDashboard({ ...current, widgets: [...current.widgets, widget] });
        input.board.onChanged?.();
        return { added: true, widgetId: widget.id, title: widget.title };
      },
    },
    {
      id: "remove_widget",
      description: "Remove a widget from the dashboard.",
      schema: removeWidgetSchema,
      requiresConfirmation: "preview",
      authorize: (args: { widgetId: string }) =>
        (input.board.getDashboard()?.widgets.some((w) => w.id === args.widgetId) ?? false) || {
          ok: false as const,
          reason: `"${args.widgetId}" is not on this dashboard.`,
          status: 404,
        },
      readCurrent: (args: { widgetId: string }) => {
        const widget = input.board
          .getDashboard()
          ?.widgets.find((candidate) => candidate.id === args.widgetId);
        return widget ? { id: widget.id, title: widget.title } : null;
      },
      handler: async (args: { widgetId: string }) => {
        const current = input.board.getDashboard();
        if (!current) throw new Error("no dashboard is open");
        input.board.putDashboard({
          ...current,
          widgets: current.widgets.filter((widget) => widget.id !== args.widgetId),
        });
        input.board.onChanged?.();
        return { removed: true, widgetId: args.widgetId };
      },
    },

    /* ── tabs ─────────────────────────────────────────────────────────── */

    {
      id: "create_dashboard",
      description: "Create a new tab. The user is shown a confirmation first.",
      schema: createDashboardSchema,
      requiresConfirmation: "preview",
      authorize: () =>
        input.board.createDashboard !== undefined || {
          ok: false as const,
          reason: "creating tabs is not available here",
          status: 501,
        },
      handler: async (args: { title: string }) => {
        const created = input.board.createDashboard!(args.title.trim());
        input.board.onChanged?.();
        return { created: true, dashboardId: created.id, title: created.title };
      },
    },
    {
      id: "rename_dashboard",
      description: "Rename an existing tab.",
      schema: renameDashboardSchema,
      requiresConfirmation: "preview",
      authorize: (args: { dashboardId: string }) =>
        knownDashboard(input, args.dashboardId) || {
          ok: false as const,
          reason: `"${args.dashboardId}" is not one of your tabs.`,
          status: 404,
        },
      readCurrent: (args: { dashboardId: string }) => ({
        title: input.board.getDashboardById?.(args.dashboardId)?.title ?? null,
      }),
      handler: async (args: { dashboardId: string; title: string }) => {
        const current = input.board.getDashboardById?.(args.dashboardId);
        if (!current) throw new Error("that tab no longer exists");
        input.board.putDashboard({ ...current, title: args.title.trim() });
        input.board.onChanged?.();
        return { renamed: true, dashboardId: args.dashboardId, title: args.title.trim() };
      },
    },
    {
      /*
       * The one action stricter than preview.
       *
       * Deleting a tab takes its widgets with it and there is no undo — a
       * preview card the user has learned to click through is not enough
       * protection for that.
       */
      id: "delete_dashboard",
      description: "Delete a tab and everything on it. This cannot be undone.",
      schema: deleteDashboardSchema,
      requiresConfirmation: "strict",
      authorize: (args: { dashboardId: string }) =>
        (input.board.deleteDashboard !== undefined &&
          knownDashboard(input, args.dashboardId)) || {
          ok: false as const,
          reason: `"${args.dashboardId}" is not one of your tabs.`,
          status: 404,
        },
      readCurrent: (args: { dashboardId: string }) => {
        const board = input.board.getDashboardById?.(args.dashboardId);
        return board ? { title: board.title, widgets: board.widgets.length } : null;
      },
      handler: async (args: { dashboardId: string }) => {
        input.board.deleteDashboard!(args.dashboardId);
        input.board.onChanged?.();
        return { deleted: true, dashboardId: args.dashboardId };
      },
    },

    /* ── connections ──────────────────────────────────────────────────── */

    {
      /*
       * Reading spends real requests against someone else's API, so it goes
       * through a confirmation exactly like the Read step in the wizard. The
       * handler deliberately does not perform the read: it routes the user to
       * the panel that shows the cost first. An assistant that can silently
       * fire forty requests because a sentence sounded like a request for one
       * is the thing the whole consent flow exists to prevent.
       */
      id: "read_connection",
      description:
        "Start reading a connection so its widgets can be suggested. Opens the panel that " +
        "shows how many requests it will make; it does not read on its own.",
      schema: readConnectionSchema,
      requiresConfirmation: "preview",
      authorize: (args: { connectionId: string }) =>
        (input.connections ?? []).some((c) => c.id === args.connectionId) || {
          ok: false as const,
          reason: `"${args.connectionId}" is not one of your connections.`,
          status: 404,
        },
      handler: async (args: { connectionId: string }) => ({
        opened: "connections",
        connectionId: args.connectionId,
      }),
    },
  ];
};

/** Is this a tab the user actually has? */
const knownDashboard = (input: BuildChatRegistryInput, id: string): boolean =>
  (input.allDashboards ?? []).some((board) => board.id === id) ||
  input.board.getDashboardById?.(id) != null;

/* ── knowledge ────────────────────────────────────────────────────────── */

/**
 * What the model is told about a widget.
 *
 * Field names and honest gaps, never row values — the same boundary the
 * capability report keeps on disk and the review prompt keeps in its context.
 */
const knowledgeFor = (
  widget: WidgetSpec,
  reports: readonly CapabilityReport[],
): Array<{ text: string }> => {
  const facts: Array<{ text: string }> = [{ text: `Rendered as a ${widget.component}.` }];

  // A widget may draw on one source or several; `widgetSources` normalizes
  // both forms so this does not have to know which shape it was written in.
  for (const source of widgetSources(widget)) {
    facts.push({
      text: `Shows data from the "${source.connection}" connection via its "${source.op}" endpoint.`,
    });

    const report = reports.find((candidate) => candidate.connection === source.connection);
    if (!report) {
      facts.push({
        text: `The "${source.connection}" connection has not been read yet, so its fields and relationships are unknown.`,
      });
      continue;
    }

    const resource = report.resources.find(
      (candidate) => candidate.listOp === source.op || candidate.detailOp === source.op,
    );
    if (resource) {
      facts.push({ text: `Each row is one ${resource.title}.` });
      const shape = report.shapes[resource.id];
      if (shape) {
        facts.push({
          text: `Available fields: ${shape.fields
            .map((field) => field.name)
            .slice(0, 24)
            .join(", ")}.`,
        });
      }
      if (resource.relations.length > 0) {
        facts.push({
          text: `Related records: ${resource.relations
            .map((relation) => relation.title)
            .join(", ")}.`,
        });
      }
    }

    const unknown = report.unknowns.find((candidate) => candidate.recheckOp === source.op);
    if (unknown) {
      facts.push({
        text: `Note: this endpoint could not be read (${unknown.reason}), so its fields are unconfirmed.`,
      });
    }
  }
  return facts;
};

/* ── the registry ─────────────────────────────────────────────────────── */

/**
 * The two lists the assistant needs, and the difference between them.
 *
 * Left implicit, this goes wrong in a specific way: per-widget knowledge tells
 * the model about a widget it is *already looking at*, but never gives it the
 * roster — so asked "what is on this dashboard?" it hedges, and asked for a
 * widget by title it cannot match one. And suggestions were reachable only as
 * an authorization allowlist, meaning the model could be told "no" for naming
 * an id it was never shown in the first place.
 *
 * So both are stated outright:
 *   - what exists on the board right now, addressable by id and by title
 *   - what does not exist yet but can be created, with the id `add_widget` wants
 */
const inventoryKnowledge = (input: BuildChatRegistryInput): Array<{ text: string }> => {
  const facts: Array<{ text: string }> = [];
  const widgets = input.dashboard.widgets;

  if (widgets.length === 0) {
    facts.push({ text: "This dashboard has no widgets on it yet." });
  } else {
    facts.push({
      text:
        `ON THIS DASHBOARD NOW — ${widgets.length} widget(s). ` +
        "These already exist; you can open or remove them by id: " +
        widgets
          .map((widget) => `"${widget.title}" (id: ${widget.id}, ${widget.component})`)
          .join("; "),
    });
  }

  /*
   * Only what is not already on the board. Offering to create a widget the
   * user is looking at is the kind of answer that destroys trust in the rest.
   */
  const present = new Set(widgets.map((widget) => widget.id));
  const creatable = (input.suggestions ?? []).filter((offer) => !present.has(offer.id));

  if (creatable.length === 0) {
    facts.push({
      text:
        "NOT YET CREATED — there are no ready-made widgets to add right now. " +
        "If the user wants something new, say what it would need (usually reading " +
        "the connection first) rather than inventing an id.",
    });
    return facts;
  }

  /*
   * Which connection each offer draws on, and this board's own connections
   * first.
   *
   * Suggestions are generated from every connection that has been read, so a
   * property-management dashboard was being offered widgets about blog posts
   * from an unrelated API. Mixing sources on one board is a thing to want
   * eventually, but an offer whose origin is unstated just reads as nonsense.
   */
  const connectionOf = (offer: AuthoredWidget): string =>
    widgetSources(offer.widget)[0]?.connection ?? "unknown";

  const own = new Set(
    widgets.flatMap((widget) => widgetSources(widget).map((source) => source.connection)),
  );
  const ranked = [...creatable].sort(
    (a, b) => Number(own.has(connectionOf(b))) - Number(own.has(connectionOf(a))),
  );
  const shown = ranked.slice(0, 20);
  const fromOwn = ranked.filter((offer) => own.has(connectionOf(offer)));

  facts.push({
    text:
      `NOT YET CREATED — ${creatable.length} widget(s) can be added. These do NOT exist ` +
      "yet; adding one uses `add_widget` with the id given here, and the user sees a " +
      "confirmation card before anything changes. Each is labelled with the connection " +
      "it reads from — prefer ones matching this dashboard's own connections " +
      `(${own.size > 0 ? [...own].join(", ") : "none yet"}): ` +
      shown
        .map((offer) => `id: ${offer.id} [${connectionOf(offer)}] — ${offer.headline}`)
        .join(" | ") +
      (creatable.length > shown.length ? ` (and ${creatable.length - shown.length} more)` : ""),
  });

  if (fromOwn.length === 0 && own.size > 0) {
    facts.push({
      text:
        `None of those come from this dashboard's own connection(s) (${[...own].join(", ")}). ` +
        "To get suggestions for those, the connection needs reading first — that is the " +
        '"Read" step in Connections, and it makes real requests to the API.',
    });
  }

  facts.push({
    text:
      "Never pass an id to `add_widget` that is not in the NOT YET CREATED list, and " +
      "never claim a widget is on the dashboard unless it is in the ON THIS DASHBOARD NOW list. " +
      "And do not stretch one of these to fit a request it does not match — when the user " +
      "described what they want, `start_setup` builds exactly that and shows it to them.",
  });
  return facts;
};

/**
 * The other two things the user can ask about: their tabs, and what they are
 * connected to.
 *
 * Same reasoning as the widget roster — without these stated outright the
 * assistant can act on a tab (the action tools carry ids) while being unable
 * to *name* one, which reads to a user as it not knowing what it plainly
 * should.
 */
const workspaceKnowledge = (input: BuildChatRegistryInput): Array<{ text: string }> => {
  const facts: Array<{ text: string }> = [];

  const tabs = input.allDashboards ?? [];
  if (tabs.length > 0) {
    facts.push({
      text:
        `TABS — ${tabs.length} dashboard(s) exist. The one being discussed is ` +
        `"${input.dashboard.title}" (id: ${input.dashboard.id}). All of them: ` +
        tabs
          .map(
            (tab) =>
              `"${tab.title}" (id: ${tab.id})${tab.id === input.dashboard.id ? " ← current" : ""}`,
          )
          .join("; ") +
        ". Use `switch_dashboard` to move between them; `create_dashboard`, " +
        "`rename_dashboard` and `delete_dashboard` manage them.",
    });
  }

  const connections = input.connections ?? [];
  if (connections.length === 0) {
    facts.push({
      text:
        "CONNECTIONS — none yet. Nothing can be charted until an API is attached; " +
        "`open_connections` puts the user in front of that.",
    });
    return facts;
  }

  const unread = connections.filter((connection) => !connection.read);
  facts.push({
    text:
      `CONNECTIONS — ${connections.length} attached: ` +
      connections
        .map(
          (connection) =>
            `"${connection.title}" (id: ${connection.id}, ` +
            `${connection.read ? "read" : connection.stale ? "read but out of date" : "not read yet"})`,
        )
        .join("; ") +
      ".",
  });

  if (unread.length > 0) {
    facts.push({
      text:
        `Reading is what produces widget suggestions, so ${unread
          .map((connection) => `"${connection.title}"`)
          .join(", ")} ` +
        "has nothing to offer yet. That is the reason, and it is worth saying rather than " +
        "guessing around — `read_connection` starts it, and the user approves the cost first.",
    });
  }
  return facts;
};

export const buildChatRegistry = (input: BuildChatRegistryInput) => {
  const registry = createComponentRegistry();
  const actions = [
    ...(boardActions(input) ?? []),
    ...(viewActions() ?? []),
    ...(input.concierge ? (conciergeActions(input.concierge) ?? []) : []),
  ];

  /*
   * Registered first, deliberately. `buildKnowledgePrompt` emits components in
   * registration order and truncates at a character budget, so the roster —
   * the one thing that must always survive — goes in ahead of the per-widget
   * detail rather than after it.
   *
   * It also hosts the actions, which is what makes them reachable on an empty
   * board where there is no widget to hang them off.
   */
  /*
   * `register` throws on a duplicate id, so a widget legitimately called
   * "dashboard" would take the whole chat down. Step aside rather than
   * shadow it — and avoid `__`, which the per-action tool encoder uses as
   * its separator.
   */
  const taken = new Set(input.dashboard.widgets.map((widget) => widget.id));
  let rosterId = "dashboard";
  for (let n = 2; taken.has(rosterId); n++) rosterId = `dashboard-${n}`;

  registry.register({
    id: rosterId,
    title: input.dashboard.title,
    description:
      "The dashboard itself: which widgets are on it, and which can be added to it.",
    knowledge: [
      ...inventoryKnowledge(input),
      ...workspaceKnowledge(input),
      ...(input.concierge ? conciergeKnowledge(input.concierge) : []),
    ],
    grid: { minW: 12, minH: 4 },
    actions,
  });

  for (const widget of input.dashboard.widgets) {
    const cell = input.dashboard.layout.cells.find((candidate) => candidate.widgetId === widget.id);
    const connections = [
      ...new Set(widgetSources(widget).map((source) => source.connection)),
    ];
    registry.register({
      id: widget.id,
      title: widget.title,
      description: `A ${widget.component} on the "${input.dashboard.title}" dashboard.`,
      tags: [...connections, widget.component],
      knowledge: knowledgeFor(widget, input.reports),
      grid: {
        minW: cell?.w ?? 4,
        minH: cell?.h ?? 4,
      },
      // Every widget carries the same board actions: the model addresses the
      // dashboard, not one panel, and duplicating them per component is how
      // an action ends up reachable from one widget and not another.
      actions,
    });
  }

  return registry;
};
