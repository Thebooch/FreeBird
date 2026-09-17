import { useEffect, useState } from "react";
import type { IntegrationActivationReview, PreparationJob } from "@freebirdai/dash-spec";
import { api } from "./api.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The connection could not be prepared.";
const capabilityLabel = {
  verified: "Available",
  unverified: "Not yet confirmed",
  contradicted: "Could not be verified",
};

/** The server owns budgets, leases and evidence. Closing this panel never
 * starts a second job or erases an approved job's checkpoints.
 */
export const IntegrationPreparation = ({
  connection,
  title,
  onBack,
  onActivated,
}: {
  connection: string;
  title: string;
  onBack: () => void;
  onActivated: () => void;
}) => {
  const [available, setAvailable] = useState<boolean>();
  const [job, setJob] = useState<PreparationJob>();
  const [review, setReview] = useState<IntegrationActivationReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    void api.preparationStatus(connection).then(
      (status) => {
        if (cancelled) return;
        setAvailable(status.available);
        setJob(status.jobs[0]);
      },
      (failure) => {
        if (!cancelled) setError(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, refresh]);

  useEffect(() => {
    if (!job || !["running", "queued"].includes(job.state)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.preparationJob(job.id);
        if (cancelled) return;
        setJob((current) =>
          current?.id === next.id && next.revision >= current.revision ? next : current,
        );
        if (["running", "queued"].includes(next.state)) timer = setTimeout(() => void poll(), 3000);
      } catch (failure) {
        if (!cancelled) setError(message(failure));
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.state]);

  useEffect(() => {
    setReview(undefined);
    if (job?.state !== "complete") return;
    let cancelled = false;
    void api.reviewIntegration(job.id).then(
      (result) => {
        if (!cancelled) setReview(result);
      },
      (failure) => {
        if (!cancelled) setError(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [job?.id, job?.state, refresh]);

  useEffect(() => {
    if (!job?.notBefore || job.notBefore <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.notBefore]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const estimate = () =>
    perform(async () => {
      setJob(await api.estimatePreparation(connection));
      setReview(undefined);
    });
  const run = (approved: PreparationJob) =>
    perform(async () => {
      const next = await api.runPreparation(approved);
      setJob((current) =>
        current?.id === next.id && current.revision > next.revision ? current : next,
      );
    });
  const cooldown = job?.notBefore ? Math.max(0, Math.ceil((job.notBefore - now) / 1000)) : 0;
  const exhausted =
    job && job.reservedApiRequests >= job.estimate.maxApiRequests && job.state === "paused";

  return (
    <section aria-label={`Prepare ${title}`}>
      <button className="dash-control" type="button" onClick={onBack}>
        ‹ Connections
      </button>
      <h4>Prepare record links</h4>
      <p>
        Check how records in {title} relate, so their links can be reused throughout the record
        browser.
      </p>
      <p className="dash-hint">
        This checks relationships already described by the integration. Full automatic discovery is
        still being built.
      </p>
      {error && (
        <p role="alert" className="dash-callout dash-callout--bad">
          {error}
        </p>
      )}
      {available === undefined && !error && <p role="status">Loading preparation…</p>}
      {available === false && (
        <p>
          This connection needs an imported integration definition before its record links can be
          checked.
        </p>
      )}
      {available && !job && (
        <button className="dash-control" disabled={busy} onClick={() => void estimate()}>
          Estimate checks
        </button>
      )}
      {job && (
        <>
          {job.state === "awaiting-approval" && (
            <>
              <p>
                Up to <strong>{job.estimate.maxApiRequests} API reads</strong>, taking approximately{" "}
                {Math.max(1, Math.ceil(job.estimate.expectedSeconds / 60))} minute(s).
              </p>
              <p>
                {job.estimate.maxModelUsd === 0
                  ? "No model calls are needed for these checks."
                  : `Model spending is capped at $${job.estimate.maxModelUsd.toFixed(2)}.`}{" "}
                Your API's own usage charges still apply.
              </p>
              <button
                className="dash-control"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const approved = await api.approvePreparation(job);
                    setJob(approved);
                    const finished = await api.runPreparation(approved);
                    setJob((current) =>
                      current?.id === finished.id && current.revision > finished.revision
                        ? current
                        : finished,
                    );
                  })
                }
              >
                Approve budget and check links
              </button>
            </>
          )}
          {["queued", "running", "paused"].includes(job.state) && (
            <>
              <p role="status">
                {job.state === "paused"
                  ? "Checks paused. Completed checks have been saved."
                  : "Checking record links…"}
              </p>
              <p>
                Request budget used: {job.reservedApiRequests} of {job.estimate.maxApiRequests}.{" "}
                {job.completed.length} checks completed.
              </p>
              {cooldown > 0 && (
                <p>The API asked us to wait. Checks can resume in {cooldown} seconds.</p>
              )}
              {exhausted ? (
                <p>
                  The approved budget has been used. A new estimate is required to run more checks.
                </p>
              ) : (
                <button
                  className="dash-control"
                  disabled={busy || cooldown > 0}
                  onClick={() => void run(job)}
                >
                  {job.state === "paused" ? "Resume approved checks" : "Continue approved checks"}
                </button>
              )}
            </>
          )}
          {job.state === "failed" && (
            <p role="status">
              These checks could not finish. You can request a new estimate after reviewing the
              connection.
            </p>
          )}
          {job.state === "complete" && (
            <>
              <p role="status">Checks finished. Some links may still be unavailable.</p>
              {!review && !error && <p>Reviewing the result…</p>}
              {review && (
                <>
                  {review.relationships.length === 0 ? (
                    <p>No relationships were declared for this integration.</p>
                  ) : (
                    <ul>
                      {review.relationships.map((relation, index) => (
                        <li key={index}>
                          {relation.title}: {capabilityLabel[relation.after]}
                        </li>
                      ))}
                    </ul>
                  )}
                  {review.blockers.map((blocker) => (
                    <p key={blocker} role="alert">
                      {blocker}
                    </p>
                  ))}
                  {review.alreadyActive ? (
                    <p role="status">These results are active for this connection.</p>
                  ) : (
                    review.compatible && (
                      <>
                        <p>
                          Use these results to enable confirmed links. Links that could not be
                          confirmed will remain unavailable. Existing dashboard calculations keep
                          their current setup.
                        </p>
                        <button
                          className="dash-control"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              setReview(await api.activateIntegration(job.id, review));
                              onActivated();
                            })
                          }
                        >
                          Use verified links
                        </button>
                      </>
                    )
                  )}
                </>
              )}
            </>
          )}
          {["failed", "complete", "paused"].includes(job.state) ||
          (error && job.state === "queued") ? (
            <button className="dash-control" disabled={busy} onClick={() => void estimate()}>
              Get a new estimate
            </button>
          ) : null}
          <details style={{ marginTop: 16 }}>
            <summary>Technical details</summary>
            <p>
              State: {job.state}. Version: {job.resultVersion ?? job.target?.version ?? "Pending"}.
            </p>
            <p>Checkpoints: {job.completed.join(", ") || "None yet"}.</p>
          </details>
        </>
      )}
      {error && (
        <button
          className="dash-control"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          Reload status
        </button>
      )}
    </section>
  );
};
