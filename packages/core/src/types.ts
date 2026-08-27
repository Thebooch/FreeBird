/**
 * Core shared types for FreeBird.
 *
 * These are the framework-agnostic primitives that every other package builds on.
 * No runtime validation here — see `components/schema.ts` for zod schemas.
 */

import type { z } from "zod";
import type { ActionPreflightResult } from "./actions/types.js";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type OrientationHint = "wide" | "tall" | "square" | "auto";

/**
 * A discrete named size a component can occupy in the grid.
 *
 * Register components with an ordered `sizes` array (smallest → largest).
 * The solver picks from these based on how many other components need to fit:
 *   - Solo component → largest available (fills dead space)
 *   - Multiple components → starts at `preferredSize`, drops smaller if needed
 *   - Never shrinks below `minSize`
 *
 * @example
 * sizes: [
 *   { name: "compact",  w: 3,  h: 3, aspect: "square" },
 *   { name: "normal",   w: 6,  h: 4, aspect: "wide"   },
 *   { name: "expanded", w: 12, h: 5, aspect: "wide"   },
 * ],
 * preferredSize: "normal",  // aim for this in multi-component layouts
 * minSize: "compact",       // never drop below compact
 */
export interface SizeVariant {
  /** Stable name referenced by `preferredSize` / `minSize`. */
  name: string;
  /** Exact column span in the 12-column grid. */
  w: number;
  /** Exact row span. */
  h: number;
  /**
   * Visual orientation hint forwarded to the rendered component so it can
   * adapt its internal layout (e.g. switch from a bar chart to a sparkline).
   */
  aspect?: OrientationHint;
}

/**
 * Grid constraints declared by the component author. The layout solver is
 * bound by these — the LLM cannot force a layout that violates them.
 *
 * You can use either API or both together:
 *
 * **Explicit sizes (preferred)**: declare every discrete size the component
 * supports. The solver picks the best one based on context.
 *
 * **Simple range**: provide `minW`/`minH` and optionally `maxW`/`maxH`.
 * The solver computes a single size from the range.
 */
export interface GridHints {
  // ── Explicit multi-size API ────────────────────────────────────────────────

  /**
   * All supported size variants, ordered **smallest → largest** by convention.
   * When present the solver uses these instead of the min/max range.
   */
  sizes?: SizeVariant[];

  /**
   * Name of the variant to prefer in multi-component layouts.
   * Defaults to the **largest** variant.
   * The solver will try this first, then step down if there is no room.
   */
  preferredSize?: string;

  /**
   * Hard floor — the solver will never use a variant smaller than this.
   * Components that cannot fit at their `minSize` are dropped rather than
   * shrunk further. Defaults to the **smallest** variant.
   */
  minSize?: string;

  // ── Simple single-range API ────────────────────────────────────────────────

  /** Minimum width in grid columns (1..gridCols). Required when `sizes` is absent. */
  minW?: number;
  /** Minimum height in grid rows. Required when `sizes` is absent. */
  minH?: number;
  /** Maximum width in columns. Defaults to gridCols. */
  maxW?: number;
  /** Maximum height in rows. Defaults to unbounded. */
  maxH?: number;
  /** Preferred aspect at render time (used by the range path). */
  defaultAspect?: OrientationHint;
}

/**
 * Where a knowledge item came from on the site. Mirrors {@link ComponentDomAnchor}
 * so citation clicks can resolve knowledge the same navigate-then-highlight way.
 */
export interface KnowledgeSource {
  /** Site-relative path of the page the knowledge lives on, e.g. "/about". */
  page: string;
  /** CSS selector locating the section — usually an id fragment like "#pricing". */
  selector?: string;
  /** Section heading text — human label, used as the citation chip fallback title. */
  heading?: string;
}

/**
 * Information the LLM needs about a component to decide whether/how to use it.
 * Kept small and stable — one knowledge item per key insight.
 *
 * Items may also exist site-wide (not attached to any component) via
 * `ComponentRegistry.setKnowledge` — those need an `id` to be citable and a
 * `source` for citation clicks to resolve to a page section.
 */
export interface KnowledgeItem {
  /** Stable identifier — required for the item to be citable via [[cite:id]]. */
  id?: string;
  /** Short human label shown on citation chips. */
  title?: string;
  /** Free-form text shown to the LLM and to end users via InfoTrigger. */
  text: string;
  /** Optional category so the UI can group items ("Tips", "Gotchas", etc.). */
  category?: string;
  /** Page/section the item was extracted from — enables citation deep-links. */
  source?: KnowledgeSource;
}

/**
 * Context passed to `dataSource()` when a digest is being built.
 * The host app can put auth/tenant info on it via the server's getAuthContext hook.
 */
