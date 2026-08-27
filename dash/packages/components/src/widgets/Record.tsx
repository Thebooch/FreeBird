import { isSlotHidden, settingBool, settingNumber } from "@freebirdai/dash-spec";
import { Message, SectionHeader, StatusPill } from "../ui/index.js";
import {
  type RecordEntry,
  highlightsFor,
  recordEntries,
  roleColumn,
  roleColumns,
  titleFor,
} from "../resolve.js";
import type { WidgetRenderProps } from "../types.js";

/**
 * One record, as label and value pairs.
 *
 * The shape a drill-down actually wants. A one-row table puts the labels
 * along the top and the values off the right edge, which is unreadable at the
 * width of a sheet and has nowhere sensible to put a nested object.
 *
 * Nested fields arrive already flattened — `inferShape` emits `Address.City`
 * next to `Address` — so the object parent is dropped and its children are
 * shown indented under a shared label.
 */
export const Record = (props: WidgetRenderProps): JSX.Element => {
  const bound = roleColumns(props.roles, "fields");
  const names = bound.length > 0 ? bound : props.columns.map((column) => column.name);

  if (names.length === 0) return <Message>This widget has no fields bound.</Message>;
  if (props.rows.length === 0) return <Message>No record found.</Message>;

  const look = props.presentation;
  const all = recordEntries(props, names);
  /*
   * A blank row still tells you the field exists, which is often the point on
   * a record — so hiding empties is opt-in rather than the default.
   */
  const entries = settingBool(look, "hideEmpty", false)
    ? all.filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== "")
    : all;
  // A record shows one row, so its highlights are the first row's.
  const hits = highlightsFor(props, 0);
  const rowHits = hits.filter((hit) => !hit.field);
  const titleColumn = roleColumn(props.roles, "title");
  const heading = titleColumn ? props.rows[0]?.[titleColumn] : undefined;

  const sections = groupEntries(entries, props.groups);
  const columns = Math.max(1, Math.min(3, Math.round(settingNumber(look, "columns", 1))));

  const pair = (entry: RecordEntry): JSX.Element => (
    <div
      key={entry.name}
      className={entry.nested ? "dash-record__pair dash-record__pair--nested" : "dash-record__pair"}
    >
      {/*
       * The name the API uses, one hover away — the same contract the table
       * header follows. It used to repeat the label, which told a reader
       * nothing and told somebody debugging a binding less.
       */}
      <dt title={entry.name}>{entry.label}</dt>
      {/* The tooltip keeps the whole value: the pair shows a summary. */}
      <dd title={titleFor(entry.value)}>
        {entry.formatted}
        {hits
          .filter((hit) => hit.field === entry.name)
          .map((hit) => (
            <span key={hit.id} className="dash-cell-pill">
              <StatusPill tone={hit.tone} label={hit.label} />
            </span>
          ))}
      </dd>
    </div>
  );

  return (
    <div className="dash-record-scroll" data-density={look?.density ?? "cozy"}>
      {!isSlotHidden(look, "heading") &&
        heading !== undefined &&
        heading !== null &&
        heading !== "" && <p className="dash-record__heading">{String(heading)}</p>}
      {!isSlotHidden(look, "marks") && rowHits.length > 0 && (
        <p className="dash-record__marks">
          {rowHits.map((hit) => (
            <StatusPill key={hit.id} tone={hit.tone} label={hit.label} />
          ))}
        </p>
      )}

      {sections.map((section) => (
        <section className="dash-record__section" key={section.title ?? "__rest"}>
          {section.title && <SectionHeader title={section.title} />}
          <dl className="dash-record" data-columns={columns}>
            {section.entries.map(pair)}
          </dl>
        </section>
      ))}
    </div>
  );
};

interface Section {
  /** Absent for the catch-all that holds everything no group claimed. */
  readonly title?: string;
  readonly entries: readonly RecordEntry[];
}

/**
 * Split the fields into the sections the drill-down asked for.
 *
 * Anything no group names lands in a trailing unnamed section rather than
 * being dropped. Grouping is a way to arrange what is there, so a field
 * somebody forgot to list must still appear — the alternative is data that
 * looks like it went missing, which is the exact failure this product exists
 * to avoid.
 */
const groupEntries = (
  entries: readonly RecordEntry[],
  groups: WidgetRenderProps["groups"],
): readonly Section[] => {
  if (!groups || groups.length === 0) return [{ entries }];

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const claimed = new Set<string>();
  const sections: Section[] = [];

  for (const group of groups) {
    const found = group.fields
      .map((field) => byName.get(field))
      .filter((entry): entry is RecordEntry => entry !== undefined);
    for (const entry of found) claimed.add(entry.name);
    // A group whose fields the response did not produce is left out entirely
    // rather than rendered as an empty heading.
    if (found.length > 0) sections.push({ title: group.title, entries: found });
  }

  const rest = entries.filter((entry) => !claimed.has(entry.name));
  if (rest.length > 0) sections.push({ entries: rest });
  return sections;
};
