import type { CatalogEntry, WidgetSpec } from "@freebirdai/dash-spec";
import {
  VERIFY_BUDGET_DEFAULT,
  authCredentials,
  parseWidget,
  connectionAuths,
  connectionNeedsAddress,
  connectionNeedsAuthSetup,
} from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { ConnectionAddress } from "./ConnectionAddress.js";
import { ConnectionOnboarding } from "./ConnectionOnboarding.js";
import {
  ApiError,
  type Capabilities,
  type ConnectionSummary,
  type DiscoveryResult,
  type DrillDownOffer,
  type EnumerationPlan,
  type MapRunResult,
  type MapState,
  type RhythmState,
  type DescribeRunResult,
  type RecordCheckResult,
  type ReferencesResult,
  type RelationsResult,
  type SampleResult,
  api,
} from "./api.js";

const SOURCE_LABELS: Record<DiscoveryResult["source"], string> = {
  catalog: "Already in the catalog",
  openapi: "Read from an OpenAPI spec",
  docs: "Read from the documentation",
  none: "Nothing found",
};

type View =
  | "list"
  | "choose"
  | "manual"
  | "address"
  | "key"
  | "verify"
  | "endpoints"
  | "read"
  | "dashboards"
  | "rhythm"
  | "manage"
  | "records";

const STEPS: ReadonlyArray<{ id: View; label: string }> = [
  { id: "choose", label: "Choose" },
  /*
   * Only a step for an API hosted per account, or one whose documentation
   * never said where it lives. Everywhere else it is skipped.
   */
  { id: "address", label: "Address" },
  { id: "key", label: "Key" },
  { id: "verify", label: "Verify" },
  { id: "endpoints", label: "Endpoints" },
  { id: "read", label: "Read" },
  /*
   * The step the wizard used to end without.
   *
   * Everything before it leaves a connection that works and a board that is
   * empty. This is where somebody says what they actually want from the API
   * they have just connected, and gets it.
   */
  { id: "dashboards", label: "Dashboards" },
  /*
   * Last, and after the boards exist rather than before.
   *
   * The question is how often to check each endpoint for new records, and it
   * is only answerable once somebody can see which endpoints their boards
   * actually read. Asked before, it would be a list of two hundred URLs.
   */
  { id: "rhythm", label: "Refresh" },
];

const StepRail = ({ current }: { current: View }): JSX.Element => {
  const index = STEPS.findIndex(
    (step) => step.id === current || (current === "manual" && step.id === "choose"),
  );
  return (
    <div className="dash-steps-rail">
      {STEPS.map((step, i) => (
        <span key={step.id}>
          <span
            className="dash-steps-rail__step"
            data-state={i === index ? "active" : i < index ? "done" : "todo"}
          >
            <span className="dash-steps-rail__dot">{i < index ? "✓" : i + 1}</span>
            {step.label}
          </span>
          {i < STEPS.length - 1 && <span className="dash-steps-rail__sep"> — </span>}
        </span>
      ))}
    </div>
  );
};

const AUTH_KINDS = [
  { value: "none", label: "No key needed" },
  { value: "bearer", label: "Bearer token" },
  { value: "header", label: "Custom header" },
  { value: "query", label: "Query parameter" },
  { value: "basic", label: "Username and password (HTTP Basic)" },
  { value: "headers", label: "Several headers (e.g. client id + secret)" },
] as const;

/** How many headers one connection can send its credentials in. */
const MAX_AUTH_HEADERS = 4;

const PAGINATION_KINDS = [
  { value: "none", label: "Single page only" },
  { value: "link-header", label: "Link header (next page in a Link: header)" },
  { value: "cursor", label: "Cursor" },
  { value: "page", label: "Page number" },
] as const;

/**
 * Adding a connection, for someone who does not write JSON.
 *
 * The flow is deliberately: choose → key → **see your own data** → pick
 * endpoints. That third step is the point. A green tick proves a request
 * returned 200; real rows from the user's own account prove the thing is
 * actually wired up, and it is what makes the rest of the product credible.
 */