export interface DataSourceContext<TAuth = unknown> {
  /** The tab whose digest is being generated. */
  tabId: string;
  /** User-supplied auth context from the server's getAuthContext hook. */
  auth: TAuth;
  /** When the digest run started (UTC). */
  runAt: Date;
  /** Props the component will be rendered with during this snapshot. */
  props: Record<string, unknown>;
}

/**
 * A component definition registered by the host application.
 *
 * TRender is intentionally generic so the `@freebirdai/react` package can narrow
 * it to `ReactElement` without pulling React into `@freebirdai/core`.
 */
export interface ComponentDefinition<
  TProps = Record<string, unknown>,
  TRender = unknown,
  TAuth = unknown,
> {
  /** Stable identifier used in layout plans, knowledge lookups, tags. */
  id: string;
  /** Human-readable title. Shown to the LLM and (optionally) to users. */
  title: string;
  /** Short description — this is the single most important LLM prompt input. */
  description: string;
  /** Tags used for cross-chat reference retrieval and organization. */
  tags?: string[];
  /** Explanatory knowledge items shown via InfoTrigger and fed to the LLM. */
  knowledge?: KnowledgeItem[];
  /** Grid constraints. */
  grid: GridHints;
  /** Optional zod schema for props. When present, props are validated before render. */
  propsSchema?: z.ZodType<TProps>;
  /**
   * Called during digest generation. Should return a JSON-serializable snapshot
   * of whatever data the component shows so the LLM can summarize it.
   * If omitted, the component is excluded from digests.
   */
  dataSource?: (ctx: DataSourceContext<TAuth>) => Promise<unknown> | unknown;
  /** The actual renderer. Only consumed by UI packages (react, future vue). */
  render?: (props: TProps) => TRender;
  /**
   * Optional structured actions the LLM can invoke on behalf of the user.
   * Each action carries its own Zod schema for typed argument extraction
   * and (optionally) a `readCurrent` to capture before-snapshots for
   * audit / revert workflows.
   */
  actions?: ActionDefinition<any, any, TAuth>[];
  /**
   * Processing tool ids from {@link ChatEngineOptions.processingToolCatalog}
   * exposed when this component is active.
   */
  processingTools?: string[];
  /**
   * Marks this component as reviewable. The host supplies items (via the
   * `review_items` tool execution) and renders the review surface; FreeBird
   * owns the LLM contract (prompt, item shape, escalation bridge).
   */
  review?: import("./review/types.js").ReviewCapability;
  /**
   * MCP exposure policy for this component. When omitted, components with a
   * `dataSource` are readable via MCP when the server mode allows reads.
   */
  mcp?: McpComponentPolicy;
  /**
   * DOM-anchoring metadata for components backed by a page region — generic
   * (host-agnostic) so `@freebirdai/core` never needs to know about
   * manifest/DOM concepts directly. Manifest-compiled `dom-region`
   * components get this bridged in from `source.selector`/`source.page` by
   * `compileServerRegistry` (`@freebirdai/manifest`). Used to resolve citation
   * clicks into a navigate-then-highlight action client-side.
   */
  domAnchor?: ComponentDomAnchor;
}

export interface ComponentDomAnchor {
  /** CSS selector locating the component's root on the page. */
  selector: string;
  /** Path this selector lives on, when not the current page. */
  page?: string;
}

