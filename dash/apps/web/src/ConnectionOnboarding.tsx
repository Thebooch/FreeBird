import { useEffect, useMemo, useRef, useState } from "react";
import { AdapterRegistry, ProxyAdapter } from "@freebirdai/dash-adapters";
import { Dashboard } from "@freebirdai/dash-react";
import type { OnboardingChoices, OnboardingPreview, OnboardingStatus } from "@freebirdai/dash-spec";
import { api } from "./api.js";
import type { ConnectionSummary } from "./api.js";

export const ConnectionOnboarding = ({
  connection,
  onSkip,
  onOpen,
}: {
  connection: ConnectionSummary;
  onSkip: () => void;
  onOpen: (id: string) => void;
}): JSX.Element => {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [choices, setChoices] = useState<OnboardingChoices>({
    categoryIds: [],
    organization: "combined",
  });
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [activity, setActivity] = useState("Preparing your starting dashboards");
  const mounted = useRef(false);
  const registry = useMemo(
    () =>
      new AdapterRegistry().register(new ProxyAdapter(connection.kind)).addConnection(connection),
    [connection],
  );
  const accept = (next: OnboardingStatus): void => {
    setStatus(next);
    if (next.state?.choices) setChoices(next.state.choices);
    setPreview(next.state?.preview ?? null);
  };
  const run = async (
    work: () => Promise<void>,
    label = "Preparing your starting dashboards",
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setActivity(label);
    try {
      await work();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "Setup could not finish. Retry to continue.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const prepare = async (initial: OnboardingStatus): Promise<void> => {
    let next = initial;
    while (
      mounted.current &&
      next.canPrepare &&
      (next.stale ||
        !next.template ||
        next.template.categories.some((category) => category.status !== "ready"))
    ) {
      next = await api.prepareOnboarding(connection.id);
      if (!mounted.current) return;
      accept(next);
      if (
        next.template?.categories.some((category) => category.status === "failed") &&
        !next.template.categories.some((category) => category.status === "pending")
      )
        break;
    }
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void run(async () => {
      const next = await api.onboarding(connection.id);
      if (cancelled) return;
      accept(next);
      if (!["complete", "creating"].includes(next.state?.status ?? "")) await prepare(next);
    });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
    // A connection has one onboarding session; changes are read through its status endpoint.
  }, [connection.id]);

  const create = (): void => {
    void run(async () => {
      if (!preview) return;
      const result = await api.commitOnboarding(connection.id, preview.id);
      if (result.dashboardIds[0]) onOpen(result.dashboardIds[0]);
    }, "Creating dashboards");
  };

  const completed = status?.state?.status === "complete";
  const creating = status?.state?.status === "creating";
  const categories = status?.template?.categories ?? [];
  return (
    <section data-testid="connection-onboarding" aria-busy={busy}>
      <h3>Set up your dashboards</h3>
      <p className="dash-hint">
        Choose a starting point for {connection.title}. You can edit every widget and tab afterward.
      </p>
      {error && (
        <p role="alert" className="dash-callout dash-callout--bad">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {activity}
          {activity === "Preparing your starting dashboards" && categories.length
            ? ` — ${categories.filter((category) => category.status === "ready").length} of ${categories.length} categories ready`
            : ""}
          …
        </p>
      )}
      {error && (
        <button
          className="dash-control"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await api.onboarding(connection.id);
              accept(next);
              if (!["complete", "creating"].includes(next.state?.status ?? "")) await prepare(next);
            })
          }
        >
          Reload setup
        </button>
      )}
      {completed ? (
        <>
          <p>Your dashboards are ready.</p>
          {status.state!.dashboardIds.map((id, index) => (
            <button className="dash-control" key={id} onClick={() => onOpen(id)}>
              Open {status.state?.preview?.dashboards[index]?.title ?? "dashboard"}
            </button>
          ))}
          <button
            className="dash-control"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await api.restartOnboarding(connection.id);
                accept(next);
                await prepare(next);
              })
            }
          >
            Create another set
          </button>
        </>
      ) : creating ? (
        <>
          <p>Dashboard creation was interrupted. Continue to finish the same tabs.</p>
          <button className="dash-control dash-control--primary" disabled={busy} onClick={create}>
            Finish creating dashboards
          </button>
          {error && (
            <button
              className="dash-control"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await api.restartOnboarding(connection.id);
                  accept(next);
                  await prepare(next);
                })
              }
            >
              Start another setup (keep saved tabs)
            </button>
          )}
        </>
      ) : (
        <>
          {status?.template && <p>{status.template.purpose}</p>}
          {status?.reason && !status.template && <p className="dash-callout">{status.reason}</p>}
          {(status?.stale ||
            categories.some((category) => category.status !== "ready") ||
            (!status?.template && error)) && (
            <button
              className="dash-control"
              disabled={busy || !status?.canPrepare}
              onClick={() => status && void run(() => prepare(status))}
            >
              Retry preparation
            </button>
          )}
          {categories.length > 0 && !status?.stale && (
            <>
              <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
                <legend>{status?.template?.categoryQuestion}</legend>
                <div style={{ display: "grid", gap: 12, margin: "12px 0" }}>
                  {categories.map((category) => (
                    <label key={category.id} className="dash-callout" style={{ display: "block" }}>
                      <input
                        type="checkbox"
                        disabled={category.status !== "ready"}
                        checked={choices.categoryIds.includes(category.id)}
                        onChange={(event) => {
                          setPreview(null);
                          setChoices({
                            ...choices,
                            categoryIds: event.target.checked
                              ? [...choices.categoryIds, category.id]
                              : choices.categoryIds.filter((id) => id !== category.id),
                          });
                        }}
                      />{" "}
                      <strong>{category.title}</strong>
                      <p>{category.description}</p>
                      <small>
                        {category.status === "ready"
                          ? category.widgets.map((widget) => widget.title).join(" · ")
                          : (category.error ?? "Preparing…")}
                      </small>
                    </label>
                  ))}
                </div>
                {choices.categoryIds.length > 1 && (
                  <>
                    <p>{status?.template?.organizationQuestion}</p>
                    <label>
                      <input
                        type="radio"
                        name="onboarding-organization"
                        checked={choices.organization === "combined"}
                        onChange={() => {
                          setPreview(null);
                          setChoices({ ...choices, organization: "combined" });
                        }}
                      />{" "}
                      One {connection.title} tab
                    </label>{" "}
                    <label>
                      <input
                        type="radio"
                        name="onboarding-organization"
                        checked={choices.organization === "separate"}
                        onChange={() => {
                          setPreview(null);
                          setChoices({ ...choices, organization: "separate" });
                        }}
                      />{" "}
                      Separate category tabs
                    </label>
                  </>
                )}
              </fieldset>
              <div className="dash-row dash-row--end" style={{ marginTop: 16 }}>
                <button
                  className="dash-control"
                  disabled={busy || !choices.categoryIds.length}
                  onClick={() =>
                    void run(async () => {
                      accept(await api.chooseOnboarding(connection.id, choices));
                      const next = await api.previewOnboarding(connection.id);
                      setPreview(next);
                      setActive(0);
                    }, "Checking access to the selected widgets")
                  }
                >
                  {preview ? "Retry access checks" : "Preview dashboards"}
                </button>
                {preview && (
                  <button
                    className="dash-control dash-control--primary"
                    disabled={busy || !preview.dashboards.length}
                    onClick={create}
                  >
                    Create dashboards
                  </button>
                )}
              </div>
              {preview && (
                <>
                  {preview.verification
                    .filter((one) => one.status !== "ready")
                    .map((one) => (
                      <p className="dash-callout" key={`${one.categoryId}-${one.widgetId}`}>
                        <strong>{one.title}:</strong> {one.message} This widget is excluded.
                      </p>
                    ))}
                  {!preview.dashboards.length && (
                    <p>
                      No widgets could be verified. Retry access checks or choose another category.
                    </p>
                  )}
                  {preview.dashboards.length > 1 && (
                    <div className="dash-row">
                      {preview.dashboards.map((board, index) => (
                        <button
                          className="dash-control"
                          key={board.id}
                          aria-pressed={active === index}
                          onClick={() => setActive(index)}
                        >
                          {board.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {preview.dashboards[active] && (
                    <div style={{ minWidth: 0, marginTop: 16 }}>
                      <Dashboard
                        key={preview.dashboards[active].id}
                        dashboard={preview.dashboards[active]}
                        registry={registry}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      <div className="dash-row dash-row--end" style={{ marginTop: 16 }}>
        <button
          className="dash-control"
          onClick={() => {
            mounted.current = false;
            void api.skipOnboarding(connection.id).catch(() => {});
            onSkip();
          }}
        >
          {completed || creating ? "Close" : "Skip for now"}
        </button>
      </div>
    </section>
  );
};
