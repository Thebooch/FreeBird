import { DASH_STYLES } from "@freebirdai/dash-components";
import type { AdapterRegistry } from "@freebirdai/dash-adapters";
import type {
  DashboardSpec,
  EntityLinkView,
  EntityPageView,
  FieldLabels,
  LayoutCell,
  RecordOverride,
} from "@freebirdai/dash-spec";
import { Button } from "@freebirdai/dash-components";
import { type ReactNode, useEffect } from "react";
import { DashboardGrid } from "./DashboardGrid.jsx";
import { EntityRecordPage } from "./EntityRecordPage.jsx";
import { RecordPage } from "./RecordPage.jsx";
import type { OpenReference } from "./entityDetail.js";
import { ParamBar } from "./ParamBar.jsx";
import { DashboardProvider } from "./context.jsx";
import type { PresentationSources } from "./presentation.js";
import { DASH_REACT_STYLES } from "./styles.js";

const STYLE_ID = "dash-styles";

/**
 * Token overrides as a CSS block.
 *
 * Emitted after the base sheet so it wins on order rather than on specificity.
 * The values were validated when they were parsed — a token name has to be one
 * of ours and a value cannot contain a semicolon or a brace — which is what
 * makes it safe to write them into a stylesheet rather than only into inline
 * styles.
 */
const themeBlock = (tokens: Readonly<Record<string, string>> | undefined): string => {
  const entries = Object.entries(tokens ?? {});
  if (entries.length === 0) return "";
  const body = entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `\n.dash-root {\n${body}\n}\n`;
};

/** One `<style>` for the whole library, so a host app needs no CSS build step. */
const THEME_ID = "dash-theme";

const styleElement = (id: string): HTMLElement => {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement("style");
    element.id = id;
    document.head.appendChild(element);
  }
  return element;
};

/**
 * One `<style>` for the whole library, so a host app needs no CSS build step.
 *
 * Stored token overrides go in a **second** element rather than being appended
 * to the first. The app mounts this twice — once above everything so the empty
 * state has variables, and once inside with the tokens it has since read — and
 * React runs a child's effect before its parent's, so one shared element ends
 * up written last by the copy that has no tokens. That is exactly what
 * happened: the theme was fetched, served, and then silently overwritten.
 * Two elements cannot overwrite each other, and the theme one is appended
 * after, so it wins on order rather than on specificity.
 *
 * An absent `tokens` means "not my job"; an empty object means "clear it".
 */
export const DashStyleSheet = ({
  tokens,
}: {
  /** From the stored `theme` part, when the host has one. */
  readonly tokens?: Readonly<Record<string, string>>;
} = {}): null => {
  useEffect(() => {
    if (typeof document === "undefined") return;
    styleElement(STYLE_ID).textContent = `${DASH_STYLES}\n${DASH_REACT_STYLES}`;
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || tokens === undefined) return;
    styleElement(THEME_ID).textContent = themeBlock(tokens);
  }, [tokens]);

  return null;
};

