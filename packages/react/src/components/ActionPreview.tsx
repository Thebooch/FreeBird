import React from "react";
import type { PendingAction } from "@freebirdai/core";
import { useActionState } from "../hooks/useActionState.js";

export interface ActionPreviewRenderProps {
  pending: PendingAction;
  /** Phase from the state machine — useful for disabling buttons while executing. */
  phase: "collecting" | "awaiting_confirmation" | "executing" | "error";
  /** Latest validation/handler error. */
  error?: string;
  confirm: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  pause: (label?: string) => void;
}

export interface ActionPreviewProps {
  /**
   * Render-prop API. Use when you want a fully custom preview UI.
   *
   * @example
   * <ActionPreview>
   *   {({ pending, confirm, cancel }) => (
   *     <Card>
   *       <pre>{JSON.stringify(pending.args, null, 2)}</pre>
   *       <button onClick={() => confirm()}>Apply</button>
   *       <button onClick={() => cancel()}>Cancel</button>
   *     </Card>
   *   )}
   * </ActionPreview>
   */
  children?: (props: ActionPreviewRenderProps) => React.ReactNode;
  /**
   * Optional fallback rendered when the children render-prop is omitted.
   * Defaults to a minimal unstyled `<div data-freebird-action-preview>`
   * with raw JSON, two buttons, and ARIA roles. Hosts almost always
   * override this — that's the point of headless.
   */
  fallback?: (props: ActionPreviewRenderProps) => React.ReactNode;
  /** Hide the preview while the action is executing. Default: false. */
  hideWhileExecuting?: boolean;
}

/**
 * Headless action confirmation preview.
 *
 * Renders nothing when there's no pending action (or the action is in
 * `idle`). Otherwise calls the `children` render-prop with the pending
 * action and the three control verbs (confirm/cancel/pause).
 *
 * Pair with the `freebird.action-preview` registered component (see
 * `@freebirdai/react-tailwind`) for a styled default, or roll your own.
 */
export const ActionPreview: React.FC<ActionPreviewProps> = ({
  children,
  fallback,
  hideWhileExecuting = false,
}) => {
  const { phase, pending, lastError, confirm, cancel, pause } = useActionState();
  if (!pending || phase === "idle") return null;
  if (hideWhileExecuting && phase === "executing") return null;
  const renderProps: ActionPreviewRenderProps = {
    pending,
    phase: phase as ActionPreviewRenderProps["phase"],
    error: lastError,
    confirm,
    cancel,
    pause,
  };
  if (children) return <>{children(renderProps)}</>;
  if (fallback) return <>{fallback(renderProps)}</>;
  return <DefaultPreview {...renderProps} />;
};

const DefaultPreview: React.FC<ActionPreviewRenderProps> = (p) => (
  <div
    role="dialog"
    aria-label="Confirm action"
    data-freebird-action-preview=""
    data-phase={p.phase}
  >
    <div data-freebird-action-preview-header="">
      <strong>
        {p.pending.label ??
          `${p.pending.componentId}:${p.pending.actionId}`}
      </strong>
    </div>
    <pre data-freebird-action-preview-body="">
      {JSON.stringify(p.pending.args, null, 2)}
    </pre>
    {p.error ? (
      <div role="alert" data-freebird-action-preview-error="">
        {p.error}
      </div>
    ) : null}
    <div data-freebird-action-preview-actions="">
      <button
        type="button"
        onClick={() => p.confirm()}
        disabled={p.phase === "executing" || p.phase === "collecting"}
        data-freebird-action-confirm=""
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={() => p.cancel()}
        data-freebird-action-cancel=""
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => p.pause()}
        data-freebird-action-pause=""
      >
        Pause
      </button>
    </div>
  </div>
);
