import { useEffect, useState } from "react";
import type {
  Completeness,
  EntityRef,
  RecordFieldView,
  RecordFilterView,
  RecordPageData,
  RecordSummary,
  RelatedRecordViews,
} from "@freebirdai/dash-spec";
import { api } from "./api.js";
import "./EntityBrowser.css";

/** UI asks for a view or a relationship. Scheduling and joins belong to the server. */
function useRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key });
    void read(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error: error instanceof Error ? error.message : "These records could not be loaded.",
          });
      },
    );
    return () => controller.abort();
    // The key is the full read identity; new callback closures are not new reads.
  }, [key]);
  return state.key === key ? state : { key };
}

const text = (field: RecordFieldView): string => {
  const value = field.value;
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (["iso8601", "unix_seconds", "unix_millis"].includes(field.format ?? "")) {
    const date = new Date(
      field.format === "unix_seconds" && typeof value === "number"
        ? value * 1000
        : (value as string | number),
    );
    if (Number.isFinite(date.getTime())) return date.toLocaleString();
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const CompletenessNotice = ({ completeness }: { completeness?: Completeness }) =>
  completeness?.status === "complete" ? null : (
    <p role="status" className="dash-callout">
      {completeness?.status === "partial"
        ? "This is part of the available collection. There may be more records."
        : "These are the records available in this view. The full collection size has not been confirmed."}
    </p>
  );

const Fields = ({
  fields,
  onOpen,
}: {
  fields: readonly RecordFieldView[];
  onOpen?: (ref: EntityRef) => void;
}) => (
  <dl className="dash-entity-fields">
    {fields.map((field) => (
      <div key={field.id}>
        <dt>
          {field.label}
          {field.description && <small>{field.description}</small>}
        </dt>
        <dd>
          {field.reference && onOpen ? (
            <button
              type="button"
              className="dash-sheet__crumb"
              onClick={() => onOpen(field.reference!)}
            >
              {text(field)}
            </button>
          ) : (
            text(field)
          )}
        </dd>
      </div>
    ))}
  </dl>
);

export const EntityRecordList = ({
  records,
  filters = [],
  onOpen,
}: {
  records: readonly RecordSummary[];
  filters?: readonly RecordFilterView[];
  onOpen: (ref: EntityRef) => void;
}) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const controls = filters.flatMap((filter) => {
    const values = new Map<string, string>();
    for (const record of records) {
      const field = record.fields.find((item) => item.id === filter.field && !item.advanced);
      if (!field || !["string", "number", "boolean"].includes(typeof field.value)) continue;
      values.set(JSON.stringify(field.value), text(field));
    }
    // High-cardinality fields remain searchable rather than producing huge menus.
    return values.size && values.size <= 100 ? [{ ...filter, values }] : [];
  });
  const matches = records.filter(
    (record) =>
      [record.title, ...record.fields.filter((field) => !field.advanced).map(text)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()) &&
      controls.every(
        (control) =>
          !selected[control.field] ||
          record.fields.some(
            (field) =>
              field.id === control.field &&
              !field.advanced &&
              JSON.stringify(field.value) === selected[control.field],
          ),
      ),
  );
  return (
    <>
      <label className="dash-entity-search">
        Search these loaded records
        <input
          className="dash-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {controls.length > 0 && (
        <fieldset className="dash-entity-filters">
          <legend>Filter these loaded records</legend>
          {controls.map((control) => (
            <label key={control.field}>
              {control.label}
              {control.description && <small>{control.description}</small>}
              <select
                className="dash-input"
                value={selected[control.field] ?? ""}
                onChange={(event) =>
                  setSelected({ ...selected, [control.field]: event.target.value })
                }
              >
                <option value="">All</option>
                {[...control.values].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      {!matches.length && (
        <p>
          {query || Object.values(selected).some(Boolean)
            ? "No loaded records match these filters."
            : "No records were returned."}
        </p>
      )}
      <ul className="dash-entity-list">
        {matches.map((record, index) => (
          <li key={record.ref ? JSON.stringify(record.ref) : index}>
            {record.ref ? (
              <button
                className="dash-sheet__crumb"
                type="button"
                onClick={() => onOpen(record.ref!)}
              >
                {record.title}
              </button>
            ) : (
              <strong>{record.title}</strong>
            )}
            <Fields
              fields={record.fields.filter((field) => !field.advanced).slice(0, 4)}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ul>
    </>
  );
};

const RelatedList = ({
  result,
  onOpen,
}: {
  result: RelatedRecordViews;
  onOpen: (ref: EntityRef) => void;
}) =>
  result.status !== "ok" ? (
    <p role="status">{result.message ?? "These related records are not available."}</p>
  ) : (
    <>
      <CompletenessNotice completeness={result.completeness} />
      <EntityRecordList records={result.records} filters={result.filters} onOpen={onOpen} />
    </>
  );

const RelatedSection = ({
  page,
  relationship,
  direction,
  onOpen,
}: {
  page: RecordPageData;
  relationship: string;
  direction: "forward" | "reverse";
  onOpen: (ref: EntityRef) => void;
}) => {
  const ref = page.ref!;
  const state = useRead(JSON.stringify([ref, page.version, relationship, direction]), (signal) =>
    api.relatedRecords(ref, relationship, direction, signal),
  );
  if (state.error) return <p role="alert">{state.error}</p>;
  if (!state.data) return <p role="status">Loading related records…</p>;
  return <RelatedList result={state.data} onOpen={onOpen} />;
};

export const EntityPage = ({
  reference,
  onOpen,
  onBack,
}: {
  reference: EntityRef;
  onOpen: (ref: EntityRef) => void;
  onBack: () => void;
}) => {
  const state = useRead(JSON.stringify(reference), (signal) => api.entityPage(reference, signal));
  const [active, setActive] = useState<string | null>(null);
  const page = state.data;
  return (
    <section className="dash-record-page dash-entity-view">
      <button className="dash-control" type="button" onClick={onBack}>
        ‹ Browse records
      </button>
      {state.error && <p role="alert">{state.error}</p>}
      {!state.error && !page && <p role="status">Loading record…</p>}
      {page && (
        <>
          <h2>{page.title}</h2>
          {page.description && <p>{page.description}</p>}
          <Fields fields={page.fields.filter((field) => !field.advanced)} />
          {page.references.map((reference) => {
            const relation = page.relationships.find(
              (item) =>
                item.relationship === reference.relationship && item.direction === "forward",
            );
            return (
              <section key={reference.relationship}>
                <h3>{relation?.title ?? "Related record"}</h3>
                {relation?.description && <p>{relation.description}</p>}
                {reference.result.status === "ok" ? (
                  reference.result.records.map((record, index) =>
                    record.ref ? (
                      <button
                        key={index}
                        className="dash-sheet__crumb"
                        type="button"
                        onClick={() => onOpen(record.ref!)}
                      >
                        {record.title}
                      </button>
                    ) : (
                      <span key={index}>{record.title}</span>
                    ),
                  )
                ) : (
                  <p>{reference.result.message}</p>
                )}
              </section>
            );
          })}
          {page.relationships.length > 0 && (
            <section>
              <h3>Related</h3>
              <div className="dash-entity-relations">
                {[...page.relationships]
                  .sort((a, b) => Number(b.preferred) - Number(a.preferred))
                  .map((relation) => {
                    const key = `${relation.direction}:${relation.relationship}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        className="dash-control"
                        disabled={!relation.available}
                        aria-pressed={active === key}
                        onClick={() => setActive(active === key ? null : key)}
                        title={
                          relation.available
                            ? relation.description
                            : "This relationship is known, but a reliable way to retrieve it has not been verified."
                        }
                      >
                        {relation.title}
                      </button>
                    );
                  })}
              </div>
              {page.relationships
                .filter(
                  (relation) =>
                    active === `${relation.direction}:${relation.relationship}` &&
                    relation.available,
                )
                .map((relation) => (
                  <section
                    key={`${JSON.stringify(reference)}:${active}`}
                    aria-label={relation.title}
                  >
                    <h4>{relation.title}</h4>
                    <RelatedSection
                      page={page}
                      relationship={relation.relationship}
                      direction={relation.direction}
                      onOpen={onOpen}
                    />
                  </section>
                ))}
            </section>
          )}
          {page.fields.some((field) => field.advanced) && (
            <details>
              <summary>More details</summary>
              <Fields fields={page.fields.filter((field) => field.advanced)} />
            </details>
          )}
        </>
      )}
    </section>
  );
};

export const EntityBrowser = ({
  connection,
  entity,
  onSelect,
  onOpen,
  onBack,
}: {
  connection: string;
  entity?: string;
  onSelect: (entity: string) => void;
  onOpen: (ref: EntityRef) => void;
  onBack: () => void;
}) => {
  const types = useRead(connection, (signal) => api.entities(connection, signal));
  return (
    <section className="dash-record-page dash-entity-view">
      <button className="dash-control" type="button" onClick={onBack}>
        ‹ Dashboard
      </button>
      <h2>Browse records</h2>
      {types.error && <p role="alert">{types.error}</p>}
      {!types.error && !types.data && <p role="status">Loading record types…</p>}
      {types.data && (
        <label>
          Record type{" "}
          <select
            className="dash-input"
            value={entity ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="" disabled>
              Choose a record type
            </option>
            {types.data
              .filter((type) => type.browsable)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.title}
                </option>
              ))}
          </select>
        </label>
      )}
      {types.data?.length === 0 && (
        <p>No prepared record types are available for this connection yet.</p>
      )}
      {entity && types.data?.some((type) => type.id === entity && type.browsable) && (
        <Collection
          key={`${connection}:${entity}`}
          connection={connection}
          entity={entity}
          onOpen={onOpen}
        />
      )}
    </section>
  );
};

const Collection = ({
  connection,
  entity,
  onOpen,
}: {
  connection: string;
  entity: string;
  onOpen: (ref: EntityRef) => void;
}) => {
  const state = useRead(JSON.stringify([connection, entity]), (signal) =>
    api.browseEntity(connection, entity, signal),
  );
  if (state.error) return <p role="alert">{state.error}</p>;
  if (!state.data) return <p role="status">Loading records…</p>;
  return (
    <>
      <h3>{state.data.title}</h3>
      {state.data.description && <p>{state.data.description}</p>}
      <CompletenessNotice completeness={state.data.completeness} />
      <EntityRecordList records={state.data.records} filters={state.data.filters} onOpen={onOpen} />
    </>
  );
};
