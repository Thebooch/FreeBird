import { AgentChip, Badge, Button } from "@freebirdai/dash-components";
import { WriteReview } from "@freebirdai/dash-react";
import { BASE_INFO, describeDuration, type AgentSpec, type ActionBase, type Task, type WriteReviewView } from "@freebirdai/dash-spec";
import { useState } from "react";
import { api } from "../../api";

/**
 * One task: the record of one action in one case, shown the way its kind
 * reads best, with what a person can do about it.
 *
 * - Waiting for approval: Review (a change opens as its review, prepared now)
 *   or Approve, with "Approve always", and Decline.
 * - A question for the team: its options, or an answer box.
 * - A to-do: Done.
 * - Finished and reversible: Reverse, through the same review for a change.
 */

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const when = (iso: string | undefined): string => {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const STATUS_WORDS: Readonly<Record<Task["status"], { label: string; tone: "accent" | "warn" | "neutral" | "danger" | "stale" }>> = {
  waiting_approval: { label: "Needs approval", tone: "warn" },
  waiting: { label: "Waiting", tone: "accent" },
  running: { label: "Running", tone: "accent" },
  done: { label: "Done", tone: "neutral" },
  skipped: { label: "Skipped", tone: "stale" },
  failed: { label: "Failed", tone: "danger" },
  timed_out: { label: "Timed out", tone: "stale" },
  lost: { label: "Lost", tone: "danger" },
  reversed: { label: "Reversed", tone: "stale" },
  dismissed: { label: "Declined", tone: "stale" },
};

const text = (value: unknown): string => (value === undefined || value === null ? "—" : typeof value === "string" ? value || "—" : JSON.stringify(value));

/** What the task holds, in the shape its kind reads best. */
export const TaskBody = ({ task }: { task: Task }): JSX.Element | null => {
  const body = task.body;
  switch (body.kind) {
    case "notice":
      return body.text ? <p className="dash-task__text">{body.text}</p> : null;
    case "change":
      return body.changes.length > 0 ? (
        <table className="dash-task__changes">
          <thead>
            <tr>
              <th>{body.what}</th>
              <th>Was</th>
              <th>Now</th>
            </tr>
          </thead>
          <tbody>
            {body.changes.map((change) => (
              <tr key={change.field}>
                <td>{change.label ?? change.field}</td>
                <td className="dash-task__before">{text(change.before)}</td>
                <td>{text(change.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dash-task__text">{body.what}</p>
      );
    case "created":
      return <p className="dash-task__text">Made: {body.what}</p>;
    case "removed":
      return <p className="dash-task__text">Removed: {body.what}</p>;
    case "conversation":
      return (
        <div className="dash-task__conversation">
          <span className="dash-hint">
            {body.channel} to {body.to}
            {task.delivery ? ` · ${task.delivery.status.replace("_", " ")}${task.delivery.detail ? `: ${task.delivery.detail}` : ""}` : ""}
          </span>
          {body.sent && <p className="dash-task__bubble">{body.sent}</p>}
          {body.reply && <p className="dash-task__bubble" data-from="them">{body.reply}</p>}
        </div>
      );
    case "wait":
      return (
        <p className="dash-task__text">
          Waiting for {body.forWhat}
          {body.deadline ? `, until ${when(body.deadline)}` : ""}
          {body.ended ? ` · ${body.ended === "happened" ? "it happened" : "it timed out"}` : ""}
        </p>
      );
    case "decision":
      return (
        <p className="dash-task__text">
          {body.outcome ? `Went: ${body.outcome}` : ""}
          {body.reason ? ` · ${body.reason}` : ""}
          {body.answer !== undefined && !body.outcome ? text(body.answer) : ""}
        </p>
      );
    case "request":
      return <p className="dash-task__text">{body.url}{body.status ? ` · ${body.status}` : ""}</p>;
    case "todo":
      return (
        <p className="dash-task__text">
          {body.details}
          {body.due ? ` · due ${when(body.due)}` : ""}
          {body.assignee ? ` · for ${body.assignee}` : ""}
        </p>
      );
    case "question":
      return <p className="dash-task__text">{body.answer ? `Answer: ${body.answer}` : body.question}</p>;
  }
};

export const TaskCard = ({
  task,
  agent,
  onChanged,
  compact = false,
}: {
  task: Task;
  agent: AgentSpec | undefined;
  onChanged: () => void;
  compact?: boolean;
}): JSX.Element => {
  const [review, setReview] = useState<{ view: WriteReviewView; mode: "approve" | "reverse" } | null>(null);
  const [always, setAlways] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = task.uncertain && task.status === "waiting_approval" ? { label: "Did it happen?", tone: "warn" as const } : STATUS_WORDS[task.status];
  const isQuestion = task.body.kind === "question" && task.status === "waiting";

  const act = async (work: () => Promise<unknown>, done = true): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      if (done) onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const open = () =>
    act(async () => {
      const opened = await api.reviewTask(task.id);
      if (opened.stale) setError(`This no longer applies: ${opened.stale} Decline it.`);
      else if (opened.review) setReview({ view: opened.review, mode: "approve" });
      else await api.approveTask(task.id, { always });
      if (!opened.review && !opened.stale) onChanged();
    }, false);

  const reverse = () =>
    act(async () => {
      const opened = await api.reverseReview(task.id);
      if (opened.stale) setError(`It cannot be reversed as it stands: ${opened.stale}`);
      else if (opened.review) setReview({ view: opened.review, mode: "reverse" });
      else {
        await api.reverseTask(task.id);
        onChanged();
      }
    }, false);

  return (
    <li className="dash-task" data-status={task.status} data-testid={`task-${task.id}`}>
      <div className="dash-task__head">
        <span className="dash-canvas__kind" data-base={task.base}>
          {BASE_INFO[task.base as ActionBase]?.label ?? task.base}
        </span>
        {agent && <AgentChip name={agent.name} color={agent.color} size="sm" />}
        <strong className="dash-task__title">{task.title}</strong>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {!compact && <TaskBody task={task} />}
      <span className="dash-hint">
        {task.reason ? `${task.reason} · ` : ""}
        {task.workflowName ? `${task.workflowName} · ` : ""}
        {when(task.finishedAt ?? task.createdAt)}
        {task.approvedBy ? ` · by ${task.approvedBy}` : ""}
        {task.error && task.status !== "failed" && !task.uncertain ? ` · ${task.error}` : ""}
        {task.retryAt && task.status === "waiting" ? ` · trying again ${when(task.retryAt)}` : ""}
      </span>
      {task.status === "failed" && task.error && <p className="dash-callout dash-callout--bad">{task.error}</p>}
      {error && (
        <p className="dash-callout dash-callout--bad" role="alert">
          {error}
        </p>
      )}

      {review ? (
        <>
          {review.mode === "approve" && (
            <label className="dash-reach__check">
              <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} /> Approve always: make this step automatic
            </label>
          )}
          <WriteReview
            review={review.view}
            compact
            busy={busy}
            onCancel={() => setReview(null)}
            onConfirm={() =>
              void act(async () => {
                if (review.mode === "approve") await api.approveTask(task.id, { pendingId: review.view.pendingId, digest: review.view.digest, always });
                else await api.reverseTask(task.id, { pendingId: review.view.pendingId, digest: review.view.digest });
                setReview(null);
              })
            }
          />
        </>
      ) : (
        <div className="dash-row">
          {task.status === "waiting_approval" && task.uncertain && (
            <>
              <Button size="sm" tone="primary" busy={busy} onClick={() => void act(() => api.settleTask(task.id))} testId={`task-settle-${task.id}`}>
                It happened
              </Button>
              <Button size="sm" busy={busy} onClick={() => void open()} testId={`task-again-${task.id}`}>
                Run it again
              </Button>
              <Button size="sm" tone="ghost" busy={busy} onClick={() => void act(() => api.declineTask(task.id))}>
                Don't run it
              </Button>
            </>
          )}
          {task.status === "waiting_approval" && !task.uncertain && (
            <>
              <Button size="sm" tone="primary" busy={busy} onClick={() => void open()} testId={`task-approve-${task.id}`}>
                Review and approve
              </Button>
              <label className="dash-reach__check">
                <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} /> Always
              </label>
              <Button size="sm" busy={busy} onClick={() => void act(() => api.declineTask(task.id))} testId={`task-decline-${task.id}`}>
                Decline
              </Button>
            </>
          )}
          {isQuestion &&
            (task.body.kind === "question" && task.body.options.length > 0 ? (
              task.body.options.map((option) => (
                <Button key={option} size="sm" busy={busy} onClick={() => void act(() => api.answerTask(task.id, option))} testId={`task-answer-${option}`}>
                  {option}
                </Button>
              ))
            ) : (
              <>
                <input className="dash-tool__when" aria-label="Answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Your answer" />
                <Button size="sm" busy={busy} disabled={!answer.trim()} onClick={() => void act(() => api.answerTask(task.id, answer.trim()))}>
                  Answer
                </Button>
              </>
            ))}
          {task.body.kind === "todo" && !task.body.done && task.status === "done" && (
            <Button size="sm" busy={busy} onClick={() => void act(() => api.completeTask(task.id))}>
              Mark done
            </Button>
          )}
          {task.status === "done" && task.reversal?.available && (
            <Button size="sm" tone="ghost" busy={busy} onClick={() => void reverse()} testId={`task-reverse-${task.id}`}>
              Reverse
            </Button>
          )}
          {task.status === "done" && task.reversal && !task.reversal.available && task.reversal.reason && !compact && <span className="dash-hint">{task.reversal.reason}</span>}
        </div>
      )}
    </li>
  );
};

/** "Waits up to 2 days": a duration setting in words, for summaries. */
export const durationWords = (value: unknown): string => describeDuration(value);
