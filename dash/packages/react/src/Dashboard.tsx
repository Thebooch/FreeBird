import { DASH_STYLES } from "@freebirdai/dash-components";
import type { AdapterRegistry } from "@freebirdai/dash-adapters";
import type { DashboardSpec, FieldLabels, LayoutCell } from "@freebirdai/dash-spec";
import { Button } from "@freebirdai/dash-components";
import { type ReactNode, useEffect } from "react";
import { DashboardGrid } from "./DashboardGrid.jsx";
import { RecordPage } from "./RecordPage.jsx";
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
  editing,
  onEditingChange,
  onAutoArrange,
  onCustomiseWidget,
  onOpenRecordPage,
  record,
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
        {record ? (
          <>
            {toolbar}
            <RecordPage widgetId={record.widgetId} row={record.row} onBack={record.onBack} />
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
          {...(editing !== undefined ? { editing } : {})}
        />
          </>
        )}
      </div>
    </DashboardProvider>
  );
};
