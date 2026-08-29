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
import {
  pageFor,
  resolveHandle,
  selectorFor,
  workspaceHandles,
  type WidgetHandle,
} from "./handles.js";

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
  /**
   * Every board, with its widgets.
   *
   * Tabs are the user's own filing, not a boundary the assistant should
   * inherit: a widget one tab over has to be nameable, citable and openable
   * without being switched to first. Absent, only `dashboard` is registered —
   * which is what the no-dashboard bootstrap case wants.
   */
  readonly workspace?: readonly DashboardSpec[];
  readonly reports: readonly CapabilityReport[];
  /**
   * What is on screen right now, in one sentence.
   *
   * Showing somebody a widget and letting them click into a record is a good
   * way to work, and the conversation should be able to keep up with wherever
   * that lands them. Without this the assistant knows which board is open and
   * nothing finer, so "what is this?" on a record page has no subject.
   */
  readonly onScreen?: string;
  /**
   * Which kinds of record can be opened in full, one line each.
   *
   * Rebuilt every turn, unlike the tool schemas the engine takes once — which
   * is what lets a connection added five minutes ago be used without a
   * restart. It is also what stops the assistant reporting a field as
   * unavailable when the collection merely summarised it. See `readRoster`.
   */
  readonly records?: string;
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
  widgetId: z
    .string()
    .min(1)
    .describe("Id of a widget that exists, from the WIDGETS list. Any tab."),
});

const setRangeSchema = z.object({
  preset: rangePresetSchema.describe("One of 24h, 7d, 30d, 90d, 12mo."),
});

