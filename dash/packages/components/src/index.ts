export { Bar } from "./charts/Bar.jsx";
export { Distribution } from "./charts/Distribution.jsx";
export { Gauge } from "./charts/Gauge.jsx";
export { Sparkline } from "./charts/Sparkline.jsx";
export { TimeSeries } from "./charts/TimeSeries.jsx";

export { Board } from "./widgets/Board.jsx";
export { Calendar } from "./widgets/Calendar.jsx";
export { Cards } from "./widgets/Cards.jsx";
export { Feed } from "./widgets/Feed.jsx";
export { Funnel } from "./widgets/Funnel.jsx";
export { Progress } from "./widgets/Progress.jsx";
export { Timeline } from "./widgets/Timeline.jsx";
export { List } from "./widgets/List.jsx";
export { MetricRow } from "./widgets/MetricRow.jsx";
export { Stat } from "./widgets/Stat.jsx";
export { StatusGrid } from "./widgets/StatusGrid.jsx";
export { Record } from "./widgets/Record.jsx";
export { RecordHeader } from "./widgets/RecordHeader.jsx";
export { Table } from "./widgets/Table.jsx";
export {
  columnTotals,
  effectiveSort,
  filterRows,
  nextSort,
  sortRows,
  visibleColumns,
} from "./widgets/tableModel.js";
export type { ColumnTotal, SortDirection, SortState } from "./widgets/tableModel.js";
export {
  bucketBy,
  byRecency,
  dayKey,
  daysCovered,
  funnelStages,
  groupByDay,
  instantOf,
  monthGrid,
} from "./widgets/collectionModel.js";
export type { Bucket, CalendarDay, DatedRow, DayGroup, FunnelStage } from "./widgets/collectionModel.js";

export {
  SERIES_DARK,
  SERIES_LIGHT,
  SERIES_SLOTS,
  STATUS_ICONS,
  STATUS_TONES,
  seriesVar,
  statusTone,
} from "./palette.js";
export type { StatusTone } from "./palette.js";

export { DashStyles, Legend, PLOT_MARGIN, Tooltip, useMeasure } from "./primitives.jsx";
export type { LegendEntry, Size, TooltipRow } from "./primitives.jsx";

export * from "./ui/index.js";

export { COMPONENTS, getComponent } from "./registry.js";
export type { RegisteredComponent } from "./registry.js";

export {
  defaultAggregationFor,
  dominantTone,
  formatFor,
  highlightsFor,
  humanLabel,
  labelOf,
  isNumericColumn,
  makeFormatter,
  numericValues,
  recordEntries,
  roleColumn,
  roleColumns,
  semanticFor,
  titleFor,
} from "./resolve.js";
export type { Formatter, RecordEntry } from "./resolve.js";

export {
  bandScale,
  barPath,
  linePath,
  linearScale,
  niceDomain,
  niceTicks,
  timeTickFormatter,
  timeTicks,
} from "./scales.js";
export type { BandScale, LinearScale } from "./scales.js";

export { OTHER_KEY, buildCategories, buildSeries } from "./series.js";
export type { BuildSeriesInput, BuiltSeries, CategoryDatum, SeriesPoint } from "./series.js";

export { DASH_STYLES } from "./theme.js";
export type { WidgetComponent, WidgetRenderProps } from "./types.js";
