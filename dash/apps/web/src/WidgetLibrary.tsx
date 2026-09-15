import {
  Button,
  Checkbox,
  Field,
  Message,
  StatusPill,
  Toolbar,
} from "@freebirdai/dash-components";
import {
  COMPONENT_CONTRACTS,
  COMPONENT_IDS,
  FACET_MAX_PER_WIDGET,
  SEMANTICS,
  contractFor,
} from "@freebirdai/dash-spec";
import type { ComponentContract, ConnectionSpec, WidgetSpec } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import {
  type BriefResult,
  type RecordTypeField,
  type RecordTypePage,
  type RecordTypeSummary,
  type SampleResult,
  api,
} from "./api.js";
import {
  type RoleBinding,
  buildWidget,
  fieldsForRole,
  missingRoles,
  unfillableRoles,
  widgetId,
} from "./binder.js";

/**
 * Pick a component, then say what fills it.
 *
 * The other half of the authoring story. The assistant is source-first — you
 * choose an endpoint and it proposes something — which is the right shape when
 * you do not know what is possible. This is for when you do: you want a board,
 * or a funnel, and you already know which field is the status.
 *
 * Entirely deterministic. No model, no API key, and the same picks always
 * produce the same widget.
 */
export const WidgetLibrary = ({
  connections,
  takenIds,
  describable,
  dashboardId,
  onSave,
  onClose,
}: {
  readonly connections: readonly ConnectionSpec[];
  readonly takenIds: ReadonlySet<string>;
  /**
   * Connections whose records have been described.
   *
   * Only those can be asked in words: a brief names a record type, and an API
   * nobody has described has none. Offering the box anyway would be offering a
   * question that cannot be answered.
   */
  readonly describable?: readonly string[];
  readonly dashboardId?: string;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  const [component, setComponent] = useState<string | null>(null);
  /** The record type being built from, once one is chosen. */
  const [picked, setPicked] = useState<{ connection: string; entity: string } | null>(null);
  const contract = component ? contractFor(component) : undefined;

  return (
    <div className="dash-sheet-backdrop" onClick={onClose} role="presentation">
      <aside
        className="dash-sheet dash-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Add a widget"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dash-sheet__head">
          <span className="dash-sheet__title">
            {contract ? (
              <>
                <button
                  type="button"
                  className="dash-sheet__crumb"
                  onClick={() => setComponent(null)}
                >
                  Components
                </button>
                <span className="dash-sheet__crumb-sep"> › </span>
                {contract.title}
              </>
            ) : (
              "Add a widget"
            )}
          </span>
          <button className="dash-control" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="dash-sheet__body">
          {contract ? (
            <BindStep
              contract={contract}
              connections={connections}
              takenIds={takenIds}
              onSave={onSave}
              onClose={onClose}
            />
          ) : picked ? (
            <RecordFieldsStep
              connection={picked.connection}
              entity={picked.entity}
              {...(dashboardId ? { dashboardId } : {})}
              onBack={() => setPicked(null)}
              onSave={onSave}
              onClose={onClose}
            />
          ) : (
            <>
              <DescribeStep
                connections={connections}
                describable={describable ?? []}
                {...(dashboardId ? { dashboardId } : {})}
                onSave={onSave}
                onClose={onClose}
              />
              <RecordTypeStep
                connections={connections}
                describable={describable ?? []}
                onPick={setPicked}
              />
              <ComponentGrid onPick={setComponent} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
};

/**
 * Say what you want, in your own words.
 *
 * The other door into the same room. Picking a component and binding its roles
 * is the right shape when you already know what you want and which field is
 * the status; this is for when you know only what you want to *see*.
 *
 * One model call names the records and says what the widget is for. Everything
 * else — which endpoint, which columns, the sort, the filter strips — comes
 * from what this API's records were understood to be, deterministically. What
 * it could not honour is printed rather than quietly dropped, and nothing is
 * added to the board until it is accepted.
 *
 * Absent entirely for an API whose records nobody has described: there would
 * be no record types to build from, and a box that always fails is worse than
 * no box.
 */
const DescribeStep = ({
  connections,
  describable,
  dashboardId,
  onSave,
  onClose,
}: {
  readonly connections: readonly ConnectionSpec[];
  readonly describable: readonly string[];
  readonly dashboardId?: string;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element | null => {
  const usable = useMemo(
    () => connections.filter((entry) => describable.includes(entry.id)),
    [connections, describable],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BriefResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Which reading is on screen. Both came from the same model call. */
  const [showing, setShowing] = useState<"primary" | "alternative">("primary");

  const connection = usable.find((entry) => entry.id === picked) ?? usable[0];
  if (!connection) return null;

  const build = async (): Promise<void> => {
    if (intent.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setShowing("primary");
    try {
      setResult(await api.brief(connection.id, intent.trim(), dashboardId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    // Whichever reading is on screen, never whichever was built first.
    const picked =
      showing === "alternative" && result?.alternative ? result.alternative.widget : result?.widget;
    if (!picked) return;
    setSaving(true);
    try {
      await onSave(picked);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  const alternative = result?.alternative;
  const onAlternative = showing === "alternative" && alternative !== undefined;
  const widget = (onAlternative ? alternative.widget : result?.widget) ?? null;
  const shownNotes = (onAlternative ? alternative.notes : result?.notes) ?? [];
  const contract = widget ? contractFor(widget.component) : undefined;
  const filters = (widget?.facets ?? []).map((facet) => facet.field);

  return (
    <section className="dash-sheet__section" data-testid="describe">
      <h4 className="dash-sheet__sub">Describe it</h4>
      <p className="dash-hint">
        Say what you want to see. It is built from what this API&rsquo;s records are, and you can
        change anything afterwards.
      </p>

      {usable.length > 1 && (
        <Field label="Data from">
          {(id) => (
            <select
              id={id}
              className="dash-control"
              value={connection.id}
              onChange={(event) => {
                setPicked(event.target.value);
                setResult(null);
              }}
              data-testid="describe-connection"
            >
              {usable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title ?? entry.id}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      <Field label="What do you want to see?">
        {(id) => (
          <input
            id={id}
            type="text"
            className="dash-control"
            value={intent}
            placeholder="open work with a filter by status"
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void build();
            }}
            data-testid="describe-intent"
          />
        )}
      </Field>

      <Toolbar>
        <Button
          tone="primary"
          onClick={() => void build()}
          disabled={busy || intent.trim().length === 0}
          testId="describe-build"
        >
          {busy ? "Working…" : "Build it"}
        </Button>
      </Toolbar>

      {error && <p className="dash-callout dash-callout--bad">{error}</p>}

      {result && result.errors.length > 0 && (
        <p className="dash-callout dash-callout--bad" data-testid="describe-errors">
          {result.errors.join(" ")}
        </p>
      )}

      {widget && (
        <div data-testid="describe-result">
          <p className="dash-hint">{result?.reason}</p>
          {/*
           * What it decided, in the same four rows the setup card uses: what it
           * is showing, how, and what the reader will be able to narrow by.
           */}
          <dl className="dash-record">
            <div className="dash-record__pair">
              <dt>Showing</dt>
              <dd>{widget.title}</dd>
            </div>
            <div className="dash-record__pair">
              <dt>As</dt>
              <dd>{contract?.title ?? widget.component}</dd>
            </div>
            {filters.length > 0 && (
              <div className="dash-record__pair">
                <dt>Filters</dt>
                <dd>{filters.join(", ")}</dd>
              </div>
            )}
          </dl>

          {/* Where the answer differs from what was asked. Never swallowed. */}
          {shownNotes.map((note) => (
            <p className="dash-hint" key={note}>
              {note}
            </p>
          ))}

          {/*
           * The other reading of the same words, offered rather than asked
           * about. Both were built by one model call, so this swaps instantly
           * — which is what lets the question go unasked without the other
           * reading becoming unreachable.
           */}
          {alternative && (
            <p className="dash-hint" data-testid="describe-alternative">
              {onAlternative ? (
                <>
                  Showing {alternative.label}.{" "}
                  <button
                    type="button"
                    className="dash-sheet__crumb"
                    onClick={() => setShowing("primary")}
                  >
                    Go back
                  </button>
                </>
              ) : (
                <>
                  Or did you mean{" "}
                  <button
                    type="button"
                    className="dash-sheet__crumb"
                    onClick={() => setShowing("alternative")}
                  >
                    {alternative.label}
                  </button>
                  ?
                </>
              )}
            </p>
          )}

          <Toolbar>
            <Button
              tone="primary"
              onClick={() => void add()}
              disabled={saving}
              testId="describe-add"
            >
              {saving ? "Adding…" : "Add it"}
            </Button>
            <Button onClick={() => setResult(null)}>Start again</Button>
          </Toolbar>
        </div>
      )}
    </section>
  );
};

/**
 * Start from what the records are, rather than from which chart to draw.
 *
 * The endpoint-first library asks for a component and then which of an
 * endpoint's raw fields fills each of its roles, which is a question about the
 * API rather than about the work — and it is the reason this list used to
 * offer names like `Category.SubCategory.Name`. A record type is the thing
 * somebody actually has in mind.
 *
 * Absent for an API whose records nobody has described, where there would be
 * no record types to offer.
 */
const RecordTypeStep = ({
  connections,
  describable,
  onPick,
}: {
  readonly connections: readonly ConnectionSpec[];
  readonly describable: readonly string[];
  readonly onPick: (picked: { connection: string; entity: string }) => void;
}): JSX.Element | null => {
  const usable = useMemo(
    () => connections.filter((entry) => describable.includes(entry.id)),
    [connections, describable],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [types, setTypes] = useState<readonly RecordTypeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const connection = usable.find((entry) => entry.id === chosen) ?? usable[0];
  const connectionId = connection?.id;

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    setTypes(null);
    setError(null);
    void (async () => {
      try {
        const found = await api.recordTypes(connectionId);
        if (!cancelled) setTypes(found);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (!connection) return null;

  const term = search.trim().toLowerCase();
  /*
   * Only what can actually be built, and what somebody would start from first.
   * A reference list — a set of categories other records point at — is a
   * legitimate answer and almost never the right one, so it sorts last rather
   * than being hidden.
   */
  const offered = (types ?? [])
    .filter((one) => one.listable)
    .filter((one) =>
      term === ""
        ? true
        : `${one.name.many} ${one.description ?? ""}`.toLowerCase().includes(term),
    )
    .sort((a, b) => Number(b.starting) - Number(a.starting) || a.name.many.localeCompare(b.name.many));

  return (
    <section className="dash-sheet__section" data-testid="record-types">
      <h4 className="dash-sheet__sub">Or start from your records</h4>
      <p className="dash-hint">
        Pick the kind of record you want to see. Its fields come with the names and descriptions
        this API gave them.
      </p>

      {usable.length > 1 && (
        <Field label="Data from">
          {(id) => (
            <select
              id={id}
              className="dash-control"
              value={connection.id}
              onChange={(event) => setChosen(event.target.value)}
            >
              {usable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title ?? entry.id}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
      {!error && types === null && <p className="dash-hint">Reading what this API has…</p>}

      {types !== null && types.length > 0 && (
        <Field label="Which records?">
          {(id) => (
            <input
              id={id}
              type="search"
              className="dash-control"
              value={search}
              placeholder="Search"
              onChange={(event) => setSearch(event.target.value)}
              data-testid="record-type-search"
            />
          )}
        </Field>
      )}

      <div className="dash-cards">
        {offered.map((one) => (
          <button
            type="button"
            key={one.entity}
            className="dash-card"
            onClick={() => onPick({ connection: connection.id, entity: one.entity })}
            data-testid={`record-type-${one.entity}`}
          >
            <span className="dash-card__title">{one.name.many}</span>
            {one.description && <span className="dash-card__meta">{one.description}</span>}
          </button>
        ))}
      </div>

      {types !== null && offered.length === 0 && (
        <Message>
          {term
            ? "Nothing here matches that."
            : "None of this API's records can be listed on their own yet."}
        </Message>
      )}
    </section>
  );
};

/**
 * Choose what to show, by the names a person reads.
 *
 * The half of the old library that was a question about the API: it listed an
 * endpoint's raw field names and asked which filled each of a component's
 * roles. Here the fields wear the labels and descriptions the record type
 * carries, and everything nobody chose — the endpoint, the sort, the filter
 * strips, the view — comes from the record type itself.
 *
 * Compiled by the same thing that compiles a described widget, so building one
 * by hand and describing it cannot produce different answers to the same
 * request.
 */
/**
 * Whether a field could be a filter strip at all.
 *
 * A strip turns a field into a row of categories with counts, so the question
 * is whether its values *are* categories. A date and an amount are not: they
 * hold a different value on nearly every record, and a strip over one is a
 * hundred tiles of one row each. Everything else is offered — a field the
 * describing pass could not type is usually exactly the sort of short label
 * that makes a good strip, and picking one that turns out to have too many
 * values degrades to no strip and a note saying why, rather than to something
 * wrong.
 */
const couldBeAStrip = (field: RecordTypeField): boolean => {
  if (!field.semantic) return true;
  if (field.semantic === "url") return false;
  const kind = SEMANTICS[field.semantic]?.valueType;
  return kind !== "temporal" && kind !== "numeric";
};

const RecordFieldsStep = ({
  connection,
  entity,
  dashboardId,
  onBack,
  onSave,
  onClose,
}: {
  readonly connection: string;
  readonly entity: string;
  readonly dashboardId?: string;
  readonly onBack: () => void;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  const [page, setPage] = useState<RecordTypePage | null>(null);
  const [title, setTitle] = useState("");
  const [justCount, setJustCount] = useState(false);
  const [columns, setColumns] = useState<readonly string[]>([]);
  /**
   * The filter strips, always stated rather than left to the compiler.
   *
   * Started from what the record type would get anyway, so the ticks match the
   * widget somebody would have got without opening this. Stated even when
   * empty: saying nothing means "choose for me", so an unstated empty list
   * would put the defaults straight back and the last strip could never come
   * off.
   */
  const [filters, setFilters] = useState<readonly string[]>([]);
  /**
   * How the list is ordered. `""` means "whatever this record type does".
   *
   * Kept separate from the field itself so choosing a direction cannot
   * silently pin an order nobody asked for: with no field chosen there is
   * nothing to reverse.
   */
  const [sortField, setSortField] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  /** Columns read through a reference, and the link being followed to add one. */
  const [linked, setLinked] = useState<
    readonly { through: string; field: string; label: string }[]
  >([]);
  const [following, setFollowing] = useState<string>("");
  const [far, setFar] = useState<RecordTypePage | null>(null);
  const [result, setResult] = useState<Omit<BriefResult, "reason"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await api.recordType(connection, entity);
        if (cancelled) return;
        setPage(found);
        /*
         * Started on what the record type already considers worth showing, so
         * the first thing somebody sees is a usable widget rather than an
         * empty one waiting to be assembled.
         */
        const primary = found.fields.filter((field) => field.visibility === "primary");
        setColumns((primary.length > 0 ? primary : found.fields.slice(0, 4)).map((f) => f.path));
        setFilters(found.filters.slice(0, FACET_MAX_PER_WIDGET));
        setSortField(found.sort?.field ?? "");
        setSortDir(found.sort?.dir ?? "desc");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, entity]);

  /*
   * What the chosen link points at, fetched only once somebody follows it.
   * Reading every linked record type up front would be a request per
   * reference for a question most people never ask.
   */
  useEffect(() => {
    const target = page?.references.find((one) => one.field === following)?.target;
    if (!target) {
      setFar(null);
      return;
    }
    let cancelled = false;
    setFar(null);
    void (async () => {
      try {
        const found = await api.recordType(connection, target);
        if (!cancelled) setFar(found);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [following, page, connection]);

  const build = async (): Promise<void> => {
    if (!page) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.compileBrief(
          connection,
          {
            entity,
            intent: justCount ? "measure" : "records",
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(justCount
              ? {}
              : {
                  columns: [...columns],
                  filters: filters.map((field) => ({ field })),
                  ...(sortField ? { sort: { field: sortField, dir: sortDir } } : {}),
                }),
            ...(justCount || linked.length === 0 ? {} : { linked: [...linked] }),
          },
          dashboardId,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const widget = result?.widget;
    if (!widget) return;
    setSaving(true);
    try {
      await onSave(widget);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  /*
   * Grouped the way the record type groups them, and by prominence where it
   * says nothing — so a long record reads as a few sections rather than as
   * forty rows of equal weight.
   */
  const sections = new Map<string, RecordTypeField[]>();
  for (const field of page?.fields ?? []) {
    const key = field.group ?? (field.visibility === "primary" ? "Main" : "Details");
    const held = sections.get(key);
    if (held) held.push(field);
    else sections.set(key, [field]);
  }

  return (
    <>
      <nav className="dash-record-page__crumbs" aria-label="Breadcrumb">
        <button type="button" className="dash-sheet__crumb" onClick={onBack} data-testid="fields-back">
          ‹ Records
        </button>
        <span className="dash-sheet__crumb-sep"> › </span>
        <span className="dash-record-page__here">{page?.name.many ?? entity}</span>
      </nav>

      {error && <p className="dash-callout dash-callout--bad">{error}</p>}
      {!page && !error && <p className="dash-hint">Reading what a {entity} carries…</p>}

      {page && (
        <>
          {page.description && <p className="dash-hint">{page.description}</p>}

          <Field label="Call it">
            {(id) => (
              <input
                id={id}
                type="text"
                className="dash-control"
                value={title}
                placeholder={page.name.many}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="fields-title"
              />
            )}
          </Field>

          <Checkbox
            checked={justCount}
            onChange={setJustCount}
            label={`Just how many ${page.name.many.toLowerCase()} there are`}
            meta="A single number rather than a list"
            testId="fields-just-count"
          />

          {!justCount &&
            [...sections].map(([group, fields]) => (
              <section className="dash-sheet__section" key={group}>
                <h4 className="dash-sheet__sub">{group}</h4>
                {fields.map((field) => (
                  <Checkbox
                    key={field.path}
                    label={field.label}
                    {...(field.description ? { meta: field.description } : {})}
                    checked={columns.includes(field.path)}
                    onChange={(on) =>
                      setColumns((previous) =>
                        on
                          ? [...previous, field.path]
                          : previous.filter((path) => path !== field.path),
                      )
                    }
                    testId={`field-${field.path}`}
                  />
                ))}
              </section>
            ))}

          {!justCount && (
            <section className="dash-sheet__section" data-testid="sort-order">
              <h4 className="dash-sheet__sub">Order</h4>
              <Field label="Sorted by">
                {(id) => (
                  <select
                    id={id}
                    className="dash-control"
                    value={sortField}
                    onChange={(event) => setSortField(event.target.value)}
                    data-testid="sort-field"
                  >
                    {/*
                     * Not "none". Rows come back in whatever order the endpoint
                     * returns them, which is an order — just not one anybody
                     * chose, and saying "none" would claim otherwise.
                     */}
                    <option value="">However {page.name.many.toLowerCase()} come back</option>
                    {page.fields.map((field) => (
                      <option key={field.path} value={field.path}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {sortField && (
                <Field label="Direction">
                  {(id) => (
                    <select
                      id={id}
                      className="dash-control"
                      value={sortDir}
                      onChange={(event) => setSortDir(event.target.value as "asc" | "desc")}
                      data-testid="sort-dir"
                    >
                      <option value="desc">Highest or newest first</option>
                      <option value="asc">Lowest or oldest first</option>
                    </select>
                  )}
                </Field>
              )}
            </section>
          )}

          {!justCount && (() => {
            /*
             * Anything already chosen stays on the list whatever it is made of.
             * The record type's own choices win over this screen's reading of
             * what makes a category — and a tick nobody can untick is worse
             * than an odd-looking option.
             */
            const chosen = new Set(filters);
            const offered = page.fields.filter(
              (field) => couldBeAStrip(field) || chosen.has(field.path),
            );
            if (offered.length === 0) return null;
            const full = filters.length >= FACET_MAX_PER_WIDGET;
            return (
              <section className="dash-sheet__section" data-testid="filter-strips">
                <h4 className="dash-sheet__sub">Filter strips</h4>
                <p className="dash-hint">
                  A row of categories above the widget, with a count on each, that narrows what is
                  shown. Worked out from the records on screen — so it never fetches anything, and
                  never shows a count of records nobody loaded.
                </p>
                {offered.map((field) => (
                  <Checkbox
                    key={field.path}
                    label={field.label}
                    {...(field.description ? { meta: field.description } : {})}
                    checked={chosen.has(field.path)}
                    disabled={full && !chosen.has(field.path)}
                    onChange={(on) =>
                      setFilters((previous) =>
                        on
                          ? [...previous, field.path].slice(0, FACET_MAX_PER_WIDGET)
                          : previous.filter((path) => path !== field.path),
                      )
                    }
                    testId={`filter-${field.path}`}
                  />
                ))}
                <p className="dash-hint">
                  {full
                    ? `${FACET_MAX_PER_WIDGET} is as many as fit above one widget — untick one to choose another.`
                    : filters.length === 0
                      ? "None chosen, so the widget gets no filter strips."
                      : `${filters.length} of ${FACET_MAX_PER_WIDGET}.`}
                </p>
              </section>
            );
          })()}

          {!justCount && page.references.length > 0 && (
            <section className="dash-sheet__section" data-testid="linked-fields">
              <h4 className="dash-sheet__sub">From a linked record</h4>
              <p className="dash-hint">
                Show something that lives on a record this one points at — a supplier&rsquo;s phone
                number beside the work they are doing.
              </p>

              {linked.map((one) => (
                <p className="dash-hint" key={`${one.through}.${one.field}`}>
                  {one.label}{" "}
                  <button
                    type="button"
                    className="dash-sheet__crumb"
                    onClick={() =>
                      setLinked((previous) =>
                        previous.filter(
                          (other) => other.through !== one.through || other.field !== one.field,
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </p>
              ))}

              {linked.length < 4 && (
                <Field label="Follow">
                  {(id) => (
                    <select
                      id={id}
                      className="dash-control"
                      value={following}
                      onChange={(event) => setFollowing(event.target.value)}
                      data-testid="follow-link"
                    >
                      <option value="">Choose a link…</option>
                      {page.references.map((one) => (
                        <option key={one.field} value={one.field}>
                          {/*
                           * Without its "ID" suffix: the field holds an
                           * identifier, but what you are following is the
                           * thing — "Assignee → User", not "Assignee ID".
                           */}
                          {one.label.replace(/\s*\bid\b$/i, "")} → {one.targetName}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}

              {following && !far && <p className="dash-hint">Reading what that record carries…</p>}

              {following && far && (
                <Field label={`Which field of the ${far.name.one.toLowerCase()}?`}>
                  {(id) => (
                    <select
                      id={id}
                      className="dash-control"
                      value=""
                      onChange={(event) => {
                        const chosen = far.fields.find((one) => one.path === event.target.value);
                        const link = page.references.find((one) => one.field === following);
                        if (!chosen || !link) return;
                        setLinked((previous) =>
                          previous.some(
                            (one) => one.through === link.field && one.field === chosen.path,
                          )
                            ? previous
                            : [
                                ...previous,
                                {
                                  through: link.field,
                                  field: chosen.path,
                                  // Named for where it came from, because
                                  // "Phone" on a list of work is ambiguous.
                                  label: `${link.targetName} ${chosen.label.toLowerCase()}`,
                                },
                              ],
                        );
                        setFollowing("");
                      }}
                      data-testid="follow-field"
                    >
                      <option value="">Choose a field…</option>
                      {far.fields.map((one) => (
                        <option key={one.path} value={one.path}>
                          {one.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
            </section>
          )}

          <Toolbar>
            <Button
              tone="primary"
              onClick={() => void build()}
              disabled={busy || (!justCount && columns.length === 0)}
              testId="fields-build"
            >
              {busy ? "Working…" : "Build it"}
            </Button>
          </Toolbar>

          {result && result.errors.length > 0 && (
            <p className="dash-callout dash-callout--bad">{result.errors.join(" ")}</p>
          )}

          {result?.widget && (
            <div data-testid="fields-result">
              {/* Where the answer differs from what was picked. Never swallowed. */}
              {result.notes.map((note) => (
                <p className="dash-hint" key={note}>
                  {note}
                </p>
              ))}
              <Toolbar>
                <Button
                  tone="primary"
                  onClick={() => void add()}
                  disabled={saving}
                  testId="fields-add"
                >
                  {saving ? "Adding…" : `Add ${result.widget.title}`}
                </Button>
              </Toolbar>
            </div>
          )}
        </>
      )}
    </>
  );
};

/**
 * The catalogue.
 *
 * Read from the shipped contracts rather than a hand-kept list, so a component
 * added to the product appears here without anybody remembering to add it —
 * the failure mode that leaves a working component undiscoverable.
 */
const ComponentGrid = ({ onPick }: { readonly onPick: (id: string) => void }): JSX.Element => (
  <>
    <p className="dash-hint">
      Every component here binds to data you have already connected. Pick one and you will be asked
      which field fills each part of it.
    </p>
    <div className="dash-cards">
      {COMPONENT_IDS.map((id) => {
        const contract = COMPONENT_CONTRACTS[id];
        const required = contract.roles.filter((role) => role.required);
        return (
          <button
            type="button"
            className="dash-card"
            key={id}
            onClick={() => onPick(id)}
            data-testid={`pick-${id}`}
          >
            <span className="dash-card__title">{contract.title}</span>
            <span className="dash-card__meta">{contract.description}</span>
            <span className="dash-card__badges">
              {/* What it will ask for, before you commit to picking it. */}
              {required.map((role) => (
                <StatusPill key={role.role} tone="neutral" label={role.role} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  </>
);

const BindStep = ({
  contract,
  connections,
  takenIds,
  onSave,
  onClose,
}: {
  readonly contract: ComponentContract;
  readonly connections: readonly ConnectionSpec[];
  readonly takenIds: ReadonlySet<string>;
  readonly onSave: (widget: WidgetSpec) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element => {
  /*
   * Only the picks are state; the effective connection and op are derived from
   * the live list. Seeding state from props is the bug class this codebase has
   * hit three times — a drawer opened while the list was still loading kept an
   * empty id forever.
   */
  const [pickedConnection, setPickedConnection] = useState<string | null>(null);
  const [pickedOp, setPickedOp] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleBinding>({});
  const [title, setTitle] = useState("");
  const [sample, setSample] = useState<SampleResult | null>(null);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const connection =
    connections.find((entry) => entry.id === pickedConnection) ?? connections[0] ?? null;
  const ops = connection?.ops ?? [];
  const op = ops.find((entry) => entry.id === pickedOp) ?? ops[0] ?? null;

  useEffect(() => {
    if (!connection || !op) return;
    let cancelled = false;
    setSampling(true);
    setError(null);
    void (async () => {
      try {
        const result = await api.sample(connection.id, op.id);
        if (!cancelled) {
          setSample(result);
          // The fields changed, so bindings against the old ones are stale.
          setRoles({});
        }
      } catch (failure) {
        if (!cancelled) {
          setSample(null);
          setError(failure instanceof Error ? failure.message : "Could not read that endpoint.");
        }
      } finally {
        if (!cancelled) setSampling(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.id, op?.id]);

  const fields = sample?.fields ?? [];
  const blocked = useMemo(() => unfillableRoles(contract, fields), [contract, fields]);
  const missing = missingRoles(contract, roles);

  if (connections.length === 0) {
    return <Message>Connect an API first — there is nothing to bind this to yet.</Message>;
  }

  const save = async (): Promise<void> => {
    if (!connection || !op) return;
    setSaving(true);
    setError(null);
    const built = buildWidget({
      id: widgetId(title || contract.title, takenIds),
      title: title.trim() || contract.title,
      component: contract.id,
      connection: connection.id,
      op: op.id,
      rowsPath: sample?.rowsPath ?? "$",
      roles,
      fields,
      ...(sample?.schemaHash ? { schemaHash: sample.schemaHash } : {}),
    });

    if (!built.widget) {
      setError(built.errors.join("; ") || "That binding did not make a valid widget.");
      setSaving(false);
      return;
    }
    try {
      await onSave(built.widget);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add that widget.");
      setSaving(false);
    }
  };

  return (
    <>
      <p className="dash-hint">{contract.description}</p>

      <Field label="Data from">
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={connection?.id ?? ""}
            onChange={(event) => {
              setPickedConnection(event.target.value);
              setPickedOp(null);
            }}
            data-testid="library-connection"
          >
            {connections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title ?? entry.id}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Endpoint">
        {(id) => (
          <select
            id={id}
            className="dash-control"
            value={op?.id ?? ""}
            onChange={(event) => setPickedOp(event.target.value)}
            data-testid="library-op"
          >
            {ops.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title ?? entry.id}
              </option>
            ))}
          </select>
        )}
      </Field>

      {sampling && <p className="dash-hint">Reading a few rows so the fields are real…</p>}
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}

      {!sampling && sample && (
        <>
          {blocked.length > 0 && (
            <p className="dash-callout dash-callout--bad">
              {/* Said before the picking starts, not after. */}
              This endpoint has nothing that can fill{" "}
              {blocked.map((role) => `“${role.role}”`).join(" or ")}, which a {contract.title} needs.
              Try another endpoint.
            </p>
          )}

          {contract.roles.map((role) => {
            const options = fieldsForRole(role, fields);
            const value = roles[role.role];

            return (
              <div className="dash-bind-role" key={role.role}>
                <Field
                  label={`${role.role}${role.required ? " (required)" : ""}`}
                  hint={role.description}
                >
                  {(id) =>
                    role.multi ? (
                      <div className="dash-bind-multi" id={id} data-testid={`role-${role.role}`}>
                        {options.map((field) => {
                          const chosen = Array.isArray(value) ? value : [];
                          return (
                            <Checkbox
                              key={field.name}
                              label={field.name}
                              meta={field.format ?? field.kinds.join("/")}
                              checked={chosen.includes(field.name)}
                              onChange={(on) =>
                                setRoles((previous) => ({
                                  ...previous,
                                  [role.role]: on
                                    ? [...chosen, field.name]
                                    : chosen.filter((name) => name !== field.name),
                                }))
                              }
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <select
                        id={id}
                        className="dash-control"
                        value={typeof value === "string" ? value : ""}
                        onChange={(event) =>
                          setRoles((previous) => ({ ...previous, [role.role]: event.target.value }))
                        }
                        data-testid={`role-${role.role}`}
                      >
                        <option value="">
                          {options.length === 0 ? "nothing here fits" : "— choose a field —"}
                        </option>
                        {options.map((field) => (
                          <option key={field.name} value={field.name}>
                            {field.name}
                            {field.format ? ` · ${field.format}` : ""}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
              </div>
            );
          })}

          <Field label="Title" hint="What this widget is called on the board.">
            {(id) => (
              <input
                id={id}
                value={title}
                placeholder={contract.title}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="library-title"
              />
            )}
          </Field>

          <Toolbar
            end={
              <Button
                tone="primary"
                onClick={() => void save()}
                disabled={missing.length > 0 || blocked.length > 0}
                busy={saving}
                testId="library-add"
              >
                Add to dashboard
              </Button>
            }
          >
            {missing.length > 0 && (
              <span className="dash-hint">
                Still needs {missing.map((role) => `“${role}”`).join(" and ")}.
              </span>
            )}
          </Toolbar>
        </>
      )}
    </>
  );
};
