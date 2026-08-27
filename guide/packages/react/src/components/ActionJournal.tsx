import React from "react";
import type { ActionRecord, ActionRecordStatus } from "@freebirdai/core";
import {
  useActionJournal,
  type UseActionJournalOptions,
} from "../hooks/useActionJournal.js";

export interface ActionJournalRenderProps {
  records: ActionRecord[];
  resume: (recordId: string) => void;
  discard: (recordId: string) => void;
}

export interface ActionJournalProps extends UseActionJournalOptions {
  /**
   * Render-prop API. Receives the filtered records plus `resume` / `discard`
   * verbs so the host can build a journal panel however they like.
   */
  children?: (props: ActionJournalRenderProps) => React.ReactNode;
  /** Default fallback used when no `children` render-prop is provided. */
  fallback?: (props: ActionJournalRenderProps) => React.ReactNode;
  /**
   * If true, render nothing when the (filtered) journal is empty.
   * @default true
   */
  hideWhenEmpty?: boolean;
}

/**
 * Headless action journal viewer.
 *
 * @example
 * <ActionJournal status="paused">
 *   {({ records, resume }) => (
 *     <ul>
 *       {records.map(r => (
 *         <li key={r.id}>
 *           {r.label ?? `${r.componentId}:${r.actionId}`}
 *           <button onClick={() => resume(r.id)}>Resume</button>
 *         </li>
 *       ))}
 *     </ul>
 *   )}
 * </ActionJournal>
 */
export const ActionJournal: React.FC<ActionJournalProps> = ({
  children,
  fallback,
  hideWhenEmpty = true,
  ...filter
}) => {
  const { records, resume, discard } = useActionJournal(filter);
  if (hideWhenEmpty && records.length === 0) return null;
  const renderProps: ActionJournalRenderProps = { records, resume, discard };
  if (children) return <>{children(renderProps)}</>;
  if (fallback) return <>{fallback(renderProps)}</>;
  return <DefaultJournal {...renderProps} />;
};

const STATUS_LABEL: Record<ActionRecordStatus, string> = {
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  terminated: "Terminated",
  failed: "Failed",
};

const DefaultJournal: React.FC<ActionJournalRenderProps> = ({
  records,
  resume,
  discard,
}) => (
  <ul data-freebird-action-journal="">
    {records.map((r) => (
      <li
        key={r.id}
        data-freebird-action-journal-item=""
        data-status={r.status}
      >
        <span data-freebird-action-journal-label="">
          {r.label ?? `${r.componentId}:${r.actionId}`}
        </span>
        <span data-freebird-action-journal-status="">
          {STATUS_LABEL[r.status]}
        </span>
        {r.status === "paused" ? (
          <button type="button" onClick={() => resume(r.id)}>
            Resume
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => discard(r.id)}
          aria-label="Remove from journal"
        >
          ×
        </button>
      </li>
    ))}
  </ul>
);