export interface DashboardProps {
  readonly dashboard: DashboardSpec;
  readonly registry: AdapterRegistry;
  readonly now?: number;
  readonly locale?: string;
  readonly onLayoutChange?: (cells: LayoutCell[]) => void;
  /**
   * Take a widget off this dashboard. Absent means no control is drawn.
   *
   * A callback rather than something the provider does, because the dashboard
   * spec is the host's to own — this component renders it and never edits it.
   */
  readonly onRemoveWidget?: (widgetId: string) => void;
  /** Rendered between the params row and the grid — where the chat drawer goes. */
  readonly toolbar?: ReactNode;
  /**
   * Looks stored outside the spec, from `GET /api/presentation`.
   *
   * Optional: a host that passes nothing gets the shipped defaults, which is
   * what every consumer got before this existed.
   */
  readonly presentation?: PresentationSources;
  /**
   * What each connection calls its fields, keyed by connection id.
   *
   * From `GET /api/connections`, which resolves it out of the API's map. Left
   * out, every field wears the label its own name implies.
   */
  readonly labels?: Readonly<Record<string, FieldLabels>>;
  /**
   * Which of each connection's fields point at other records.
   *
   * From `GET /api/connections`, resolved out of the API's own map alongside
   * the labels. Left out, no column is marked as a link and every value
   * renders as the plain thing it is.
   */
  readonly entityLinks?: Readonly<Record<string, readonly EntityLinkView[]>>;
  /**
   * Whether the board can be rearranged right now.
   *
   * Owned by the host because the toggle lives in the app's own nav, and
   * because a read-only embed must be able to say no.
   */
  readonly editing?: boolean;
  readonly onEditingChange?: (editing: boolean) => void;
  /** Re-pack every widget with the deterministic placer. */
  readonly onAutoArrange?: () => void;
  readonly onCustomiseWidget?: (widgetId: string) => void;
  /** Open a record as a full page. Absent in an embed with no routing. */
  readonly onOpenRecordPage?: (widgetId: string, row: Record<string, unknown>) => void;
  /**
   * Open the record a cell names, rather than the row's own.
   *
   * Absent when the host has nowhere to send it — and then a reference renders
   * as a name in plain text rather than as a control, which is the honest
   * state until there is a page to open.
   */
  readonly onOpenReference?: OpenReference;
  /**
   * A record to show instead of the grid.
   *
   * Rendered inside the provider rather than beside it: the page needs the
   * board's widgets to find its drill-down, and the query cache so a record
   * opened from a row already on screen costs no second request.
   */
  readonly record?: {
    readonly widgetId: string;
    readonly row: Record<string, unknown>;
    readonly onBack: () => void;
  };
  /**
   * A record shown by what it *is*, rather than by which widget showed it.
   *
   * Rendered inside the provider for the same reason `record` is — it needs
   * the query cache, so a record opened from a row already on screen costs no
   * second request — but it belongs to the record type rather than to a
   * widget, so every route into it arrives at the same page.
   */
  readonly entityRecord?: {
    readonly page: EntityPageView;
    readonly connection: string;
    readonly recordId: string;
    readonly onBack: () => void;
    readonly backLabel?: string;
    /** One widget's changes to this layout, when its row is what opened it. */
    readonly override?: RecordOverride;
    /** Offer to rearrange the page. Absent where nothing could store it. */
    readonly onEditLayout?: () => void;
  };
}

export const Dashboard = ({
  dashboard,
  registry,
  now,
  locale,
  onLayoutChange,
  onRemoveWidget,
  toolbar,
  presentation,
  labels,
  entityLinks,
  editing,
  onEditingChange,
  onAutoArrange,
  onCustomiseWidget,
  onOpenRecordPage,
  onOpenReference,
  record,
  entityRecord,
}: DashboardProps): JSX.Element => {
  // Exactly one hero figure per view: the first stat widget leads.
  const hero = dashboard.widgets.find((widget) => widget.component === "stat")?.id;

  return (
    <DashboardProvider
      dashboard={dashboard}
      registry={registry}
      {...(now !== undefined ? { now } : {})}
      {...(locale ? { locale } : {})}
      {...(presentation ? { presentation } : {})}
      {...(labels ? { labels } : {})}
      {...(entityLinks ? { entityLinks } : {})}
    >
      <DashStyleSheet />
      <div className="dash-root dash-page">
        <div className="dash-page__head">
          <h1 className="dash-page__title">{dashboard.title}</h1>
          {dashboard.description && <p className="dash-page__description">{dashboard.description}</p>}
        </div>
        {/*
         * A record replaces the board, params and all: the time range belongs
         * to the collection you came from, and leaving it on screen over one
         * record implies it filters something here.
         */}
        {entityRecord ? (
          <>
            {toolbar}
            <EntityRecordPage
              {...entityRecord}
              {...(onOpenReference ? { onOpenReference } : {})}
            />
          </>
        ) : record ? (
          <>
            {toolbar}
            <RecordPage
              widgetId={record.widgetId}
              row={record.row}
              onBack={record.onBack}
              {...(onOpenReference ? { onOpenReference } : {})}
            />
          </>
        ) : (
          <>
        <ParamBar />
        {toolbar}
        {editing && (
          <div className="dash-edit-banner" role="status">
            <span>
              Drag a widget to move it, pull the corner to resize, and use its menu to remove it.
              Changes save on their own.
            </span>
            <span className="dash-edit-banner__actions">
              {onAutoArrange && (
                <Button size="sm" onClick={onAutoArrange}>
                  Tidy up
                </Button>
              )}
              {onEditingChange && (
                <Button size="sm" tone="primary" onClick={() => onEditingChange(false)}>
                  Done
                </Button>
              )}
            </span>
          </div>
        )}
        <DashboardGrid
          {...(onLayoutChange ? { onLayoutChange } : {})}
          {...(hero ? { heroWidgetId: hero } : {})}
          {...(onRemoveWidget ? { onRemoveWidget } : {})}
          {...(onCustomiseWidget ? { onCustomiseWidget } : {})}
          {...(onOpenRecordPage ? { onOpenRecordPage } : {})}
          {...(onOpenReference ? { onOpenReference } : {})}
          {...(editing !== undefined ? { editing } : {})}
        />
          </>
        )}
      </div>
    </DashboardProvider>
  );
};