const openWidgetSchema = z.object({
  widgetId: z
    .string()
    .min(1)
    .describe("Id of a widget that exists, from the WIDGETS list. Any tab."),
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
const viewActions = (
  handles: readonly WidgetHandle[],
): ComponentDefinition["actions"] => [
  {
    id: "set_time_range",
    description: "Change the dashboard's time range.",
    schema: setRangeSchema,
    requiresConfirmation: "none",
    // Executed client-side; the handler exists so the contract is complete.
    handler: async (args: { preset: RangePreset }) => ({ preset: args.preset }),
  },
  {
    /*
     * Takes a workspace handle, so this one action reaches a widget on any
     * tab. The client switches tab first when it has to — which is the whole
     * point of tabs being the user's filing rather than a boundary.
     */
    id: "open_widget",
    description:
      "Show the user a widget and open its inspector. Works for a widget on any tab; " +
      "the view moves to that tab first.",
    schema: openWidgetSchema,
    requiresConfirmation: "none",
    handler: async (args: { widgetId: string }) => {
      const found = resolveHandle(handles, args.widgetId);
      if (!found) throw new Error(`there is no widget "${args.widgetId}"`);
      return {
        widgetId: found.widgetId,
        dashboardId: found.dashboardId,
        handle: found.handle,
        title: found.widget.title,
      };
    },
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
const boardActions = (
  input: BuildChatRegistryInput,
  handles: readonly WidgetHandle[],
): ComponentDefinition["actions"] => {
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
      /*
       * Also handle-addressed, and deliberately so: refusing to remove a
       * widget the assistant can see and name, purely because it is filed
       * under a different tab, is the boundary this pass exists to remove.
       * It is still `preview`, so the user reads which widget on which tab
       * before anything is written.
       */
      id: "remove_widget",
      description:
        "Remove a widget. Works for a widget on any tab; the confirmation card names which.",
      schema: removeWidgetSchema,
      requiresConfirmation: "preview",
      authorize: (args: { widgetId: string }) =>
        resolveHandle(handles, args.widgetId) !== null || {
          ok: false as const,
          reason: `"${args.widgetId}" is not a widget in this workspace.`,
          status: 404,
        },
      readCurrent: (args: { widgetId: string }) => {
        const found = resolveHandle(handles, args.widgetId);
        return found
          ? { id: found.handle, title: found.widget.title, tab: found.dashboardTitle }
          : null;
      },
      handler: async (args: { widgetId: string }) => {
        const found = resolveHandle(handles, args.widgetId);
        if (!found) throw new Error(`there is no widget "${args.widgetId}"`);
        const board =
          input.board.getDashboardById?.(found.dashboardId) ??
          (found.current ? input.board.getDashboard() : null);
        if (!board) throw new Error("that tab no longer exists");
        input.board.putDashboard({
          ...board,
          widgets: board.widgets.filter((widget) => widget.id !== found.widgetId),
          layout: {
            ...board.layout,
            cells: board.layout.cells.filter((cell) => cell.widgetId !== found.widgetId),
          },
        });
        input.board.onChanged?.();
        return {
          removed: true,
          widgetId: found.widgetId,
          dashboardId: found.dashboardId,
          title: found.widget.title,
        };
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
const inventoryKnowledge = (
  input: BuildChatRegistryInput,
  handles: readonly WidgetHandle[],
): Array<{ text: string }> => {
  const facts: Array<{ text: string }> = [];
  const widgets = input.dashboard.widgets;

  if (handles.length === 0) {
    facts.push({ text: "There are no widgets anywhere in this workspace yet." });
  } else {
    /*
     * One list for the whole workspace, grouped by tab.
     *
     * Grouped rather than flat because the tab is the only thing that
     * distinguishes two widgets with the same title, and stated as one list
     * because a tab is where the user filed something, not a limit on what can
     * be discussed. `open_widget` moves the view when it needs to, so nothing
     * here has to be reached by switching first.
     */
    const byTab = new Map<string, WidgetHandle[]>();
    for (const entry of handles) {
      const list = byTab.get(entry.dashboardId) ?? [];
      list.push(entry);
      byTab.set(entry.dashboardId, list);
    }
    const groups = [...byTab.values()].map((list) => {
      const first = list[0]!;
      return (
        `${first.dashboardTitle}${first.current ? " (open now)" : ""}: ` +
        list
          .map((entry) => `"${entry.widget.title}" (id: ${entry.handle}, ${entry.widget.component})`)
          .join("; ")
      );
    });
    facts.push({
      text:
        `WIDGETS — ${handles.length} across ${byTab.size} tab(s). This is the complete ` +
        "list of what exists; there is no widget you have not been told about. Use these " +
        "ids to open, cite or remove one, on any tab — you never have to ask the user to " +
        "switch tabs first, and never have to ask them for an id. " +
        groups.join(" | "),
    });
    if (widgets.length === 0) {
      facts.push({ text: "The tab open right now has no widgets on it." });
    }
    facts.push({
      text:
        "You have full detail (endpoint, fields, what one row is) for the widgets on the " +
        "tab that is open. For any other widget, call `look_up_widget` with its id rather " +
        "than guessing or saying you cannot see it.",
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
      "never claim a widget exists unless it is in the WIDGETS list. " +
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
  const handles = workspaceHandles(
    input.workspace ?? [input.dashboard],
    input.dashboard.id,
  );
  const actions = [
    ...(boardActions(input, handles) ?? []),
    ...(viewActions(handles) ?? []),
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
  const taken = new Set(handles.map((entry) => entry.handle));
  let rosterId = "dashboard";
  for (let n = 2; taken.has(rosterId); n++) rosterId = `dashboard-${n}`;

  registry.register({
    id: rosterId,
    title: input.dashboard.title,
    description:
      "The workspace itself: every widget on every tab, and what can be added.",
    knowledge: [
      ...(input.onScreen ? [{ text: input.onScreen }] : []),
      ...(input.records ? [{ text: input.records }] : []),
      ...inventoryKnowledge(input, handles),
      ...workspaceKnowledge(input),
      ...(input.concierge ? conciergeKnowledge(input.concierge) : []),
    ],
    grid: { minW: 12, minH: 4 },
    actions,
  });

  /*
   * Every widget in the workspace is registered; only the current tab's carry
   * knowledge.
   *
   * The split is what makes registering the whole workspace affordable, and it
   * falls out of how the two prompt blocks are built. `buildKnowledgePrompt`
   * emits only components that HAVE knowledge, and truncates at a budget —
   * so a knowledge-less component costs nothing there. `buildCitationsPrompt`
   * lists any component with a `domAnchor`, one line each — so registering all
   * of them is what makes a widget on another tab citable and navigable at all.
   * The detail for those is a `look_up_widget` call away, which is the same
   * "names always on, fields on demand" rule the endpoint roster follows.
   */
  for (const entry of handles) {
    const cellOf = input.workspace?.find((board) => board.id === entry.dashboardId) ??
      (entry.current ? input.dashboard : undefined);
    const cell = cellOf?.layout.cells.find(
      (candidate) => candidate.widgetId === entry.widgetId,
    );
    const connections = [
      ...new Set(widgetSources(entry.widget).map((source) => source.connection)),
    ];
    registry.register({
      id: entry.handle,
      title: entry.widget.title,
      description: entry.current
        ? `A ${entry.widget.component} on the "${entry.dashboardTitle}" tab, the one open now.`
        : `A ${entry.widget.component} on the "${entry.dashboardTitle}" tab.`,
      tags: [...connections, entry.widget.component, entry.dashboardId],
      /*
       * What a citation chip does when clicked: switch to that tab if needed,
       * then scroll to the tile and pulse it. `data-widget-id` is already on
       * every grid cell and `#/d/<id>` is already how the app routes, so this
       * describes the app rather than adding anything to it.
       */
      domAnchor: {
        selector: selectorFor(entry.widgetId),
        page: pageFor(entry.dashboardId),
      },
      ...(entry.current ? { knowledge: knowledgeFor(entry.widget, input.reports) } : {}),
      grid: {
        minW: cell?.w ?? 4,
        minH: cell?.h ?? 4,
      },
      /*
       * No actions here, and this is a size decision rather than a scoping one.
       *
       * The actions are the same on every widget — the model addresses the
       * dashboard, not one panel — so they used to be attached to all of them
       * "so an action cannot end up reachable from one widget and not
       * another". That fear does not apply: Dash never sets
       * `activeComponentIds`, so `buildHarnessTurn` treats every registered
       * action as a candidate and the roster component alone exposes all of
       * them.
       *
       * What the duplication did instead was multiply the prompt. `per_action`
       * mode emits one tool, schema inlined, per (component, action) pair — so
       * 15 actions across 9 components was 135 near-identical tool schemas at
       * 152 KB, over 90% of the whole prompt, on every turn. Registering the
       * workspace made that worse in exact proportion to how many widgets
       * somebody has, which is the wrong way for a cost to scale.
       */
    });
  }

  return registry;
};
