import { isSlotHidden, settingBool, settingNumber } from "@freebirdai/dash-spec";
import { useState } from "react";
import { KEY_FIELD_CAP, rankKeyFields } from "../keyFields.js";
import { Icon, Menu, Message, SectionHeader, StatusPill } from "../ui/index.js";
import {
  type RecordEntry,
  highlightsFor,
  recordEntries,
  referenceText,
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
  const [open, setOpen] = useState(false);
  const bound = roleColumns(props.roles, "fields");
  const names = bound.length > 0 ? bound : props.columns.map((column) => column.name);
  const titleColumn = roleColumn(props.roles, "title");

  if (names.length === 0 && !props.detailFields?.length) {
    return <Message>This widget has no fields bound.</Message>;
  }
  if (props.rows.length === 0) return <Message>No record found.</Message>;

  /*
   * Key fields first, the rest behind "All fields".
   *
   * A record type that says which fields are key splits them itself
   * (`detailFields`). One that does not, with more fields than fit above the
   * fold, is split here by `rankKeyFields` — names, statuses, dates and money
   * ahead of ids, flags and who-changed-it-when — so the top is never empty
   * and never everything. A short record shows every field, as before.
   */
  const split = splitFields(props, names, titleColumn);
  const look = props.presentation;
  const all = recordEntries(props, split.keys);
  /*
   * The key fields say what is there. An empty one — or the API's word for
   * empty, `NotSet` — says nothing, so it waits under "All fields", where an
   * empty row is the point: it tells you the field exists. A record with no
   * "All fields" keeps its empties unless asked, for the same reason.
   */
  const entries =
    split.more.length > 0 || settingBool(look, "hideEmpty", false)
      ? all.filter((entry) => !isEmpty(entry))
      : all;
  const more = recordEntries(props, split.more);
  // A record shows one row, so its highlights are the first row's.
  const hits = highlightsFor(props, 0);
  const rowHits = hits.filter((hit) => !hit.field);
  const heading = titleColumn ? props.rows[0]?.[titleColumn] : undefined;

  const sections = groupEntries(entries, props.groups);
  const columns = Math.max(1, Math.min(3, Math.round(settingNumber(look, "columns", 1))));

  /**
   * What a field's value reads as.
   *
   * A record is where a bare id is least forgivable: a work order opening on
   * `VendorId 4711` beside forty of its neighbours is the wall of numbers this
   * whole layer exists to replace. The precedence — the name on the row, then
   * one that was fetched, then the kind of record — is `referenceText`'s, the
   * same function the table cell calls.
   */
  const valueOf = (entry: RecordEntry, empty = "—"): JSX.Element | string => {
    if (isEmpty(entry)) return <span className="dash-nil">{empty}</span>;
    if (!entry.reference) return entry.formatted;

    const resolved = referenceText({
      row: props.rows[0] ?? {},
      column: entry.name,
      reference: entry.reference,
      ...(props.referenceNames ? { names: props.referenceNames } : {}),
      formatted: entry.formatted,
    });
    const target = resolved.target;
    if (!resolved.canOpen || !target || !props.onOpenReference) return resolved.text;

    return (
      <button
        type="button"
        className="dash-ref"
        onClick={(event) => {
          event.stopPropagation();
          props.onOpenReference?.(target);
        }}
      >
        {resolved.text}
      </button>
    );
  };

  /** Move this field to the other list, for everybody who opens one of these. */
  const moveMenu = (entry: RecordEntry, to: "key" | "all"): JSX.Element | null =>
    props.onMoveField ? (
      <Menu
        floating
        label={`Options for ${entry.label}`}
        testId={`record-field-menu-${entry.name}`}
        items={[
          {
            id: "move",
            label: to === "key" ? "Move to key fields" : "Move to all fields",
            onSelect: () => props.onMoveField?.(entry.name, to),
          },
        ]}
      />
    ) : null;

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
      <dt title={entry.name}>
        {entry.label}
        {/*
         * What the field means, under its name.
         *
         * Inline rather than in a tooltip: a description nobody can discover
         * is a description nobody reads, and a record page is exactly where
         * somebody is reading one thing carefully. It stays out of tables,
         * which have no room for it.
         */}
        {entry.description && <span className="dash-record__hint">{entry.description}</span>}
      </dt>
      {/* The tooltip keeps the whole value: the pair shows a summary. */}
      <dd title={titleFor(entry.value)}>
        {valueOf(entry)}
        {split.more.length > 0 && <span className="dash-record__tools">{moveMenu(entry, "all")}</span>}
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

      {more.length > 0 && (
        /*
         * Collapsed by default: these are the fields somebody looks up, not
         * the ones they read. Compact, empties included ("Not set"), each
         * with the name the API sends it under, for whoever is matching the
         * screen against the API's documentation.
         */
        <details
          className="dash-record__more"
          data-testid="record-all-fields"
          open={open}
          onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="dash-record__more-summary">
            <Icon name="chevron-right" size={14} className="dash-record__more-chevron" />
            All fields ({more.length})
          </summary>
          {open && (
            <dl className="dash-record dash-record--compact" data-columns={2}>
              {more.map((entry) => (
                <div key={entry.name} className="dash-record__pair">
                  <dt title={entry.description ?? entry.name}>
                    {entry.label}
                    <span className="dash-record__api">{entry.name}</span>
                  </dt>
                  <dd title={titleFor(entry.value)}>
                    {valueOf(entry, "Not set")}
                    <span className="dash-record__tools">
                      {props.onEditField && (
                        <button
                          type="button"
                          className="dash-iconbtn dash-record__edit"
                          aria-label={`Edit ${entry.label}`}
                          title={`Edit ${entry.label}`}
                          onClick={() => props.onEditField?.(entry.name)}
                          data-testid={`record-field-edit-${entry.name}`}
                        >
                          <Icon name="pencil" size={14} />
                        </button>
                      )}
                      {moveMenu(entry, "key")}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      )}
    </div>
  );
};

/** Nothing there, or the API's way of saying nothing (`NotSet`, `0001-01-01`). */
const isEmpty = (entry: RecordEntry): boolean =>
  entry.value === null || entry.value === undefined || entry.value === "" || entry.formatted === "—";

/** A short record shows every field; past this many, the rest go under "All fields". */
const SPLIT_ABOVE = KEY_FIELD_CAP + 2;

/**
 * Which fields lead and which wait under "All fields".
 *
 * The record type's own split when it gave one; otherwise the ranking, and
 * only for a record long enough to need it.
 */
export const splitFields = (
  props: Pick<WidgetRenderProps, "columns" | "detailFields">,
  names: readonly string[],
  titleColumn: string | undefined,
): { keys: readonly string[]; more: readonly string[] } => {
  if (props.detailFields && props.detailFields.length > 0) {
    const more = props.detailFields.filter((name) => !names.includes(name));
    return { keys: names, more };
  }
  if (names.length <= SPLIT_ABOVE) return { keys: names, more: [] };
  const meta = new Map(props.columns.map((column) => [column.name, column]));
  const keys = rankKeyFields(
    names.map((name) => ({
      key: name,
      semantic: meta.get(name)?.semantic,
      valueType: meta.get(name)?.valueType,
    })),
    titleColumn ? { title: [titleColumn] } : {},
  );
  // Page order, not rank order: the record reads top to bottom as the type lays it out.
  const ordered = names.filter((name) => keys.includes(name));
  return { keys: ordered, more: names.filter((name) => !keys.includes(name)) };
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