export const ConnectionManager = ({
  onClose,
  onChanged,
  onCreateWidget,
  onOpenDashboard,
}: {
  onClose: () => void;
  onChanged: () => void;
  /** Go to a board — the one setup just made, most often. */
  onOpenDashboard?: (dashboardId: string) => void;
  /** Absent when there is no dashboard to add to — the offers still show. */
  onCreateWidget?: (widget: WidgetSpec) => Promise<void>;
}): JSX.Element => {
  const [view, setView] = useState<View>("list");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The connection being set up. It exists on the server from step 2 onward. */
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionSummary | null>(null);
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [keyValues, setKeyValues] = useState<Record<string, string>>({});
  /**
   * How the key is sent, as somebody describes it here.
   *
   * Used when the documentation said a key is needed but not how, and when it
   * said wrongly and somebody chose to override it. `names` holds the header
   * or parameter names — one for a single header or parameter, one to four
   * for several headers — and `prefix` what goes before the key in a single
   * header's value ("Token", "ApiKey").
   */
  const [keyAuth, setKeyAuth] = useState({
    type: "bearer" as (typeof AUTH_KINDS)[number]["value"],
    names: ["X-Api-Key", "X-Api-Secret"],
    prefix: "",
  });
  /**
   * The record types are being described after the integration was created.
   *
   * Tracked on its own rather than through `busy`, because it takes minutes
   * on a large API and holding `busy` for it disabled every button on the
   * read step with nothing on screen to say why.
   */
  const [recordsPending, setRecordsPending] = useState(false);
  const [recordsFailed, setRecordsFailed] = useState<string | null>(null);
  /** Somebody said the documented way of sending the key is not this API's. */
  const [overridingAuth, setOverridingAuth] = useState(false);
  /** Where to go once an address is saved: on through the wizard, or back. */
  const [addressFrom, setAddressFrom] = useState<"wizard" | "list">("wizard");
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);
  const [sample, setSample] = useState<SampleResult | null>(null);
  /** What reading this connection would cost. Fetched before it is offered. */
  const [plan, setPlan] = useState<EnumerationPlan | null>(null);
  /** 0–1 while a paced read runs, null when idle. */
  const [readProgress, setReadProgress] = useState<number | null>(null);
  const [readResult, setReadResult] = useState<Capabilities | null>(null);
  /**
   * Whether this API has been mapped, and what the pass produced if it ran.
   *
   * The map is the shareable half and the read is the personal half. Mapping
   * describes the *API* — what each endpoint returns and how its resources
   * relate — so it is true for everybody and is done once, ever. Reading
   * samples *this account*, so it is true for one person and is never shared.
   * They are offered separately because they cost different things: mapping
   * spends model tokens and almost no requests, reading spends requests.
   */
  const [mapInfo, setMapInfo] = useState<MapState | null>(null);
  const [mapRun, setMapRun] = useState<MapRunResult | null>(null);
  const [mapping, setMapping] = useState(false);
  const [chosenOps, setChosenOps] = useState<string[]>([]);

  /**
   * What this connection could be set up with, and what it already was.
   *
   * Its own state rather than `mapInfo`'s: the parts of an API are read per
   * connection — a part whose endpoints this connection does not carry is not
   * on offer — so this cannot be derived from anything about the API alone.
   */
  /* The connection whose dashboards are being set up. Everything else about
   * setup lives on the server and in `ConnectionOnboarding`. */
  const [onboardingFor, setOnboardingFor] = useState<ConnectionSummary | null>(null);
  /** How often each endpoint is checked again, and what decided it. */
  const [rhythm, setRhythm] = useState<RhythmState | null>(null);
  const [showAllEndpoints, setShowAllEndpoints] = useState(false);

  const [discoverUrl, setDiscoverUrl] = useState("");
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  /** The connection being edited from the list, and its spare catalog endpoints. */
  const [managed, setManaged] = useState<ConnectionSummary | null>(null);
  const [available, setAvailable] = useState<
    Array<{ id: string; title: string; path: string; archetype: string }>
  >([]);
  const [opTest, setOpTest] = useState<{ opId: string; text: string; ok: boolean } | null>(null);
  const [newOp, setNewOp] = useState({ title: "", path: "", archetype: "list" });
  /** The proposal for the managed connection. Nothing here is stored yet. */
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  /** How records link, as currently believed — editable, and free to read. */
  /*
   * Deliberately its own state rather than the wizard's `mapInfo`: that one
   * belongs to the API being set up, and a screen about an already-connected
   * API must not be able to put a half-loaded answer in front of it.
   */
  const [recordsInfo, setRecordsInfo] = useState<MapState | null>(null);
  /** Every link between record types, and what each could be corrected to. */
  const [references, setReferences] = useState<ReferencesResult | null>(null);
  const [check, setCheck] = useState<RecordCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [described, setDescribed] = useState<DescribeRunResult | null>(null);
  const [relations, setRelations] = useState<RelationsResult | null>(null);
  const [relationsSaved, setRelationsSaved] = useState(false);

  const [manual, setManual] = useState({
    id: "",
    title: "",
    baseUrl: "",
    authType: "bearer" as (typeof AUTH_KINDS)[number]["value"],
    authName: "X-Api-Key",
    authName2: "X-Api-Secret",
    opTitle: "Items",
    opPath: "/items",
    rowsPath: "$.data",
    pagination: "none" as (typeof PAGINATION_KINDS)[number]["value"],
  });

  const refresh = useCallback(async () => {
    const [entries, existing] = await Promise.all([api.catalog(), api.connections()]);
    setCatalog(entries);
    setConnections(existing);
  }, []);

  useEffect(() => {
    void refresh().catch((caught: ApiError) => setError(caught.message));
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const startFromCatalog = (chosen: CatalogEntry): Promise<void> =>
    run(async () => {
      const created = await api.createFromCatalog({ catalogId: chosen.id });
      setEntry(chosen);
      setDraftId(created.id);
      setDraft(created);
      setChosenOps(created.ops.map((op) => op.id));
      setValidation(null);
      setSample(null);
      setKeyValues({});
      setOverridingAuth(false);
      setAddressFrom("wizard");
      setView(created.needsAddress ? "address" : created.needsKey ? "key" : "verify");
    });

  const saveManual = (): Promise<void> =>
    run(async () => {
      const id = (manual.id || manual.title).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (!id) throw new Error("Give the connection a name.");

      const auth =
        manual.authType === "none"
          ? { type: "none" }
          : manual.authType === "bearer"
            ? { type: "bearer", keyRef: `${id}-key` }
            : manual.authType === "header"
              ? { type: "header", header: manual.authName, keyRef: `${id}-key` }
              : manual.authType === "basic"
                ? { type: "basic", usernameRef: `${id}-user`, keyRef: `${id}-key` }
              : manual.authType === "headers"
                ? {
                    type: "headers",
                    parts: [
                      {
                        header: manual.authName,
                        keyRef: `${id}-id`,
                        label: manual.authName,
                      },
                      {
                        header: manual.authName2,
                        keyRef: `${id}-secret`,
                        label: manual.authName2,
                      },
                    ],
                  }
                : { type: "query", param: manual.authName, keyRef: `${id}-key` };

      const pagination =
        manual.pagination === "link-header"
          ? { kind: "link-header" }
          : manual.pagination === "cursor"
            ? { kind: "cursor", cursorPath: "$.next_cursor", param: "cursor" }
            : manual.pagination === "page"
              ? { kind: "page", param: "page" }
              : { kind: "none" };

      const created = await api.saveConnection(id, {
        id,
        title: manual.title || id,
        kind: "rest",
        baseUrl: manual.baseUrl,
        auth,
        dialect: { auth, pagination, rowsPath: manual.rowsPath || undefined },
        ops: [
          {
            id: "items",
            title: manual.opTitle || "Items",
            path: manual.opPath,
            archetype: "list",
          },
        ],
        validateOpId: "items",
      });

      setEntry(null);
      setDraftId(created.id);
      setDraft(created);
      setChosenOps(["items"]);
      setValidation(null);
      setSample(null);
      setView(manual.authType === "none" ? "verify" : "key");
    });

  /** 0–1 while a section is being read page by page, null when idle. */
  const [indexProgress, setIndexProgress] = useState<number | null>(null);

  /**
   * Read every documented page in the section and merge them.
   *
   * The same shape as the API-read consent step: a real number shown first,
   * a determinate bar animated against the server's own estimate, and the
   * result replacing the thin one it came from. Only offered — never run on
   * its own initiative, because it is hundreds of requests to a site that
   * did not ask to be crawled.
   */
  const readWholeIndex = (): Promise<void> =>
    run(async () => {
      const index = discovery?.index;
      if (!index) return;

      const started = Date.now();
      const total = Math.max(index.estimatedMs, 1);
      setIndexProgress(0);
      const tick = window.setInterval(() => {
        // Held short of the end: the last stretch belongs to the response.
        setIndexProgress(Math.min(0.95, (Date.now() - started) / total));
      }, 100);

      try {
        const deeper = await api.readIndex(discoverUrl.trim());
        setIndexProgress(1);
        setDiscovery(deeper);
      } finally {
        window.clearInterval(tick);
        setIndexProgress(null);
      }
    });

  const runDiscovery = (): Promise<void> =>
    run(async () => {
      setDiscovery(null);
      setDiscovery(await api.discover(discoverUrl.trim()));
    });

  /**
   * Adopt a discovered description: store the dialect in the local catalog so
   * it is reusable (and contributable), then create a connection from it.
   */
  const useDiscovered = (found: CatalogEntry): Promise<void> =>
    run(async () => {
      const saved = await api.saveCatalogEntry(found);
      const created = await api.createFromCatalog({ catalogId: saved.id });
      setEntry(saved);
      setDraftId(created.id);
      setDraft(created);
      setChosenOps(created.ops.map((op) => op.id));
      setValidation(null);
      setSample(null);
      setKeyValues({});
      setDiscovery(null);
      setOverridingAuth(false);
      setAddressFrom("wizard");
      await refresh();
      setView(created.needsAddress ? "address" : created.needsKey ? "key" : "verify");
    });

  /**
   * Change where an existing connection's API lives — a new account on the
   * same service, or an address the import got wrong.
   */
  const openAddress = (connection: ConnectionSummary): void => {
    setEntry(null);
    setDraftId(connection.id);
    setDraft(connection);
    setAddressFrom("list");
    setView("address");
  };

  /**
   * The fields this connection's auth style needs, in the order to show them.
   *
   * Derived from the draft rather than the catalog entry, because a discovered
   * spec may declare auth the catalog never described.
   */
  /** True when the description required a key but never said where it goes. */
  const authUndeclared =
    Boolean(draft && connectionNeedsAuthSetup(draft)) && draft?.auth.type === "none";

  /** Being described here rather than read off the documentation. */
  const describingAuth = authUndeclared || overridingAuth;

  /** The auth the user just described, ready to be written to the connection. */
  const describedAuth = (): Record<string, unknown> => {
    const id = draftId ?? "conn";
    const [first = ""] = keyAuth.names;
    switch (keyAuth.type) {
      case "header":
        return {
          type: "header",
          header: first,
          keyRef: `${id}-key`,
          ...(keyAuth.prefix.trim() ? { template: `${keyAuth.prefix.trim()} {{key}}` } : {}),
        };
      case "query":
        return { type: "query", param: first, keyRef: `${id}-key` };
      case "basic":
        return { type: "basic", usernameRef: `${id}-user`, keyRef: `${id}-key` };
      case "headers":
        return {
          type: "headers",
          parts: keyAuth.names.map((name, index) => ({
            header: name,
            keyRef: `${id}-key-${index + 1}`,
            label: name,
          })),
        };
      default:
        return { type: "bearer", keyRef: `${id}-key` };
    }
  };

  const setAuthName = (index: number, next: string): void =>
    setKeyAuth((current) => ({
      ...current,
      names: current.names.map((name, at) => (at === index ? next : name)),
    }));

  /**
   * One row per credential, each carrying its own name field where the name is
   * still being chosen. Rendering names and values as two separate lists is
   * what made this step confusing.
   */
  interface KeyRow {
    keyRef: string;
    legend?: string;
    /** Null when the name is already fixed by the connection. */
    nameValue: string | null;
    nameLabel?: string;
    onNameChange?: (next: string) => void;
    valueLabel: string;
    hint?: string;
  }

  const keyRows: KeyRow[] = (() => {
    if (describingAuth) {
      const id = draftId ?? "conn";
      if (keyAuth.type === "headers") {
        return keyAuth.names.map((name, index) => ({
          keyRef: `${id}-key-${index + 1}`,
          legend: `Header ${index + 1}`,
          nameValue: name,
          nameLabel: "Header name",
          onNameChange: (next: string) => setAuthName(index, next),
          valueLabel: "Value for this header",
        }));
      }
      if (keyAuth.type === "header" || keyAuth.type === "query") {
        return [
          {
            keyRef: `${id}-key`,
            nameValue: keyAuth.names[0] ?? "",
            nameLabel: keyAuth.type === "query" ? "Parameter name" : "Header name",
            onNameChange: (next: string) => setAuthName(0, next),
            valueLabel: "API key",
          },
        ];
      }
      if (keyAuth.type === "basic") {
        return [
          { keyRef: `${id}-user`, nameValue: null, valueLabel: "Username" },
          { keyRef: `${id}-key`, nameValue: null, valueLabel: "Password" },
        ];
      }
      return [{ keyRef: `${id}-key`, nameValue: null, valueLabel: "API key" }];
    }

    if (!draft) return [];
    /*
     * The documentation's own names for each credential where the import
     * found them — "Access key", "Secret" — so nobody is asked for one "API
     * key" when they hold two values.
     */
    const rows = connectionAuths(draft).flatMap((auth) =>
      authCredentials(auth).map((credential) => ({
        keyRef: credential.keyRef,
        nameValue: null,
        valueLabel: credential.label,
        hint: credential.hint,
      })),
    );
    return [...new Map(rows.map((row) => [row.keyRef, row])).values()];
  })();

  const submitKey = (): Promise<void> =>
    run(async () => {
      if (!draftId) return;
      /*
       * Record where the key goes before storing it. Either the connection
       * says `auth: none` and the key would go nowhere, or somebody said the
       * documented way is wrong. An endpoint that only repeated the old
       * connection-wide auth follows the new one; one with auth of its own —
       * a public endpoint, a different scheme — keeps it.
       */
      if (describingAuth && draft) {
        const auth = describedAuth();
        const previous = JSON.stringify(draft.auth);
        const updated = await api.saveConnection(draftId, {
          ...draft,
          auth,
          authRequired: false,
          ...(draft.dialect ? { dialect: { ...draft.dialect, auth } } : {}),
          ops: draft.ops.map((op) => {
            if (!op.auth || JSON.stringify(op.auth) !== previous) return op;
            const { auth: _inherited, ...rest } = op;
            return rest;
          }),
        });
        setDraft(updated);
        setOverridingAuth(false);
      }
      await api.setKeys(draftId, keyValues);
      setKeyValues({}); // never keep them in component state longer than needed
      setView("verify");
    });

  const verify = (): Promise<void> =>
    run(async () => {
      if (!draftId || !draft) return;
      const result = await api.validate(draftId).catch((caught: ApiError) => ({
        ok: false,
        message: caught.message,
      }));
      setValidation(result);
      if (!result.ok) return;

      /*
       * Never sample the endpoint we were just told is off limits.
       *
       * Validation can pass on a 403 — being refused a resource proves the key
       * was accepted — but sampling that same endpoint would then show nothing
       * and make a working connection look broken. Anything parameter-free
       * will do; the sample is here to show real fields, not to test a
       * specific route.
       */
      // Plural: validation walks a candidate list, so several endpoints can
      // have been refused before one answered.
      const forbidden = new Set(("forbidden" in result ? result.forbidden : undefined) ?? []);
      // The one validation actually proved is the best thing to sample.
      const proven = "validatedOpId" in result ? result.validatedOpId : undefined;
      const usable = draft.ops.filter(
        (op) => !forbidden.has(op.id) && !op.path.includes("{{param."),
      );
      const opId =
        proven ??
        (draft.validateOpId && !forbidden.has(draft.validateOpId)
          ? draft.validateOpId
          : undefined) ??
        usable[0]?.id ??
        draft.ops[0]?.id;
      if (opId) setSample(await api.sample(draftId, opId).catch(() => null));
    });

  /**
   * Save the chosen endpoints, then ask before spending anything on them.
   *
   * The estimate has to come after this, not before: it is a function of the
   * endpoints that were actually kept.
   */
  const finish = (): Promise<void> =>
    run(async () => {
      if (!draftId || !draft) return;
      const kept = draft.ops.filter((op) => chosenOps.includes(op.id));
      await api.saveConnection(draftId, {
        ...draft,
        ops: kept,
        validateOpId: kept.some((op) => op.id === draft.validateOpId)
          ? draft.validateOpId
          : kept[0]?.id,
      });
      await refresh();
      onChanged();
      setPlan(await api.enumerationPlan(draftId).catch(() => null));
      setMapInfo(await api.mapState(draft.catalog ?? draftId).catch(() => null));
      setView("read");
    });

  /** Leave the wizard. The connection is already saved and usable. */
  const closeWizard = (): void => {
    setView("list");
    setDraftId(null);
    setDraft(null);
    setPlan(null);
    setReadProgress(null);
    setMapInfo(null);
    setMapRun(null);
    setOnboardingFor(null);
    setRhythm(null);
  };

  /**
   * Map the API, once, for everybody.
   *
   * Deliberately not folded into the read step's button. Reading is about this
   * account and costs requests against somebody's API; this costs model tokens
   * and, on a spec-backed API, no requests at all — the field lists come out of
   * the OpenAPI document for nothing. Two different prices deserve two
   * different questions.
   */
  const runMap = (): Promise<void> =>
    run(async () => {
      const id = draft?.catalog ?? draftId;
      if (!id) return;
      setMapping(true);
      let result: MapRunResult;
      try {
        result = await api.mapApi(id);
        setMapRun(result);
        setMapInfo(result);
      } finally {
        setMapping(false);
      }

      /*
       * And what the records *are*, in the same breath.
       *
       * Mapping learns the endpoints; describing learns the record types, and
       * everything entity-first is built on the second. Splitting them into
       * two buttons meant only the first ever got pressed — an API could be
       * connected, mapped, and left with no record types at all.
       *
       * Not awaited here. It takes minutes on a large API, and awaiting it
       * inside `run` held every button on this step disabled under a message
       * that said the work was done. It runs in the background with its own
       * progress line; reading the account can go ahead meanwhile, and the
       * dashboards step waits for it on its own.
       */
      void describeAfterMap(id, result);
    });

  const describeAfterMap = async (id: string, mapped: MapState): Promise<void> => {
    setRecordsPending(true);
    setRecordsFailed(null);
    /* How many are done so far, read off the entry as the pass checkpoints. */
    const poll = window.setInterval(() => {
      void api
        .mapState(id)
        .then(setMapInfo)
        .catch(() => undefined);
    }, 3000);
    try {
      await api.describeRecords(id);
    } catch (caught) {
      /*
       * Not a failure of the connection: the endpoints are mapped and usable,
       * and describing can be run again from Records.
       */
      setRecordsFailed(caught instanceof Error ? caught.message : String(caught));
    } finally {
      window.clearInterval(poll);
      setRecordsPending(false);
      setMapInfo(await api.mapState(id).catch(() => mapped));
    }
  };

  /**
   * Spend the requests, with a bar that reflects the real pace.
   *
   * The server spreads the pass across roughly `estimatedMs`, so animating
   * against that figure is honest rather than a spinner pretending to know.
   */
  const startReading = (): Promise<void> =>
    run(async () => {
      if (!draftId || !plan) return;
      const started = Date.now();
      const total = Math.max(plan.estimatedMs, 1);
      setReadProgress(0);

      const tick = window.setInterval(() => {
        // Cap short of the end: the last stretch belongs to the response.
        setReadProgress(Math.min(0.95, (Date.now() - started) / total));
      }, 100);

      try {
        const capabilities = await api.capabilities(draftId, true);
        setReadProgress(1);
        setReadResult(capabilities);
      } finally {
        window.clearInterval(tick);
      }
    });

  /**
   * Open the last step: what this connection could be set up with.
   *
   * Costs nothing — every number is read off the stored integration and this
   * connection's own endpoints. The one thing here that spends anything is
   * dividing the API, and that is a button.
   */
  const openOnboarding = (connectionId: string): Promise<void> =>
    run(async () => {
      const found =
        connections.find((one) => one.id === connectionId) ??
        (draft?.id === connectionId ? draft : undefined) ??
        (await api.connections()).find((one) => one.id === connectionId);
      if (!found) throw new Error("That connection no longer exists.");
      setOnboardingFor(found);
      setView("dashboards");
    });

  /**
   * The last question: how often to check each endpoint for new records.
   *
   * Free to open — the reading is on the integration and the cadences are on
   * disk, so nothing is fetched and nothing is spent.
   */
  const openRhythm = (connectionId: string): Promise<void> =>
    run(async () => {
      setShowAllEndpoints(false);
      setRhythm(await api.rhythm(connectionId));
      setView("rhythm");
    });

  /**
   * Move one endpoint to another cadence.
   *
   * Saved immediately rather than gathered behind a Save button: there is one
   * control per row and no way to be half-finished, so a button to confirm
   * what you already did is a step that only exists to be forgotten.
   */
  const moveEndpoint = (op: string, tier: string): Promise<void> =>
    run(async () => {
      const connectionId = rhythm?.connection;
      if (!connectionId) return;
      await api.setRhythm(connectionId, { [op]: tier });
      setRhythm(await api.rhythm(connectionId));
    });

  /**
   * What is known about this API's records, and how much of it is proven.
   *
   * Costs nothing to open: every count is read off the stored integration.
   * The one thing here that spends anything is the check, and that is a button
   * rather than something this screen does on the way in.
   */
  const openRecords = (connection: ConnectionSummary): Promise<void> =>
    run(async () => {
      setManaged(connection);
      setCheck(null);
      setDescribed(null);
      const [state, links] = await Promise.all([
        connection.catalog ? api.mapState(connection.catalog).catch(() => null) : null,
        api.references(connection.id).catch(() => null),
      ]);
      setRecordsInfo(state);
      setReferences(links);
      setView("records");
    });

  /**
   * Point a field at a different record type, or at none.
   *
   * The links that decide widgets live on the record types, and they were the
   * ones nobody could correct: the editor in Manage edits the endpoint-level
   * model, which a described API no longer consults. Re-read rather than
   * patched, so what is on screen is what the catalog now says.
   */
  const setReference = (entity: string, field: string, target: string | null): Promise<void> =>
    run(async () => {
      if (!managed) return;
      await api.setReference(managed.id, entity, field, target);
      setReferences(await api.references(managed.id).catch(() => null));
    });

  /**
   * Describe this API's records: what they are, and how they link.
   *
   * The pass the whole entity-first product rests on, and until now the only
   * thing with no way to start it — so an API could be connected and mapped
   * and still have no record types, which is what the screen below was left
   * reporting with nothing to do about it.
   */
  const runDescribe = (): Promise<void> =>
    run(async () => {
      if (!managed?.catalog) return;
      setDescribing(true);
      try {
        setDescribed(await api.describeRecords(managed.catalog));
        setRecordsInfo(await api.mapState(managed.catalog).catch(() => null));
      } finally {
        setDescribing(false);
      }
    });

  const runCheck = (): Promise<void> =>
    run(async () => {
      if (!managed) return;
      setChecking(true);
      try {
        setCheck(await api.checkRecords(managed.id));
        // Re-read rather than patch: the counts on screen are the stored
        // artifact's, and this is what it now says.
        if (managed.catalog) setRecordsInfo(await api.mapState(managed.catalog).catch(() => null));
      } finally {
        setChecking(false);
      }
    });

  const openManage = (connection: ConnectionSummary): Promise<void> =>
    run(async () => {
      setManaged(connection);
      setOpTest(null);
      setCapabilities(null);
      setNewOp({ title: "", path: "", archetype: "list" });
      const [ops, links, records] = await Promise.all([
        api.availableOps(connection.id).catch(() => []),
        // Free — both read what is stored, never the API. A failure here is
        // not worth blocking the screen for.
        api.relations(connection.id).catch(() => null),
        api.references(connection.id).catch(() => null),
      ]);
      setAvailable(ops);
      setRelations(links);
      setReferences(records);
      setView("manage");
    });

  /**
   * Ask the connection what it supports, and offer the answer.
   *
   * Everything the server could work out on its own it has already worked out
   * — the only decision left here is yes.
   */
  const analyse = (): Promise<void> =>
    run(async () => {
      if (!managed) return;
      setCapabilities(null);
      setCapabilities(await api.capabilities(managed.id, capabilities !== null));
    });

  const acceptResources = (): Promise<void> =>
    run(async () => {
      if (!managed || !capabilities) return;
      await reloadManaged(await api.setResources(managed.id, capabilities.resources));
    });

  /**
   * Change one learned link, or drop it.
   *
   * Held locally until saved, so a half-typed field name is never written. The
   * whole graph goes back through the approval route — it takes the array
   * entire — and from then on it outranks whatever a fresh pass would infer.
   */
  const editRelation = (
    resourceId: string,
    relationId: string,
    change: { field?: string; remove?: true },
  ): void => {
    // Otherwise the button keeps reading "Saved" over an unsaved edit.
    setRelationsSaved(false);
    setRelations((current) => {
      if (!current) return current;
      return {
        ...current,
        resources: current.resources.map((resource) => {
          if (resource.id !== resourceId) return resource;
          return {
            ...resource,
            relations: change.remove
              ? resource.relations.filter((relation) => relation.id !== relationId)
              : resource.relations.map((relation) =>
                  relation.id === relationId
                    ? // `param` is what the request actually sends and
                      // `foreignField` is what the row is matched on. They are
                      // the same column here, so a correction has to move both
                      // or the widget quietly keeps using the old one.
                      { ...relation, param: change.field, foreignField: change.field }
                    : relation,
                ),
          };
        }),
      };
    });
  };

  const saveRelations = (): Promise<void> =>
    run(async () => {
      if (!managed || !relations) return;
      await reloadManaged(await api.setResources(managed.id, relations.resources));
      setRelationsSaved(true);
    });

  /**
   * Turn an offer into a real widget: a table of the collection whose rows
   * open the matching record.
   *
   * The columns come from a live sample rather than from the specification,
   * for the same reason the id field does — only a real response knows what a
   * row actually contains.
   */
  /**
   * The child collections of a resource, as sections for its record sheet.
   *
   * Columns come from what sampling actually saw on the child — the
   * capabilities report carries those field names precisely so a section can
   * be bound without calling the endpoint again.
   */
  const relatedSections = (resourceId: string) => {
    const resource = capabilities?.resources.find((item) => item.id === resourceId);
    if (!resource?.idField) return [];

    return (resource.relations ?? [])
      .filter((relation) => relation.cardinality === "many" && relation.via === "path")
      .flatMap((relation) => {
        if (!relation.op || !relation.param) return [];
        const child = capabilities?.resources.find((item) => item.id === relation.resource);
        const seen = capabilities?.fieldsByResource[relation.resource] ?? [];
        // Identity and label first, then whatever else the child returned.
        const lead = [child?.idField, child?.labelField].filter(
          (name): name is string => typeof name === "string",
        );
        const columns = [
          ...lead,
          ...seen.filter((name) => !lead.includes(name) && !name.includes(".")),
        ].slice(0, 5);
        if (columns.length === 0) return [];

        return [
          {
            id: relation.id,
            title: relation.title,
            op: relation.op,
            params: { [relation.param]: `{{row.${resource.idField}}}` },
            component: "table",
            roles: { columns },
            ...(child?.detailOp && child.detailParam && child.idField
              ? {
                  // A child row opens its own record, in the same sheet.
                  opensRecord: {
                    op: child.detailOp,
                    params: { [child.detailParam]: `{{row.${child.idField}}}` },
                    component: "record",
                    roles: { fields: columns },
                  },
                }
              : {}),
          },
        ];
      });
  };

  const buildDrillDownWidget = (offer: DrillDownOffer): Promise<void> =>
    run(async () => {
      if (!managed || !onCreateWidget) return;
      const sampled = await api.sample(managed.id, offer.listOp);

      // Identity and label first, then whatever else came back — a table that
      // opens on a click should lead with the thing you clicked.
      const preferred = [offer.idField, offer.labelField].filter(
        (name): name is string => typeof name === "string",
      );
      /*
       * A nested object is skipped in favour of its own flattened children:
       * `inferShape` emits `Address.City` alongside `Address`, and the parent
       * renders as an unreadable blob where the children render as fields.
       */
      const expanded = new Set(
        sampled.fields
          .filter((field) => field.name.includes("."))
          .map((field) => field.name.slice(0, field.name.indexOf("."))),
      );
      const ordered = [
        ...preferred,
        ...sampled.fields
          .map((field) => field.name)
          .filter((name) => !preferred.includes(name) && !expanded.has(name)),
      ];
      // The table leads with a handful; the record sheet shows everything.
      const columns = ordered.filter((name) => !name.includes(".")).slice(0, 6);

      const built = parseWidget({
        id: `${offer.resource}-${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
        title: offer.title,
        component: "table",
        source: { connection: managed.id, op: offer.listOp, params: {} },
        pipeline: [{ op: "extract", path: sampled.rowsPath }],
        roles: { columns },
        format: {},
        refresh: { staleAfter: "15m" },
        states: {},
        confirmed: [],
        sources: [],
        drilldown: {
          op: offer.detailOp,
          params: { [offer.detailParam]: `{{row.${offer.idField}}}` },
          component: "record",
          title: offer.title,
          pipeline: [],
          /*
           * The collections belonging to this record, shown underneath it.
           *
           * This is usually where the value is. A parent record is often an
           * identifier and a name; the fields worth looking at live in what
           * its id keys. Only `many` links reached by a scoped endpoint are
           * included — those are the ones the API itself declared, and each
           * costs exactly one request when the sheet opens.
           */
          related: relatedSections(offer.resource).slice(0, 4),
          // The record sheet shows the whole thing, not the six columns the
          // table leads with. Its shape comes from the collection's rows — a
          // by-id endpoint returns the record the list returned, so anything
          // the collection reported will be there. Fields only the detail
          // response carries cannot be known without a row to call it for.
          roles: { fields: ordered },
        },
      });

      /*
       * Parsed rather than cast. A hand-built literal drifts from the schema
       * silently; parsing applies every default and refuses anything the
       * runtime could not execute, which is the same bar the agent's
       * proposals are held to.
       */
      if (!built.ok || !built.value) {
        throw new Error(built.errors[0] ?? "Could not build that widget.");
      }
      await onCreateWidget(built.value);
      onClose();
    });

  const reloadManaged = async (next: ConnectionSummary): Promise<void> => {
    setManaged(next);
    setAvailable(await api.availableOps(next.id).catch(() => []));
    await refresh();
    onChanged();
  };

  const addOp = (op: Record<string, unknown>): Promise<void> =>
    run(async () => {
      if (!managed) return;
      await reloadManaged(await api.addOp(managed.id, op));
      setNewOp({ title: "", path: "", archetype: "list" });
    });

  const removeOp = (opId: string): Promise<void> =>
    run(async () => {
      if (!managed) return;
      await reloadManaged(await api.removeOp(managed.id, opId));
    });

  /** Prove a newly added endpoint works, right where it was added. */
  const testOp = (opId: string): Promise<void> =>
    run(async () => {
      if (!managed) return;
      setOpTest(null);
      try {
        const result = await api.sample(managed.id, opId);
        setOpTest({
          opId,
          ok: true,
          text: `${result.rowCount} record(s) at ${result.rowsPath}, ${result.fields.length} field(s).`,
        });
      } catch (caught) {
        setOpTest({
          opId,
          ok: false,
          text: caught instanceof Error ? caught.message : String(caught),
        });
      }
    });

  const remove = (id: string): Promise<void> =>
    run(async () => {
      await api.deleteConnection(id);
      await refresh();
      onChanged();
    });

  const body = (): JSX.Element => {
    switch (view) {
      case "list":
        return (
          <>
            <h4>Connected</h4>
            {connections.length === 0 ? (
              <p className="dash-hint">Nothing connected yet.</p>
            ) : (
              <ul className="dash-conn-list">
                {connections.map((connection) => (
                  <li key={connection.id}>
                    <div className="dash-conn-list__text">
                      <div className="dash-conn-list__title">{connection.title}</div>
                      <div className="dash-conn-list__meta">
                        {connection.baseUrl} · {connection.ops.length} endpoint(s) ·{" "}
                        {connection.auth.type === "none"
                          ? "no key needed"
                          : connection.hasKey
                            ? "key stored"
                            : "no key yet"}
                      </div>
                    </div>
                    <button
                      className="dash-iconbtn"
                      data-testid={`records-${connection.id}`}
                      aria-label={`Records ${connection.title} knows about`}
                      onClick={() => void openRecords(connection)}
                    >
                      Records
                    </button>
                    {connection.kind === "rest" && (
                      <button
                        className="dash-iconbtn"
                        {...(connectionNeedsAddress(connection) ? { "data-tone": "attention" } : {})}
                        data-testid={`address-${connection.id}`}
                        aria-label={`Where ${connection.title}'s API lives`}
                        title={
                          connectionNeedsAddress(connection)
                            ? "This connection needs its address before it can load anything"
                            : connection.baseUrl
                        }
                        onClick={() => openAddress(connection)}
                      >
                        Address
                      </button>
                    )}
                    {/*
                     * The step the wizard ends on, reachable for a connection
                     * that already exists — to finish a setup left half way,
                     * to set up one made before onboarding existed, or to make
                     * another set.
                     */}
                    {connection.catalog && (
                      <button
                        className="dash-iconbtn"
                        data-testid={`onboarding-${connection.id}`}
                        aria-label={`Set up dashboards for ${connection.title}`}
                        onClick={() => void openOnboarding(connection.id)}
                      >
                        Dashboards
                      </button>
                    )}
                    <button
                      className="dash-iconbtn"
                      data-testid={`manage-${connection.id}`}
                      aria-label={`Manage endpoints for ${connection.title}`}
                      onClick={() => void openManage(connection)}
                    >
                      Endpoints
                    </button>
                    <button
                      className="dash-iconbtn dash-danger"
                      title="Remove this connection and its key"
                      aria-label={`Remove ${connection.title}`}
                      onClick={() => void remove(connection.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="dash-row dash-row--end" style={{ marginTop: 14 }}>
              <button
                className="dash-control"
                data-testid="start-add"
                onClick={() => {
                  setError(null);
                  setView("choose");
                }}
              >
                ✚ Add a connection
              </button>
            </div>
          </>
        );

      case "records": {
        const records = recordsInfo?.records;
        const unproven = records ? records.entities - records.verified : 0;
        return (
          <>
            <h4>What {managed?.title ?? "this API"} knows about its records</h4>

            {!records?.described ? (
              <div className="dash-callout" data-testid="records-none">
                <p>
                  <strong>Nothing here has been described yet.</strong>
                </p>
                <p className="dash-hint">
                  Until it is, widgets show raw field names and records show numbers where names
                  belong — there are no record types to build from at all. Describing reads what
                  each kind of record is, what its fields mean and which of them point at each
                  other. It is done once and shared: every later connection to this API starts
                  where this one finished.
                </p>
                <p className="dash-hint">
                  It costs AI usage and makes <strong>no requests against your API</strong> —
                  everything it needs is in what has already been read, which is what makes the
                  result a fact about the API rather than about your account.
                </p>
                {recordsInfo?.canRunRecords === false && (
                  <p className="dash-hint">
                    This needs an AI key on the server. Everything else still works without one.
                  </p>
                )}
                <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
                  <button
                    className="dash-control dash-control--primary"
                    data-testid="records-describe"
                    disabled={busy || describing || recordsInfo?.canRunRecords === false}
                    onClick={() => void runDescribe()}
                  >
                    {describing ? "Describing…" : "Describe the records"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <ul className="dash-conn-list" data-testid="records-state">
                  <li>
                    <div className="dash-conn-list__text">
                      <div className="dash-conn-list__title">
                        {records.entities} record type(s)
                      </div>
                      <div className="dash-conn-list__meta">
                        {records.withIdentity} can open a page of their own, {records.withName} know
                        what to call a record, and {records.fieldsDescribed} field(s) have a
                        description a person can read.
                      </div>
                    </div>
                  </li>
                  <li>
                    <div className="dash-conn-list__text">
                      <div className="dash-conn-list__title">
                        {records.references} link(s) between them
                      </div>
                      <div className="dash-conn-list__meta">
                        What lets a record on a row be opened by name, instead of showing the
                        number the API stores.
                      </div>
                    </div>
                  </li>
                  <li>
                    <div className="dash-conn-list__text">
                      <div className="dash-conn-list__title" data-testid="records-verified">
                        {records.verified} of {records.entities} confirmed against your account
                      </div>
                      <div className="dash-conn-list__meta">
                        {records.referencesVerified} of {records.references} link(s) have been
                        followed to a real record.
                        {recordsInfo?.entitiesVerifiedAt
                          ? ` Last checked ${new Date(recordsInfo.entitiesVerifiedAt).toLocaleString()}.`
                          : " Never checked."}
                      </div>
                    </div>
                  </li>
                </ul>

                {/*
                 * Everything above was read for nothing. This is the one thing
                 * on the screen that spends the user's own API quota, so it
                 * says so before it is pressed rather than after.
                 */}
                <div className="dash-callout">
                  <p>
                    <strong>
                      {unproven > 0
                        ? `${unproven} record type(s) have not been checked against real data.`
                        : "Every record type here has been checked against real data."}
                    </strong>
                  </p>
                  <p className="dash-hint">
                    A description is written from {managed?.title ?? "the API"}&rsquo;s own
                    specification, which can be confidently wrong: two things can only be settled
                    by asking your account — that the field a record calls its id is really on the
                    rows, and that a link really resolves to the record it claims. Checking makes
                    real requests against your API, up to {VERIFY_BUDGET_DEFAULT} of them, and stops early if{" "}
                    {managed?.title ?? "the API"} starts rate limiting.
                  </p>
                  <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
                    <button
                      className="dash-control dash-control--primary"
                      data-testid="records-check"
                      disabled={busy || checking}
                      onClick={() => void runCheck()}
                    >
                      {checking ? "Checking…" : "Check against my account"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {described && (
              <div
                className={`dash-callout ${(described.errors ?? []).length > 0 ? "" : "dash-callout--good"}`}
                data-testid="records-describe-done"
              >
                {described.ranPass
                  ? `Described ${described.entities} record type(s), ${described.references} link(s) between them.`
                  : (described.note ?? "Nothing to describe.")}
                {(described.errors ?? []).length > 0 && (
                  <>
                    {" "}
                    {described.errors!.length} part(s) did not finish; running it again picks up
                    where it stopped.
                  </>
                )}
                {(described.skipped ?? []).length > 0 && (
                  <ul className="dash-hint" style={{ marginTop: 6 }}>
                    {described.skipped!.slice(0, 4).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/*
             * The links, and the chance to correct one.
             *
             * These are the ones that decide what a widget is built from and
             * what a record page follows — and they were the only ones nobody
             * could change. The editor that existed edits the endpoint-level
             * relations, a model a described API no longer consults, so
             * correcting a wrong link there changed nothing anybody could see.
             */}
            {references?.described &&
              (references.links.length > 0 || references.candidates.length > 0) && (
              <>
                <h4>How records link</h4>
                <p className="dash-hint">
                  A link is what turns the number an API stores into the name of the record it
                  points at. These were read from {managed?.title ?? "the API"}&rsquo;s own
                  specification, which can be confidently wrong — so each one can be pointed
                  somewhere else, or told it is not a link at all.
                </p>
                <ul className="dash-conn-list" data-testid="references">
                  {references.links.map((link) => (
                    <li key={`${link.entity}-${link.field}`}>
                      <div className="dash-conn-list__text">
                        <div className="dash-conn-list__title">
                          {link.from} · {link.label}
                        </div>
                        <div className="dash-conn-list__meta">
                          {link.openable
                            ? link.cost === "free"
                              ? "The row already carries the name, so opening it costs nothing."
                              : "Opened with one request."
                            : "Nothing here can open the record this points at, so it shows as the raw id."}
                          {link.verified ? " · followed to a real record" : " · not yet confirmed"}
                        </div>
                      </div>
                      <select
                        className="dash-control"
                        data-testid={`reference-${link.entity}-${link.field}`}
                        value={link.target}
                        disabled={busy}
                        onChange={(event) =>
                          void setReference(
                            link.entity,
                            link.field,
                            event.target.value === "" ? null : event.target.value,
                          )
                        }
                      >
                        {references.entities.map((entity) => (
                          <option key={entity.id} value={entity.id}>
                            {entity.title}
                          </option>
                        ))}
                        {/*
                         * A real answer, not an empty state: a field that
                         * resembles a link and is not one is worth saying so
                         * about, and saying so stops every widget over it
                         * offering a record that never opens.
                         */}
                        <option value="">Not a link</option>
                      </select>
                    </li>
                  ))}
                  {/*
                   * Fields that look like a link and are not one. Listed last
                   * and in the same list, because "this should point at
                   * Albums" and "this one should not" are the same correction
                   * from opposite ends — and because a field somebody has just
                   * called "not a link" has to stay somewhere they can put it
                   * back.
                   */}
                  {references.candidates.map((field) => (
                    <li key={`candidate-${field.entity}-${field.field}`}>
                      <div className="dash-conn-list__text">
                        <div className="dash-conn-list__title">
                          {field.from} · {field.label}
                        </div>
                        <div className="dash-conn-list__meta">
                          Looks like it holds a record&rsquo;s id and is not recorded as a link, so
                          it shows as a bare number.
                        </div>
                      </div>
                      <select
                        className="dash-control"
                        data-testid={`reference-${field.entity}-${field.field}`}
                        value=""
                        disabled={busy}
                        onChange={(event) =>
                          void setReference(
                            field.entity,
                            field.field,
                            event.target.value === "" ? null : event.target.value,
                          )
                        }
                      >
                        <option value="">Not a link</option>
                        {references.entities.map((entity) => (
                          <option key={entity.id} value={entity.id}>
                            {entity.title}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {references?.described && references.unreachable.length > 0 && (
              <p className="dash-hint" data-testid="references-unreachable">
                {references.unreachable.length} link(s) are recorded and cannot be followed here:{" "}
                {references.unreachable
                  .slice(0, 3)
                  .map((one) => `${one.from}.${one.field} (${one.reason})`)
                  .join("; ")}
                .
              </p>
            )}

            {check && (
              <div
                className={`dash-callout ${check.stopped ? "" : "dash-callout--good"}`}
                data-testid="records-check-done"
              >
                Confirmed {check.identitiesConfirmed} record type(s) and followed{" "}
                {check.referencesResolved} link(s), using {check.requests} request(s).
                {check.stopped === "refused" &&
                  ` ${managed?.title ?? "The API"} began rate limiting, so the rest were left unchecked — nothing was marked wrong.`}
                {check.stopped === "rejected" &&
                  ` ${managed?.title ?? "The API"} would not accept the stored key, so nothing could be checked. That is a problem with the key rather than with the descriptions, and nothing was marked wrong.`}
                {check.stopped === "budget" &&
                  " That is as far as one check goes; running it again picks up more."}
                {check.notes.length > 0 && (
                  <ul className="dash-hint" style={{ marginTop: 6 }}>
                    {check.notes.slice(0, 6).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 14 }}>
              <button className="dash-control" onClick={() => setView("list")}>
                Back
              </button>
            </div>
          </>
        );
      }

      case "manage":
        return (
          <>
            <h4>What you can build here</h4>
            {!capabilities && (
              <p className="dash-hint">
                Reads {managed?.title}&rsquo;s own endpoints and calls a few of the list ones to see
                what a record looks like. Nothing is saved until you approve it.
              </p>
            )}

            {capabilities && (
              <div data-testid="capabilities">
                {capabilities.drillDowns.length > 0 ? (
                  <ul className="dash-conn-list">
                    {capabilities.drillDowns.map((offer) => (
                      <li key={offer.resource}>
                        <div className="dash-conn-list__text">
                          <div className="dash-conn-list__title">{offer.title}</div>
                          <div className="dash-conn-list__meta">
                            A list you can click into — <code>{offer.idField}</code> on each row
                            opens it via {offer.detailOp}
                            {offer.labelField ? `, labelled by ${offer.labelField}` : ""}.
                          </div>
                        </div>
                        {onCreateWidget && (
                          <button
                            className="dash-iconbtn"
                            data-testid={`build-${offer.resource}`}
                            disabled={busy}
                            onClick={() => void buildDrillDownWidget(offer)}
                          >
                            Build it
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dash-hint">
                    No list-and-detail pairs were found, so there is nothing to click into yet.
                  </p>
                )}

                {capabilities.joins.length > 0 && (
                  <>
                    <h4>Endpoints that can be combined</h4>
                    <ul className="dash-conn-list">
                      {capabilities.joins.map((join) => (
                        <li key={`${join.from}-${join.to}`}>
                          <div className="dash-conn-list__text">
                            <div className="dash-conn-list__title">{join.title}</div>
                            <div className="dash-conn-list__meta">
                              <code>{join.foreignField}</code> matches{" "}
                              <code>{join.targetField}</code>
                              {" — "}
                              {join.needsFanOut
                                ? "one request per row (capped), because the endpoint cannot filter by it"
                                : `one filtered request, using ${join.filterParam}`}
                              .
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {(capabilities.searchable.length > 0 ||
                  capabilities.rangeFilterable.length > 0) && (
                  <p className="dash-hint" data-testid="capability-inputs">
                    {capabilities.searchable.length} endpoint(s) can be searched;{" "}
                    {capabilities.rangeFilterable.length} can be filtered by a date range.
                  </p>
                )}

                {capabilities.notes.length > 0 && (
                  <ul className="dash-warnlist">
                    {capabilities.notes.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="dash-row" style={{ marginBottom: 14 }}>
              <button
                className="dash-control"
                data-testid="analyse"
                disabled={busy}
                onClick={() => void analyse()}
              >
                {busy ? "Looking…" : capabilities ? "Look again" : "Work out what this can do"}
              </button>
              {capabilities && capabilities.resources.length > 0 && (
                <button
                  className="dash-control"
                  data-testid="accept-resources"
                  disabled={busy}
                  onClick={() => void acceptResources()}
                >
                  Save these {capabilities.resources.length} record type(s)
                </button>
              )}
            </div>

            {/*
             * How records link, and the chance to correct it.
             *
             * Two very different things end up in this list and the
             * difference matters: a `path` link is the API's own statement —
             * the parent is in the URL — while a `filter` link was inferred
             * from a field name and then checked against real rows. Only the
             * second is a judgement, so only the second is editable here.
             */}
            <h4>How records relate</h4>
            {references?.described ? (
              /*
               * Described APIs answer from their record types, so the
               * endpoint-level links below no longer decide anything — and an
               * editor whose edits change nothing visible is worse than no
               * editor. The correction moved to where the model that decides
               * actually lives.
               */
              <p className="dash-hint" data-testid="relations-superseded">
                {managed?.title ?? "This API"}&rsquo;s records are described, so its links are
                read from the record types — correct them under <strong>Records</strong>. What is
                below is the endpoint-level reading, kept for the parts nothing has described.
              </p>
            ) : !relations || relations.resources.every((r) => r.relations.length === 0) ? (
              <p className="dash-hint" data-testid="relations-empty">
                Nothing known yet. Reading this API works out which records belong to which — a
                record you can open to reveal what is inside it.
              </p>
            ) : (
              <>
                <p className="dash-hint">
                  {relations.source === "endpoints"
                    ? "Read from the endpoint URLs alone — nothing has been sampled yet."
                    : relations.source === "stale"
                      ? "The endpoints have changed since this was worked out; read the API again."
                      : `Worked out ${new Date(relations.lastRead ?? "").toLocaleString()}. Edits here outrank anything a later pass infers.`}
                </p>
                <ul className="dash-conn-list" data-testid="relations">
                  {relations.resources.flatMap((resource) =>
                    resource.relations.map((relation) => {
                      const declared = relation.via === "path";
                      const columns = relations.fieldsByResource[relation.resource] ?? [];
                      const current = relation.param ?? relation.foreignField ?? "";
                      return (
                        <li key={`${resource.id}-${relation.id}`}>
                          <div className="dash-conn-list__text">
                            <div className="dash-conn-list__title">
                              {resource.title} → {relation.title}
                            </div>
                            <div className="dash-conn-list__meta">
                              {declared
                                ? `Declared by the API's own URL, via ${relation.op}.`
                                : `Linked on ${current || "an unknown field"} · ${
                                    relation.verified
                                      ? "confirmed against real rows"
                                      : "not yet confirmed"
                                  }`}
                            </div>
                          </div>
                          {!declared &&
                            (columns.length > 0 ? (
                              <select
                                className="dash-control"
                                data-testid={`relation-field-${relation.id}`}
                                value={current}
                                onChange={(event) =>
                                  editRelation(resource.id, relation.id, {
                                    field: event.target.value,
                                  })
                                }
                              >
                                {/* The stored field may predate the sample. */}
                                {!columns.includes(current) && current && (
                                  <option value={current}>{current}</option>
                                )}
                                {columns.map((column) => (
                                  <option key={column} value={column}>
                                    {column}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                className="dash-control"
                                data-testid={`relation-field-${relation.id}`}
                                value={current}
                                onChange={(event) =>
                                  editRelation(resource.id, relation.id, {
                                    field: event.target.value,
                                  })
                                }
                              />
                            ))}
                          {!declared && (
                            <button
                              className="dash-iconbtn dash-danger"
                              data-testid={`relation-remove-${relation.id}`}
                              disabled={busy}
                              onClick={() =>
                                editRelation(resource.id, relation.id, { remove: true })
                              }
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      );
                    }),
                  )}
                </ul>
                <div className="dash-row" style={{ marginBottom: 14 }}>
                  <button
                    className="dash-control"
                    data-testid="save-relations"
                    disabled={busy}
                    onClick={() => void saveRelations()}
                  >
                    {relationsSaved ? "Saved" : "Save these links"}
                  </button>
                </div>
              </>
            )}

            <h4>Endpoints on {managed?.title}</h4>
            <ul className="dash-conn-list" data-testid="managed-ops">
              {(managed?.ops ?? []).map((op) => (
                <li key={op.id}>
                  <div className="dash-conn-list__text">
                    <div className="dash-conn-list__title">{op.title}</div>
                    <div className="dash-conn-list__meta">
                      {op.path} · {op.archetype ?? "list"}
                      {opTest?.opId === op.id && (
                        <>
                          {" — "}
                          <span
                            style={{
                              color: opTest.ok ? "var(--dash-good)" : "var(--dash-critical)",
                            }}
                          >
                            {opTest.text}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    className="dash-iconbtn"
                    data-testid={`test-${op.id}`}
                    onClick={() => void testOp(op.id)}
                    disabled={busy}
                  >
                    Test
                  </button>
                  <button
                    className="dash-iconbtn dash-danger"
                    data-testid={`remove-op-${op.id}`}
                    onClick={() => void removeOp(op.id)}
                    disabled={busy || (managed?.ops.length ?? 0) <= 1}
                    title={
                      (managed?.ops.length ?? 0) <= 1
                        ? "A connection needs at least one endpoint"
                        : "Remove this endpoint"
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            {available.length > 0 && (
              <>
                <h4>Also available from the catalog</h4>
                <ul className="dash-conn-list">
                  {available.map((op) => (
                    <li key={op.id}>
                      <div className="dash-conn-list__text">
                        <div className="dash-conn-list__title">{op.title}</div>
                        <div className="dash-conn-list__meta">
                          {op.path} · {op.archetype}
                        </div>
                      </div>
                      <button
                        className="dash-iconbtn"
                        data-testid={`add-available-${op.id}`}
                        disabled={busy}
                        onClick={() => void addOp(op)}
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h4>Add another</h4>
            <div className="dash-field">
              <label htmlFor="op-title">Name</label>
              <input
                id="op-title"
                data-testid="op-title"
                value={newOp.title}
                placeholder="Items"
                onChange={(event) => setNewOp({ ...newOp, title: event.target.value })}
              />
            </div>
            <div className="dash-field">
              <label htmlFor="op-path">Path</label>
              <input
                id="op-path"
                data-testid="op-path"
                value={newOp.path}
                placeholder="/v1/items"
                onChange={(event) => setNewOp({ ...newOp, path: event.target.value })}
              />
              <span className="dash-hint">
                Relative to {managed?.baseUrl}. Auth, pagination and date filtering are inherited —
                you only give the path.
              </span>
            </div>
            <div className="dash-field">
              <label htmlFor="op-archetype">What does it return?</label>
              <select
                id="op-archetype"
                data-testid="op-archetype"
                value={newOp.archetype}
                onChange={(event) => setNewOp({ ...newOp, archetype: event.target.value })}
              >
                <option value="list">A list of records</option>
                <option value="summary">A single object of totals</option>
                <option value="timeseries">Data already grouped by time</option>
              </select>
            </div>
            <div className="dash-row dash-row--end">
              <button className="dash-control" onClick={() => setView("list")}>
                Done
              </button>
              <button
                className="dash-control"
                data-testid="op-add"
                disabled={busy || newOp.title.trim() === "" || newOp.path.trim() === ""}
                onClick={() =>
                  void addOp({
                    id: newOp.title
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_+|_+$/g, ""),
                    title: newOp.title,
                    path: newOp.path.startsWith("/") ? newOp.path : `/${newOp.path}`,
                    archetype: newOp.archetype,
                  })
                }
              >
                Add endpoint
              </button>
            </div>
          </>
        );

      case "choose":
        return (
          <>
            <StepRail current={view} />
            <h4>Pick an API</h4>
            <div className="dash-cards">
              {catalog.map((option) => (
                <button
                  className="dash-card"
                  key={option.id}
                  data-testid={`catalog-${option.id}`}
                  onClick={() => void startFromCatalog(option)}
                  disabled={busy}
                >
                  <span className="dash-card__title">{option.title}</span>
                  <span className="dash-card__meta">{option.ops.length} ready-made endpoints</span>
                  <span className="dash-card__badges">
                    {/* A dialect written from docs is a hypothesis until proven. */}
                    <span className="dash-pill">
                      <span
                        className="dash-pill__icon"
                        style={{
                          color: option.verified ? "var(--dash-good)" : "var(--dash-muted)",
                        }}
                      >
                        {option.verified ? "●" : "○"}
                      </span>
                      {option.verified ? "response checked" : "response unchecked"}
                    </span>
                    {option.dialect.auth && option.dialect.auth.type !== "none" && (
                      <span className="dash-pill">needs a key</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <h4>Not listed? Point us at its documentation</h4>
            <div className="dash-row">
              <input
                className="dash-control"
                style={{ flex: "1 1 260px" }}
                data-testid="discover-url"
                placeholder="https://docs.example.com/api  or  .../openapi.json"
                value={discoverUrl}
                onChange={(event) => setDiscoverUrl(event.target.value)}
              />
              <button
                className="dash-control"
                data-testid="discover-run"
                disabled={busy || discoverUrl.trim() === ""}
                onClick={() => void runDiscovery()}
              >
                {busy ? "Looking…" : "Find it"}
              </button>
            </div>
            <p className="dash-hint">
              An OpenAPI spec is read exactly. Documentation is read by AI and is a starting point —
              you will test it against the real API in the next step either way.
            </p>

            {discovery && (
              <div
                className={`dash-callout dash-callout--${discovery.entry ? "info" : "bad"}`}
                data-testid="discovery-result"
              >
                <strong>{SOURCE_LABELS[discovery.source]}.</strong> {discovery.note}
                {discovery.entry && (
                  <>
                    <div style={{ marginTop: 8 }}>
                      <strong>{discovery.entry.title}</strong> — {discovery.entry.baseUrl}
                      <br />
                      {discovery.entry.ops.length} endpoint(s) ·{" "}
                      {discovery.entry.dialect.auth?.type === "none" ||
                      !discovery.entry.dialect.auth
                        ? discovery.entry.authRequired
                          ? "authentication needs setup"
                          : "no key"
                        : `${discovery.entry.dialect.auth.type} key`}{" "}
                      ·{" "}
                      {discovery.entry.paginationProposal
                        ? "pagination needs confirmation"
                        : `${discovery.entry.dialect.pagination?.kind ?? "none"} pagination`}
                    </div>
                    <div className="dash-row" style={{ marginTop: 8 }}>
                      <button
                        className="dash-control"
                        data-testid="discover-use"
                        onClick={() => void useDiscovered(discovery.entry!)}
                        disabled={busy}
                      >
                        Use this →
                      </button>
                    </div>
                  </>
                )}
                {discovery.warnings.length > 0 && (
                  <ul className="dash-warnlist" style={{ marginTop: 8 }}>
                    {discovery.warnings.slice(0, 5).map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                )}
                {/*
                 * Offered only when the result is thin.
                 *
                 * Some sites document every endpoint on its own page and
                 * publish no whole-API spec — the material is all there, just
                 * scattered. A site that already handed us a real spec must
                 * never trigger this, or one click becomes hundreds of
                 * pointless requests to their documentation host.
                 */}
                {discovery.index && (!discovery.entry || discovery.entry.ops.length <= 4) && (
                  <div style={{ marginTop: 10 }} data-testid="discovery-index-offer">
                    <p className="dash-hint">
                      This site documents <strong>{discovery.index.pages} page(s)</strong> under{" "}
                      <code>{discovery.index.section}</code>. Reading them all takes about{" "}
                      <strong>
                        {Math.max(1, Math.round(discovery.index.estimatedMs / 1000))} seconds
                      </strong>{" "}
                      and makes one request per page to their documentation site. Link a narrower
                      section to read less.
                    </p>
                    {indexProgress !== null ? (
                      <div
                        className="dash-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(indexProgress * 100)}
                        data-testid="index-progress"
                      >
                        <div
                          className="dash-progress__bar"
                          style={{ width: `${Math.round(indexProgress * 100)}%` }}
                        />
                      </div>
                    ) : (
                      <button
                        className="dash-control"
                        data-testid="discover-read-index"
                        onClick={() => void readWholeIndex()}
                        disabled={busy}
                      >
                        Read all {discovery.index.pages} pages
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 14 }}>
              <button className="dash-control" onClick={() => setView("list")}>
                Back
              </button>
              <button
                className="dash-control"
                data-testid="choose-manual"
                onClick={() => setView("manual")}
              >
                Describe it by hand →
              </button>
            </div>
          </>
        );

      case "manual":
        return (
          <>
            <StepRail current={view} />
            <h4>Describe the API</h4>
            <div className="dash-field">
              <label htmlFor="m-title">Name</label>
              <input
                id="m-title"
                data-testid="m-title"
                value={manual.title}
                placeholder="My API"
                onChange={(e) => setManual({ ...manual, title: e.target.value })}
              />
            </div>
            <div className="dash-field">
              <label htmlFor="m-base">Base URL</label>
              <input
                id="m-base"
                data-testid="m-base"
                value={manual.baseUrl}
                placeholder="https://api.example.com"
                onChange={(e) => setManual({ ...manual, baseUrl: e.target.value })}
              />
            </div>
            <div className="dash-field">
              <label htmlFor="m-auth">How does it authenticate?</label>
              <select
                id="m-auth"
                data-testid="m-auth"
                value={manual.authType}
                onChange={(e) =>
                  setManual({ ...manual, authType: e.target.value as typeof manual.authType })
                }
              >
                {AUTH_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </div>
            {(manual.authType === "header" ||
              manual.authType === "query" ||
              manual.authType === "headers") && (
              <div className="dash-field">
                <label htmlFor="m-authname">
                  {manual.authType === "query"
                    ? "Parameter name"
                    : manual.authType === "headers"
                      ? "First header name"
                      : "Header name"}
                </label>
                <input
                  id="m-authname"
                  data-testid="manual-authname"
                  value={manual.authName}
                  onChange={(e) => setManual({ ...manual, authName: e.target.value })}
                />
              </div>
            )}
            {manual.authType === "headers" && (
              <div className="dash-field">
                <label htmlFor="m-authname2">Second header name</label>
                <input
                  id="m-authname2"
                  data-testid="manual-authname2"
                  value={manual.authName2}
                  onChange={(e) => setManual({ ...manual, authName2: e.target.value })}
                />
                <span className="dash-hint">
                  You will be asked for both values on the next step. APIs that work this way
                  usually pair an id header with a secret header, named in their own docs.
                </span>
              </div>
            )}
            <div className="dash-field">
              <label htmlFor="m-path">First endpoint path</label>
              <input
                id="m-path"
                data-testid="m-path"
                value={manual.opPath}
                placeholder="/v1/items"
                onChange={(e) => setManual({ ...manual, opPath: e.target.value })}
              />
            </div>
            <div className="dash-field">
              <label htmlFor="m-rows">Where is the list in the response?</label>
              <input
                id="m-rows"
                data-testid="m-rows"
                value={manual.rowsPath}
                placeholder="$.data"
                onChange={(e) => setManual({ ...manual, rowsPath: e.target.value })}
              />
              <span className="dash-hint">
                Leave as <code>$.data</code> if you are not sure — the next step shows you what
                actually came back, and you can correct it then.
              </span>
            </div>
            <div className="dash-field">
              <label htmlFor="m-page">How does it paginate?</label>
              <select
                id="m-page"
                value={manual.pagination}
                onChange={(e) =>
                  setManual({ ...manual, pagination: e.target.value as typeof manual.pagination })
                }
              >
                {PAGINATION_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <span className="dash-hint">
                Not sure? Leave it single-page. A wrong guess does not fail loudly — it quietly
                returns the first page only.
              </span>
            </div>
            <div className="dash-row dash-row--end">
              <button className="dash-control" onClick={() => setView("choose")}>
                Back
              </button>
              <button
                className="dash-control"
                data-testid="m-save"
                disabled={busy || !manual.baseUrl}
                onClick={() => void saveManual()}
              >
                Continue
              </button>
            </div>
          </>
        );

      case "address":
        return draft ? (
          <>
            {addressFrom === "wizard" && <StepRail current={view} />}
            <ConnectionAddress
              key={draft.id}
              connection={draft}
              onBack={() => (addressFrom === "wizard" ? setView("choose") : setView("list"))}
              onSaved={(updated) => {
                setDraft(updated);
                onChanged();
                if (addressFrom === "list") {
                  void refresh();
                  setView("list");
                  return;
                }
                setView(updated.hasKey ? "verify" : "key");
              }}
            />
          </>
        ) : (
          <p>Choose a connection first.</p>
        );

      case "key":
        return (
          <>
            <StepRail current={view} />
            <h4>Add a key for {draft?.title}</h4>
            {entry?.keyHelp && (
              <div className="dash-callout dash-callout--info">
                {entry.keyHelp}
                {entry.docsUrl && (
                  <>
                    {" "}
                    <a href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
                      Open the docs →
                    </a>
                  </>
                )}
              </div>
            )}
            {describingAuth && (
              <>
                {authUndeclared ? (
                  <div className="dash-callout dash-callout--info" data-testid="auth-undeclared">
                    This API needs an API key to function.
                  </div>
                ) : (
                  <div className="dash-callout dash-callout--info" data-testid="auth-override">
                    Describe how {draft?.title} expects its key. This replaces what its
                    documentation said.
                  </div>
                )}
                <div className="dash-field">
                  <label htmlFor="k-authtype">How is the key sent?</label>
                  <select
                    id="k-authtype"
                    data-testid="key-authtype"
                    value={keyAuth.type}
                    onChange={(e) =>
                      setKeyAuth({
                        ...keyAuth,
                        type: e.target.value as (typeof AUTH_KINDS)[number]["value"],
                      })
                    }
                  >
                    {AUTH_KINDS.filter((kind) => kind.value !== "none").map((kind) => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                  <span className="dash-hint">
                    {authUndeclared
                      ? "The description did not say, so it has to be filled in here. Bearer is the most common; check the API docs if you are unsure."
                      : "Check the API docs' example requests: they show which header, parameter or login the key goes in."}
                  </span>
                </div>
                {keyAuth.type === "header" && (
                  <div className="dash-field">
                    <label htmlFor="k-prefix">Before the key (optional)</label>
                    <input
                      id="k-prefix"
                      data-testid="key-prefix"
                      value={keyAuth.prefix}
                      placeholder="e.g. Token"
                      onChange={(e) => setKeyAuth({ ...keyAuth, prefix: e.target.value })}
                    />
                    <span className="dash-hint">
                      Some APIs want a word before the key, like <code>Token abc123</code>. Leave
                      empty to send the key alone.
                    </span>
                  </div>
                )}
              </>
            )}

            {/*
              Each credential is one block: what it is called, immediately
              followed by its value. Listing every name and then every value
              separately makes the reader hold the pairing in their head and
              guess which box belongs to which header.
            */}
            {keyRows.map((row, index) => (
              <fieldset className="dash-keyblock" key={row.keyRef}>
                {row.legend && <legend>{row.legend}</legend>}
                {row.nameValue !== null && (
                  <div className="dash-field">
                    <label htmlFor={`k-name-${row.keyRef}`}>{row.nameLabel}</label>
                    <input
                      id={`k-name-${row.keyRef}`}
                      data-testid={index === 0 ? "key-authname" : `key-authname${index + 1}`}
                      value={row.nameValue}
                      onChange={(e) => row.onNameChange?.(e.target.value)}
                    />
                  </div>
                )}
                <div className="dash-field">
                  <label htmlFor={`k-${row.keyRef}`}>{row.valueLabel}</label>
                  <input
                    id={`k-${row.keyRef}`}
                    data-testid={index === 0 ? "key-input" : `key-input-${index}`}
                    type="password"
                    autoComplete="off"
                    value={keyValues[row.keyRef] ?? ""}
                    onChange={(e) =>
                      setKeyValues((current) => ({ ...current, [row.keyRef]: e.target.value }))
                    }
                  />
                  {row.hint && <span className="dash-hint">{row.hint}</span>}
                </div>
              </fieldset>
            ))}
            {describingAuth && keyAuth.type === "headers" && (
              <div className="dash-row" style={{ gap: 8 }}>
                {keyAuth.names.length < MAX_AUTH_HEADERS && (
                  <button
                    className="dash-control"
                    data-testid="key-add-header"
                    onClick={() =>
                      setKeyAuth({ ...keyAuth, names: [...keyAuth.names, ""] })
                    }
                  >
                    Add another header
                  </button>
                )}
                {keyAuth.names.length > 1 && (
                  <button
                    className="dash-control"
                    data-testid="key-remove-header"
                    onClick={() =>
                      setKeyAuth({ ...keyAuth, names: keyAuth.names.slice(0, -1) })
                    }
                  >
                    Remove the last header
                  </button>
                )}
              </div>
            )}
            <span className="dash-hint">
              Stored encrypted on your own server. {keyRows.length > 1 ? "They are" : "It is"} never
              written into a dashboard file and never sent back to this page.
            </span>
            {/*
             * The documentation can be wrong about how a key is sent, and an
             * import that trusted it would otherwise leave no way to say so.
             */}
            {!authUndeclared && draft?.auth.type !== "none" && (
              <p className="dash-hint">
                <button
                  className="dash-control"
                  data-testid="key-override"
                  onClick={() => {
                    setOverridingAuth((previous) => !previous);
                    setKeyValues({});
                  }}
                >
                  {overridingAuth
                    ? "Use what the documentation says"
                    : `Not how ${draft?.title ?? "this API"} does it? Choose how the key is sent`}
                </button>
              </p>
            )}
            <div className="dash-row dash-row--end">
              <button
                className="dash-control"
                onClick={() => setView(draft?.server || draft?.addressPending ? "address" : "choose")}
              >
                Back
              </button>
              <button
                className="dash-control"
                data-testid="key-save"
                disabled={
                  busy ||
                  keyRows.some((r) => (keyValues[r.keyRef] ?? "").trim() === "") ||
                  keyRows.some((r) => r.nameValue !== null && r.nameValue.trim() === "")
                }
                onClick={() => void submitKey()}
              >
                {keyRows.length > 1 ? "Save keys" : "Save key"}
              </button>
            </div>
          </>
        );

      case "verify":
        return (
          <>
            <StepRail current={view} />
            <h4>Check it works</h4>
            {!validation && (
              <p className="dash-hint">
                This calls {draft?.title} for real and shows you what comes back.
              </p>
            )}

            {validation && (
              <div className={`dash-callout dash-callout--${validation.ok ? "good" : "bad"}`}>
                <strong>{validation.ok ? "Connected." : "Could not connect."}</strong>{" "}
                {validation.message}
              </div>
            )}

            {sample && (
              <>
                <h4>What came back</h4>
                <p className="dash-hint">
                  Found {sample.rowCount} record(s) at <code>{sample.rowsPath}</code>
                  {sample.meta.pages > 1 ? ` across ${sample.meta.pages} pages` : ""}
                  {sample.meta.truncated ? " (stopped at the page cap)" : ""}.
                </p>
                <table className="dash-steps" data-testid="sample-fields">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sample.fields.slice(0, 12).map((field) => (
                      <tr key={field.name}>
                        <td>{field.name}</td>
                        <td>
                          {field.kinds.join("|")}
                          {field.format ? ` · ${field.format}` : ""}
                        </td>
                        <td>
                          <code>{JSON.stringify(field.samples[0] ?? null).slice(0, 40)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sample.fields.length > 12 && (
                  <p className="dash-hint">…and {sample.fields.length - 12} more fields.</p>
                )}
              </>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 12 }}>
              <button
                className="dash-control"
                onClick={() => setView(draft?.hasKey ? "key" : "choose")}
              >
                Back
              </button>
              <button
                className="dash-control"
                data-testid="verify-run"
                disabled={busy}
                onClick={() => void verify()}
              >
                {busy ? "Calling the API…" : validation ? "Try again" : "Test the connection"}
              </button>
              {validation?.ok && (
                <button
                  className="dash-control"
                  data-testid="verify-next"
                  onClick={() => setView("endpoints")}
                >
                  Continue →
                </button>
              )}
            </div>
          </>
        );

      case "endpoints":
        return (
          <>
            <StepRail current={view} />
            <h4>Which endpoints do you want?</h4>
            <ul className="dash-checklist">
              {(draft?.ops ?? []).map((op) => (
                <li key={op.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`op-${op.id}`}
                      checked={chosenOps.includes(op.id)}
                      onChange={(e) =>
                        setChosenOps((previous) =>
                          e.target.checked
                            ? [...previous, op.id]
                            : previous.filter((id) => id !== op.id),
                        )
                      }
                    />
                    <span>
                      <span className="dash-checklist__name">{op.title}</span>
                      <div className="dash-checklist__meta">
                        {op.path} · {op.archetype ?? "list"}
                      </div>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="dash-row dash-row--end" style={{ marginTop: 12 }}>
              <button className="dash-control" onClick={() => setView("verify")}>
                Back
              </button>
              <button
                className="dash-control"
                data-testid="finish"
                disabled={busy || chosenOps.length === 0}
                onClick={() => void finish()}
              >
                Done
              </button>
            </div>
          </>
        );

      case "dashboards": {
        if (!onboardingFor) return <p>Choose a connection first.</p>;
        return (
          <>
            {/* Only a step when it is one: reached from a connection's
             * Dashboards button, this is a screen of its own. */}
            {draftId && <StepRail current={view} />}
            <ConnectionOnboarding
              key={onboardingFor.id}
              connection={onboardingFor}
              onChanged={onChanged}
              onDone={closeWizard}
              onOpen={(dashboardId) => {
                onChanged();
                if (onOpenDashboard) onOpenDashboard(dashboardId);
                else closeWizard();
              }}
              onRhythm={() => void openRhythm(onboardingFor.id)}
            />
          </>
        );
      }

      case "rhythm": {
        const endpoints = rhythm?.endpoints ?? [];
        /*
         * The ones a board actually reads, first and by default.
         *
         * A real API has two hundred endpoints and somebody has boards on
         * eleven of them. Those eleven are the only ones whose freshness
         * anybody will ever notice; the rest are read when something asks and
         * are listed only if somebody goes looking.
         */
        const onBoards = endpoints.filter((one) => one.warmed || one.source === "override");
        const rest = endpoints.filter((one) => !onBoards.includes(one));
        const listed = showAllEndpoints ? [...onBoards, ...rest] : onBoards;

        const everyPhrase = (ms: number): string => {
          const minutes = Math.round(ms / 60_000);
          if (minutes < 60) return `every ${minutes} min`;
          const hours = Math.round(minutes / 60);
          return hours < 48 ? `every ${hours} h` : `every ${Math.round(hours / 24)} days`;
        };

        return (
          <>
            {draftId && <StepRail current={view} />}
            <h4>How often should we check for new records?</h4>
            <p className="dash-page__description">
              Your boards read from what we have already fetched, so opening one never waits and
              never spends your API. We top it up in the background instead — and how often is
              worth asking is different for each kind of record.
            </p>

            {rhythm && !rhythm.classified && (
              <div className="dash-callout" data-testid="rhythm-unclassified">
                Nothing has read this API for how often its records change, so everything is on
                the quickest schedule. That is the safe direction &mdash; it costs a few requests
                rather than showing you yesterday&rsquo;s numbers &mdash; and you can move
                anything below.
              </div>
            )}

            {listed.length === 0 ? (
              <div className="dash-callout" data-testid="rhythm-empty">
                Nothing is being kept warm for this connection yet. Once a board reads an
                endpoint it will appear here.
              </div>
            ) : (
              <ul className="dash-checklist" data-testid="rhythm-endpoints">
                {listed.map((endpoint) => (
                  <li key={endpoint.op}>
                    <span style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <select
                        className="dash-control"
                        data-testid={`rhythm-${endpoint.op}`}
                        value={endpoint.tier}
                        disabled={busy}
                        onChange={(event) => void moveEndpoint(endpoint.op, event.target.value)}
                      >
                        {(rhythm?.tiers ?? []).map((tier) => (
                          <option key={tier.id} value={tier.id}>
                            {everyPhrase(tier.everyMs)}
                          </option>
                        ))}
                      </select>
                      <span>
                        <span className="dash-checklist__name">
                          {endpoint.records ?? endpoint.title}
                        </span>
                        <div className="dash-checklist__meta">
                          {/*
                           * Why it landed there, and who said so. A cadence
                           * with no reason is a setting to shrug at rather
                           * than a claim somebody can check.
                           */}
                          {endpoint.source === "override"
                            ? "You moved this one."
                            : endpoint.source === "measured"
                              ? "Set from what we have seen change on your account."
                              : (endpoint.because ??
                                (endpoint.source === "model"
                                  ? "Read from what this kind of record is."
                                  : "Nothing has said how often this changes, so it is checked often."))}
                          {endpoint.warmed ? "" : " · not on a board"}
                        </div>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {rest.length > 0 && (
              <p className="dash-hint">
                <button
                  className="dash-control"
                  data-testid="rhythm-show-all"
                  onClick={() => setShowAllEndpoints((previous) => !previous)}
                >
                  {showAllEndpoints
                    ? "Show only what my boards read"
                    : `Show the other ${rest.length} endpoint(s)`}
                </button>{" "}
                &mdash; these are only read when something asks for them, so their schedule
                rarely matters.
              </p>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 12 }}>
              <button
                className="dash-control dash-control--primary"
                data-testid="rhythm-done"
                onClick={closeWizard}
              >
                Done
              </button>
            </div>
          </>
        );
      }

      case "read":
        return (
          <>
            <StepRail current={view} />

            {/*
             * The integration gate.
             *
             * "Does this integration exist?" is a question about the API, not
             * about this account — so it is asked before the read, answered
             * once, and the answer is shareable. An unmapped API still works;
             * what it lacks is the descriptions that let the assistant tell
             * two hundred endpoints apart, which is why the offer explains
             * what mapping buys rather than just asking for a yes.
             */}
            {mapInfo && !mapInfo.mapped && !mapRun && (
              <div className="dash-callout" data-testid="map-gate">
                <p>
                  <strong>This integration does not exist yet.</strong> Would you like to create it?
                </p>
                <p className="dash-hint">
                  {draft?.title ?? "This API"} has {mapInfo.endpoints} endpoints, and{" "}
                  {mapInfo.described} of them describe themselves. Creating the integration reads
                  the rest — what each endpoint returns, and how its records relate — so the
                  assistant can find the right one from a plain description, and then what each
                  kind of record <em>is</em>: its name, what its fields mean, and which of them
                  point at other records. That second half is what lets a widget show a name where
                  the API stores a number.
                </p>
                <p className="dash-hint">
                  {mapInfo.wouldSample === 0
                    ? "It makes no requests against your API: everything needed is in the API's own specification. The cost is in AI usage, and it is paid once — the result describes the API rather than your account, so it is the same for everyone and never has to be worked out again."
                    : `It makes about ${mapInfo.wouldSample} request(s) against your API for the endpoints the specification does not describe. The rest costs AI usage, paid once.`}
                </p>
                {!mapInfo.canRun && (
                  <p className="dash-hint">
                    This needs an AI key. Everything else still works without one — you would be
                    choosing endpoints by hand rather than describing what you want.
                  </p>
                )}
                <div className="dash-row dash-row--end" style={{ marginTop: 8 }}>
                  <button
                    className="dash-control dash-control--primary"
                    data-testid="map-run"
                    disabled={busy || mapping || !mapInfo.canRun}
                    onClick={() => void runMap()}
                  >
                    {mapping ? "Reading and describing…" : "Create integration"}
                  </button>
                </div>
              </div>
            )}

            {mapRun && (
              <div
                className={`dash-callout ${mapRun.errors.length > 0 ? "" : "dash-callout--good"}`}
                data-testid="map-done"
              >
                Integration created — {mapRun.described} of {mapRun.endpoints} endpoints described
                {mapRun.relationsFound > 0
                  ? `, and ${mapRun.relationsFound} relationship(s) found between them`
                  : ""}
                .
                {/*
                 * Batches fail independently, so a partial map is a real
                 * outcome and has to say so rather than looking complete.
                 */}
                {mapRun.errors.length > 0 && (
                  <>
                    {" "}
                    {mapRun.errors.length} part(s) did not finish; running it again picks up where
                    it stopped.
                  </>
                )}
              </div>
            )}

            {(recordsPending || mapInfo?.describing) && (
              <div className="dash-callout dash-callout--info" data-testid="records-pending" role="status">
                <strong>Still working out what {draft?.title ?? "this API"}&rsquo;s records are</strong>{" "}
                &mdash; {mapInfo?.records?.entities ?? 0} record type(s) so far. This reads the
                documentation, not your account, and takes a few minutes on a large API. You can
                start reading meanwhile; setting up dashboards waits for it and carries on by
                itself.
              </div>
            )}
            {recordsFailed && !recordsPending && (
              <div className="dash-callout" data-testid="records-failed">
                Describing the record types stopped: {recordsFailed} What was done is kept, and it
                can be run again from Records.
              </div>
            )}

            {mapInfo?.mapped && !mapRun && (
              <div className="dash-callout" data-testid="map-ready">
                This integration already exists — {mapInfo.described} of {mapInfo.endpoints}{" "}
                endpoints described. Nothing to create.
              </div>
            )}

            <h4>Shall we read this API?</h4>

            {readResult ? (
              <>
                <div className="dash-callout dash-callout--good" data-testid="read-done">
                  Read {readResult.resources.length} resource(s) using {readResult.requestsSpent}{" "}
                  request(s).
                  {readResult.outcome === "rateLimited" &&
                    ` Stopped early — ${draft?.title ?? "the API"} began rate limiting${
                      readResult.retryAfter ? `; try again in ${readResult.retryAfter}s` : ""
                    }.`}
                  {readResult.outcome === "authRejected" &&
                    " Stopped early — the credential was rejected."}
                  {readResult.outcome === "budget" &&
                    " There is more to read; you can look deeper later."}
                </div>
                {readResult.notes.length > 0 && (
                  <ul className="dash-hint">
                    {readResult.notes.slice(0, 4).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : readProgress !== null ? (
              <>
                <p className="dash-page__description">
                  Reading {draft?.title ?? "the API"} — deliberately slowly, so we never look like a
                  burst of traffic.
                </p>
                <div
                  className="dash-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(readProgress * 100)}
                  data-testid="read-progress"
                >
                  <div
                    className="dash-progress__bar"
                    style={{ width: `${Math.round(readProgress * 100)}%` }}
                  />
                </div>
              </>
            ) : plan?.alreadyRead ? (
              <div className="dash-callout" data-testid="read-cached">
                Already read{plan.lastRead ? ` on ${new Date(plan.lastRead).toLocaleString()}` : ""}
                . Nothing to spend — reading again is only useful if the API has changed.
              </div>
            ) : plan && plan.estimatedRequests === 0 ? (
              /*
               * Honest, and worth saying plainly. Reading learns identity and
               * relations from a collection's rows; an API whose endpoints form
               * no list/detail pair has none to learn from, so there is nothing
               * to spend and offering to spend it would be theatre.
               */
              <div className="dash-callout" data-testid="read-nothing">
                There is nothing to read here yet. Reading looks for endpoints that list records
                alongside one that opens a single record, and {draft?.title ?? "this API"} has no
                such pair. Your endpoints still work — widgets built on them just will not get
                drill-downs offered automatically.
              </div>
            ) : (
              <>
                <p className="dash-page__description" data-testid="read-estimate">
                  This will make about{" "}
                  <strong>
                    {plan?.estimatedRequests ?? "—"}{" "}
                    {plan?.estimatedRequests === 1 ? "request" : "requests"}
                  </strong>{" "}
                  to {draft?.title ?? "this API"}
                  {plan && plan.estimatedMs >= 1000
                    ? `, spread over about ${Math.round(plan.estimatedMs / 1000)} seconds`
                    : ""}
                  .
                </p>
                <div className="dash-callout">
                  For almost every API that is harmless. The one case worth checking first is
                  whether <strong>{draft?.title ?? "this API"} charges per request</strong> — if it
                  does, those requests cost money.
                </div>
                <p className="dash-hint">
                  Reading is how we learn which field on a row is its id, which records link to
                  which, and what a widget can be built from. You can skip it and do it later.
                </p>
              </>
            )}

            <div className="dash-row dash-row--end" style={{ marginTop: 12 }}>
              {readResult || plan?.alreadyRead || plan?.estimatedRequests === 0 ? (
                <button
                  className="dash-control dash-control--primary"
                  data-testid="read-close"
                  disabled={busy || !draftId}
                  onClick={() => draftId && void openOnboarding(draftId)}
                >
                  Next
                </button>
              ) : (
                <>
                  <button
                    className="dash-control"
                    data-testid="read-skip"
                    disabled={busy || !draftId}
                    onClick={() => draftId && void openOnboarding(draftId)}
                  >
                    Skip for now
                  </button>
                  <button
                    className="dash-control"
                    data-testid="read-start"
                    disabled={busy || readProgress !== null}
                    onClick={() => void startReading()}
                  >
                    {readProgress !== null ? "Reading…" : "Start reading"}
                  </button>
                </>
              )}
            </div>
          </>
        );
    }
  };

  return (
    <div
      className="dash-inspector-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dash-inspector"
        role="dialog"
        aria-modal="true"
        aria-label="Connections"
        /* A previewed board needs the width a board has. */
        style={view === "dashboards" ? { width: "min(1280px, 100%)" } : undefined}
      >
        <div className="dash-inspector__head">
          <h3 className="dash-inspector__title">Connections</h3>
          <button
            className="dash-iconbtn"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="dash-inspector__body">
          {error && (
            <div className="dash-callout dash-callout--bad" data-testid="conn-error">
              {error}
            </div>
          )}
          {body()}
        </div>
      </div>
    </div>
  );
};
