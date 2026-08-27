import type { BuiltinComponentId, ComponentContract, ComponentId } from "@freebirdai/dash-spec";
import { COMPONENT_CONTRACTS } from "@freebirdai/dash-spec";
import { Bar } from "./charts/Bar.jsx";
import { Board } from "./widgets/Board.jsx";
import { Calendar } from "./widgets/Calendar.jsx";
import { Cards } from "./widgets/Cards.jsx";
import { Feed } from "./widgets/Feed.jsx";
import { Funnel } from "./widgets/Funnel.jsx";
import { Progress } from "./widgets/Progress.jsx";
import { Timeline } from "./widgets/Timeline.jsx";
import { Distribution } from "./charts/Distribution.jsx";
import { Gauge } from "./charts/Gauge.jsx";
import { TimeSeries } from "./charts/TimeSeries.jsx";
import type { WidgetComponent } from "./types.js";
import { List } from "./widgets/List.jsx";
import { MetricRow } from "./widgets/MetricRow.jsx";
import { Record } from "./widgets/Record.jsx";
import { RecordHeader } from "./widgets/RecordHeader.jsx";
import { Stat } from "./widgets/Stat.jsx";
import { StatusGrid } from "./widgets/StatusGrid.jsx";
import { Table } from "./widgets/Table.jsx";

export interface RegisteredComponent {
  readonly contract: ComponentContract;
  readonly render: WidgetComponent;
}

/**
 * The contract and the renderer, joined.
 *
 * Contracts live in `@freebirdai/dash-spec` so the server and the authoring agent can
 * validate a binding without React; this module is the only place the two
 * halves meet.
 */
export const COMPONENTS: Readonly<Record<BuiltinComponentId, RegisteredComponent>> = {
  stat: { contract: COMPONENT_CONTRACTS.stat, render: Stat },
  metricRow: { contract: COMPONENT_CONTRACTS.metricRow, render: MetricRow },
  timeseries: { contract: COMPONENT_CONTRACTS.timeseries, render: TimeSeries },
  bar: { contract: COMPONENT_CONTRACTS.bar, render: Bar },
  table: { contract: COMPONENT_CONTRACTS.table, render: Table },
  cards: { contract: COMPONENT_CONTRACTS.cards, render: Cards },
  board: { contract: COMPONENT_CONTRACTS.board, render: Board },
  timeline: { contract: COMPONENT_CONTRACTS.timeline, render: Timeline },
  feed: { contract: COMPONENT_CONTRACTS.feed, render: Feed },
  progress: { contract: COMPONENT_CONTRACTS.progress, render: Progress },
  funnel: { contract: COMPONENT_CONTRACTS.funnel, render: Funnel },
  calendar: { contract: COMPONENT_CONTRACTS.calendar, render: Calendar },
  list: { contract: COMPONENT_CONTRACTS.list, render: List },
  record: { contract: COMPONENT_CONTRACTS.record, render: Record },
  recordHeader: { contract: COMPONENT_CONTRACTS.recordHeader, render: RecordHeader },
  distribution: { contract: COMPONENT_CONTRACTS.distribution, render: Distribution },
  statusGrid: { contract: COMPONENT_CONTRACTS.statusGrid, render: StatusGrid },
  gauge: { contract: COMPONENT_CONTRACTS.gauge, render: Gauge },
};

/**
 * The renderer for an id, or undefined when nothing supplies one.
 *
 * Undefined is reachable now that component ids are open names: a widget may
 * legitimately reference a component that arrives as a part rather than from
 * this table, and callers have to say so rather than crash.
 */
export const getComponent = (id: ComponentId): RegisteredComponent | undefined =>
  (COMPONENTS as Readonly<Record<string, RegisteredComponent>>)[id];
