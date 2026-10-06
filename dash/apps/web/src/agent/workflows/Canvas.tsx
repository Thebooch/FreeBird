import {
  BASE_INFO,
  TRIGGER_NODE,
  actionVariant,
  describeNode,
  nodeMode,
  nodeOutcomes,
  type WorkflowEdge,
  type WorkflowNode,
} from "@freebirdai/dash-spec";
import { useEffect, useRef, useState } from "react";
import { NODE_H, NODE_W } from "./draft.js";

/**
 * The workflow canvas: the trigger at the top, each step a card, and arrows
 * between them. An arrow leaves from one of a step's named outcomes — next,
 * happened, timed out, yes, a category — and can point anywhere, back up to
 * an earlier step included.
 *
 * - Drag a card by its header to move it.
 * - Click an outcome under a card, then click the step it should lead to.
 *   (Escape, or a click on empty canvas, cancels.)
 * - Click a card or an arrow to select it; the panel beside the canvas edits it.
 */

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  next: "next",
  happened: "happened",
  timed_out: "timed out",
  failed: "failed",
  yes: "yes",
  no: "no",
  approved: "approved",
  declined: "declined",
  answered: "answered",
  otherwise: "otherwise",
};

export const outcomeLabel = (outcome: string): string => OUTCOME_WORDS[outcome] ?? outcome;

const TRIGGER_H = 84;

export interface CanvasProps {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly triggerLabel: string;
  readonly trial: boolean;
  readonly selected: string | null;
  /** Problems by step id, shown on the card. */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  readonly onSelect: (id: string | null) => void;
  readonly onMove: (id: string, position: { x: number; y: number }) => void;
  readonly onConnect: (from: string, outcome: string, to: string) => void;
}

const triggerAt = (width: number) => ({ x: Math.max(24, Math.round(width / 2 - NODE_W / 2)), y: 24 });