/** MCP exposure policy for a component's read surface. */
export interface McpComponentPolicy {
  /** When false, `dataSource` is not readable via MCP. Default true. */
  read?: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Confirmation policy for an action:
 *   - "none":    auto-execute as soon as args are valid (fire-and-forget toggles)
 *   - "preview": render the configured preview UI and require a click (default)
 *   - "strict":  same as "preview" but also requires a typed confirmation token
 *                 (not enforced by the harness in v1; reserved for future use).
 */
export type ConfirmationPolicy = "none" | "preview" | "strict";

/**
 * How to render the confirmation preview before an action runs:
 *   - "text":      LLM streams a natural-language summary into the chat
 *   - "component": render the registered default `freebird.action-preview`
 *                   component (or whatever the host swaps in for that id)
 *   - { component: "my-id" }: render a user-registered component by id
 */
export type PreviewStrategy =
  | "text"
  | "component"
  | { component: string };

/**
 * Context passed to action handlers and to `readCurrent`.
 * Hosts can extend `auth` via the server's `getAuthContext` hook.
 */
export interface ActionContext<TAuth = unknown> {
  auth: TAuth;
  sessionId: string;
}

/**
 * A typed action that the LLM can invoke on behalf of the user.
 *
 * The Zod `schema` is the contract the LLM extracts arguments against —
 * `.describe()` strings on each field are the **single most important LLM
 * prompt input** and should not be skipped.
 *
 * @example
 * {
 *   id: "update_preferences",
 *   description: "Update the user's notification preferences",
 *   schema: z.object({
 *     email: z.boolean().optional().describe("Email notifications on/off"),
 *     sms:   z.boolean().optional().describe("SMS notifications on/off"),
 *   }),
 *   readCurrent: async (args, ctx) => fetchPrefs(ctx.auth.userId),
 *   handler: async (args, ctx) => savePrefs(ctx.auth.userId, args),
 *   requiresConfirmation: "preview",
 * }
 */
export interface ActionDefinition<
  TArgs = Record<string, unknown>,
  TResult = unknown,
  TAuth = unknown,
> {
  /** Stable id, unique within the owning component. `[a-zA-Z0-9_-]+`. */
  id: string;
  /** One-sentence description fed to the LLM. */
  description: string;
  /** Zod schema for the action's arguments. */
  schema: z.ZodType<TArgs>;
  /**
   * Optional **authorization gate**, called server-side after Zod validation
   * passes and before `readCurrent` / `handler`. Use this to enforce row-level
   * permissions, tenant/scope checks, feature flags, etc.
   *
   * Returning `false` (or `{ ok: false, ... }`) rejects the action with HTTP
   * 403 and emits an `action.unauthorized` server event for audit.
   * `requiresConfirmation: "none"` actions still go through this gate.
   *
   * @example
   *   authorize: async (args, ctx) => {
   *     return ctx.auth.role === "admin"
   *       || (await canEditChannel(ctx.auth.userId, args.channelId));
   *   },
   */
  authorize?: (
    args: TArgs,
    ctx: ActionContext<TAuth>,
  ) =>
    | boolean
    | { ok: false; reason?: string; status?: number }
    | Promise<boolean | { ok: false; reason?: string; status?: number }>;
  /**
   * Optional: read the current values that this action will overwrite, so
   * audit events include a `before` snapshot. The harness calls this BEFORE
   * `handler()` runs. Returns a JSON-serializable shape whose keys typically
   * overlap with the action's args.
   *
   * Failures here are non-fatal: the action proceeds with `before: null`
   * and the harness emits a warning.
   */
  readCurrent?: (
    args: TArgs,
    ctx: ActionContext<TAuth>,
  ) => Promise<unknown> | unknown;
  /**
   * Optional pre-execution check after args validate. Use to resolve human
   * names to ids or detect missing prerequisite records. When this returns
   * `{ ok: false, blockers }`, the action enters the `blocked` phase until
   * remediation completes.
   */
  preflight?: (
    args: TArgs,
    ctx: ActionContext<TAuth>,
  ) => ActionPreflightResult | Promise<ActionPreflightResult>;
  /** The actual mutation. Returned value is included on `action.executed`. */
  handler: (
    args: TArgs,
    ctx: ActionContext<TAuth>,
  ) => Promise<TResult> | TResult;
  /** @default "preview" */
  requiresConfirmation?: ConfirmationPolicy;
  /** @default "component" */
  previewStrategy?: PreviewStrategy;
  /**
   * Optional structured confirmation copy for the pending-action card.
   * When omitted, {@link deriveActionPreview} builds title/summary/rows from
   * the Zod schema and current args.
   */
  preview?: (
    args: TArgs,
    ctx: { label?: string },
  ) => import("./actions/preview.js").ActionPreviewContent;
  /**
   * Processing tool ids from {@link ChatEngineOptions.processingToolCatalog}
   * exposed while this action is pending (collecting / blocked / confirmation).
   */
  processingTools?: string[];
  /**
   * MCP exposure policy for this action. When omitted, the action is exposed
   * when the server mode allows writes and `expose` is not set to false.
   */
  mcp?: McpActionPolicy;
}

/** MCP exposure policy for an action. */
export interface McpActionPolicy {
  /** When false, the action is hidden from MCP tool catalog. Default true. */
  expose?: boolean;
  /**
   * When true, MCP must pass a confirmation token from `freebird_prepare_action`
   * even when `requiresConfirmation` is `"none"`.
   */
  requireConfirmation?: boolean;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A single placed component in the grid. */
export interface GridCell {
  /** Instance id unique within a layout plan. */
  instanceId: string;
  /** Component id pointing at the registry. */
  componentId: string;
  /** Props to render with. */
  props: Record<string, unknown>;
  /** Placement in the 12-col grid. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** True if the user locked this cell (won't be replaced by re-plans). */
  locked: boolean;
  /** Relative importance (1..5) used by the solver to order placement. */
  importance: number;
  /** Orientation hint applied for this instance. */
  orientation: OrientationHint;
  /**
   * The name of the `SizeVariant` the solver chose for this cell.
   * Only present when the component has an explicit `sizes` array.
   * Render functions can use this to adapt their internal layout.
   */
  sizeVariant?: string;
}

export interface LayoutPlan {
  /** Total columns in the grid the cells were placed against. */
  gridCols: number;
  cells: GridCell[];
}

/**
 * What the LLM emits via the `plan_layout` tool call. The deterministic solver
 * turns this into a real `LayoutPlan`.
 */
export interface LayoutIntent {
  items: Array<{
    componentId: string;
    props?: Record<string, unknown>;
    importance?: number;
    orientationHint?: OrientationHint;
  }>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface Reference {
  /** Session the reference was pulled from. */
  sourceSessionId: string;
  /** Optional specific message within that session. */
  sourceMessageId?: string;
  /** If the reference is about a specific component. */
  componentId?: string;
  /** Tag that triggered the retrieval. */
  tag?: string;
  /** Human-readable reason the reference is relevant. */
  reason: string;
}

/** Dashboard widget the user can open from a read-only chat reply. */
export interface WorkspaceCitation {
  componentId: string;
}

/**
 * A registered component or site knowledge item the assistant's reply drew
 * on — rendered as a clickable chip in the chat; clicking it navigates to
 * (if needed), scrolls to, and highlights the source, reusing the same
 * client-side mechanism as an explicit `start_action` local-dom call.
 * Resolved server-side from `[[cite:id]]` markers the model appends to its
 * reply (see `ChatEngineOptions.citations`) — distinct from
 * {@link WorkspaceCitation}, which is unrelated (citations attached to
 * processing-tool results).
 */
export interface ComponentCitation {
  /** Component id — or knowledge item id when `kind` is "knowledge". */
  componentId: string;
  title: string;
  directive: "highlight" | "scroll-to";
  selector?: string;
  page?: string;
  /**
   * What the citation resolves to. Absent on payloads persisted before
   * knowledge citations existed — treat absent as "component".
   */
  kind?: "component" | "knowledge";
}

export interface ChatSession {
  id: string;
  title?: string;
  /** Optional free-form topic (e.g. "Q3 review"). */
  topic?: string;
  tags: string[];
  userId?: string;
  /** The active layout plan this session is driving, if any. */
  activeLayoutId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  /**
   * Cross-chat references the assistant pulled in. UI renders these as chips.
   */
  references: Reference[];
  /** If this message was the result of a tool call (e.g. plan_layout), the name. */
  toolName?: string;
  /**
   * Raw JSON payload for tool calls / tool results. Carries
   * `{ citations?: ComponentCitation[] }` when `ChatEngineOptions.citations`
   * is enabled and the reply cited any registered components — same
   * untyped-JSON convention `workspaceCitations` already uses, deliberately
   * not a first-class field so this needs no DB adapter/migration changes
   * (`toolPayload` is already untyped JSONB/Json in both SQL adapters).
   */
  toolPayload?: unknown;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Custom tabs + digests
// ---------------------------------------------------------------------------

export interface DigestConfig {
  /** Cron expression, in UTC, describing when the digest fires. */
  intervalCron: string;
  /** Destination email address. */
  email: string;
  /** Output format. "markdown" and "html" are rendered server-side; "json" is raw. */
  format: "markdown" | "html" | "json";
  /** Optional subject-line template. `{title}` and `{date}` are substituted. */
  subjectTemplate?: string;
  /** Extra prompt text appended to the LLM summarization instructions. */
  extraPrompt?: string;
  /** UTC time of the last successful send — managed by the engine. */
  lastRunAt?: Date;
  /** UTC time of the next scheduled run — managed by the engine. */
  nextRunAt?: Date;
}

export interface CustomTab {
  id: string;
  /** User-facing label shown in navigation. */
  title: string;
  /** Optional URL slug. Server integrations can use it to build routes. */
  slug?: string;
  /** Owner scoping (usually userId or orgId). */
  ownerId?: string;
  /** The frozen layout. By invariant, every cell has `locked: true`. */
  layout: LayoutPlan;
  /** Optional digest configuration. */
  digest?: DigestConfig;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Auth scoping
// ---------------------------------------------------------------------------

/**
 * Every DB operation takes an AuthContext so multi-tenant hosts can scope rows.
 * The host app supplies this via the server's `getAuthContext(req)` hook.
 */
export interface AuthContext {
  userId?: string;
  orgId?: string;
  /** Free-form bag the host can read in its adapter. */
  extra?: Record<string, unknown>;
}
