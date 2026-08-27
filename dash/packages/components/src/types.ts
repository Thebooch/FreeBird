import type { ColumnMeta, FieldGroup, FormatSpec, Presentation } from "@freebirdai/dash-spec";
import type { Row, RowHighlight } from "@freebirdai/dash-runtime";

export interface WidgetRenderProps {
  readonly rows: readonly Row[];
  readonly columns: readonly ColumnMeta[];
  /** role → column name (or names, for a multi role). */
  readonly roles: Readonly<Record<string, string | readonly string[]>>;
  readonly format: Readonly<Record<string, FormatSpec>>;
  readonly title: string;
  /** Injected clock, so relative times are reproducible. */
  readonly now: number;
  readonly locale?: string;
  readonly timeZone?: string;
  /**
   * Every distinct series key seen for this widget, not just the ones in the
   * current rows. Colour follows the entity, never its rank — passing this
   * keeps a series its own hue when a filter removes its neighbours.
   */
  readonly seriesOrder?: readonly string[];
  /** Set on the one widget a view leads with; renders the value at hero size. */
  readonly hero?: boolean;
  /**
   * Open the record behind a row. Absent when the widget has no drill-down,
   * and components must stay purely presentational when it is — no cursor
   * change, no hover affordance, nothing that promises an interaction that
   * would not happen.
   */
  readonly onSelectRow?: (row: Row) => void;
  /**
   * Rows the widget wants attention drawn to, index-parallel to `rows`.
   *
   * Optional and purely additive, exactly like `onSelectRow`: a component that
   * ignores it behaves as it always did. Charts do ignore it, deliberately —
   * a highlight is a statement about a record, and after a `group` step there
   * are no records left, only buckets.
   */
  readonly highlights?: readonly (readonly RowHighlight[])[];
  /**
   * How this component should be drawn, already resolved across every layer.
   *
   * Optional and purely additive, like `onSelectRow` and `highlights`: a
   * component that ignores it renders exactly as it always did, so the nine
   * that shipped before this existed needed no changes to keep working.
   */
  readonly presentation?: Presentation;
  /**
   * Field sections, for a record view that groups its fields.
   *
   * An explicit prop rather than a presentation setting: settings are scalars
   * so a list of `{title, fields}` cannot live there, and grouping is decided
   * per drill-down rather than per component anyway.
   */
  readonly groups?: readonly FieldGroup[];
}

export type WidgetComponent = (props: WidgetRenderProps) => JSX.Element;