export const Canvas = ({ nodes, edges, triggerLabel, trial, selected, problems, onSelect, onMove, onConnect }: CanvasProps): JSX.Element => {
  const width = Math.max(960, ...nodes.map((one) => one.position.x + NODE_W + 48));
  const height = Math.max(560, ...nodes.map((one) => one.position.y + NODE_H + 96));
  const trigger = triggerAt(width);
  const [connecting, setConnecting] = useState<{ from: string; outcome: string } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConnecting(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const local = (event: { clientX: number; clientY: number }) => {
    const box = surface.current?.getBoundingClientRect();
    return box ? { x: event.clientX - box.left + (surface.current?.scrollLeft ?? 0), y: event.clientY - box.top + (surface.current?.scrollTop ?? 0) } : { x: 0, y: 0 };
  };

  const positionOf = (id: string): { x: number; y: number; h: number } => {
    if (id === TRIGGER_NODE) return { ...trigger, h: TRIGGER_H };
    const held = dragging?.id === id ? { x: dragging.x, y: dragging.y } : nodes.find((one) => one.id === id)?.position;
    return { ...(held ?? { x: 0, y: 0 }), h: NODE_H };
  };
  const outcomesOf = (id: string): string[] => {
    if (id === TRIGGER_NODE) return ["next"];
    const one = nodes.find((each) => each.id === id);
    if (!one) return ["next"];
    /* Its own ways out: next for most, happened and timed out for a wait, one per category for a classifier. */
    const list = nodeOutcomes(one);
    return list.length > 0 ? list : ["next"];
  };
  const portAt = (id: string, outcome: string) => {
    const place = positionOf(id);
    const list = outcomesOf(id);
    const index = Math.max(0, list.indexOf(outcome));
    return { x: place.x + ((index + 0.5) * NODE_W) / list.length, y: place.y + place.h };
  };

  const wire = (edge: WorkflowEdge) => {
    const start = portAt(edge.from, edge.outcome);
    const target = positionOf(edge.to);
    const end = { x: target.x + NODE_W / 2, y: target.y };
    const down = end.y > start.y + 8;
    const d = down
      ? `M${start.x} ${start.y} C${start.x} ${start.y + 48}, ${end.x} ${end.y - 48}, ${end.x} ${end.y - 2}`
      : `M${start.x} ${start.y} C${start.x} ${start.y + 64}, ${target.x + NODE_W + 96} ${start.y + 32}, ${target.x + NODE_W + 72} ${target.y + NODE_H / 2} S${end.x + 24} ${end.y - 48}, ${end.x} ${end.y - 2}`;
    return { d, start, loop: !down };
  };

  const finishConnect = (to: string) => {
    if (connecting && to !== TRIGGER_NODE) onConnect(connecting.from, connecting.outcome, to);
    setConnecting(null);
  };

  const card = (id: string, inner: JSX.Element, extra: { className?: string; testId?: string } = {}) => {
    const place = positionOf(id);
    return (
      <div
        key={id}
        className={`dash-canvas__node${extra.className ? ` ${extra.className}` : ""}`}
        data-selected={selected === id}
        data-target={connecting !== null && id !== TRIGGER_NODE}
        style={{ left: place.x, top: place.y, width: NODE_W, height: place.h }}
        data-testid={extra.testId ?? `canvas-node-${id}`}
        onClick={(event) => {
          event.stopPropagation();
          if (connecting) finishConnect(id);
          else onSelect(id);
        }}
      >
        {inner}
        <div className="dash-canvas__ports">
          {outcomesOf(id).map((outcome) => (
            <button
              key={outcome}
              type="button"
              className="dash-canvas__port"
              data-outcome={outcome}
              data-active={connecting?.from === id && connecting.outcome === outcome}
              title={`Draw the arrow for "${outcomeLabel(outcome)}"`}
              onClick={(event) => {
                event.stopPropagation();
                setConnecting(connecting?.from === id && connecting.outcome === outcome ? null : { from: id, outcome });
              }}
              data-testid={`port-${id}-${outcome}`}
            >
              {outcomeLabel(outcome)}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={surface}
      className="dash-canvas"
      data-connecting={connecting !== null}
      onClick={() => {
        setConnecting(null);
        onSelect(null);
      }}
      onPointerMove={(event) => {
        if (connecting) setPointer(local(event));
        if (dragging) {
          const at = local(event);
          setDragging({ ...dragging, x: Math.max(0, Math.round((at.x - dragging.dx) / 8) * 8), y: Math.max(TRIGGER_H + 48, Math.round((at.y - dragging.dy) / 8) * 8) });
        }
      }}
      onPointerUp={() => {
        if (dragging) {
          onMove(dragging.id, { x: dragging.x, y: dragging.y });
          setDragging(null);
        }
      }}
      data-testid="workflow-canvas"
    >
      <div className="dash-canvas__surface" style={{ width, height }}>
        <svg className="dash-canvas__wires" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" className="dash-canvas__arrowhead" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const { d, start, loop } = wire(edge);
            return (
              <g key={edge.id} className="dash-canvas__wire" data-selected={selected === edge.id} data-loop={loop}>
                <path d={d} className="dash-canvas__wire-hit" onClick={(event) => (event.stopPropagation(), onSelect(edge.id))} />
                <path d={d} className="dash-canvas__wire-line" markerEnd="url(#wf-arrow)" />
                {edge.outcome !== "next" && (
                  <text x={start.x + 6} y={start.y + 16} className="dash-canvas__wire-label">
                    {outcomeLabel(edge.outcome)}
                  </text>
                )}
              </g>
            );
          })}
          {connecting && pointer && (
            <line x1={portAt(connecting.from, connecting.outcome).x} y1={portAt(connecting.from, connecting.outcome).y} x2={pointer.x} y2={pointer.y} className="dash-canvas__wire-draft" />
          )}
        </svg>

        {card(
          TRIGGER_NODE,
          <div className="dash-canvas__body">
            <span className="dash-canvas__kind">Trigger{trial ? " · trial" : ""}</span>
            <span className="dash-canvas__name">{triggerLabel}</span>
          </div>,
          { className: "dash-canvas__node--trigger", testId: "canvas-trigger" },
        )}

        {nodes.map((one) => {
          const variant = actionVariant(one.action);
          const mode = nodeMode(one, trial);
          const issues = problems[one.id] ?? [];
          return card(
            one.id,
            <>
              <div
                className="dash-canvas__head"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const at = local(event);
                  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                  setDragging({ id: one.id, dx: at.x - one.position.x, dy: at.y - one.position.y, x: one.position.x, y: one.position.y });
                }}
              >
                <span className="dash-canvas__kind" data-base={variant?.base}>
                  {variant ? BASE_INFO[variant.base].label : "?"}
                </span>
                {variant?.leavesDash ? (
                  <span className="dash-canvas__mode" data-mode={mode}>
                    {mode === "auto" ? "Auto" : "Approve"}
                  </span>
                ) : null}
                {issues.length > 0 && (
                  <span className="dash-canvas__issues" title={issues.join("\n")}>
                    {issues.length}
                  </span>
                )}
              </div>
              <div className="dash-canvas__body">
                <span className="dash-canvas__name">{describeNode(one)}</span>
                {one.when ? <span className="dash-canvas__when">only when {one.when}</span> : null}
              </div>
            </>,
          );
        })}
      </div>
    </div>
  );
};
