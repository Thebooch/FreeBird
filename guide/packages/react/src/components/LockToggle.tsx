import React from "react";
import { useFreeBird } from "../provider.js";
import { slotWith, type SlotProps } from "./Slot.js";

export interface LockToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">,
    SlotProps {
  /** Instance id of the cell this toggle controls. */
  instanceId: string;
  /** Render prop that receives `{ locked, toggle }`. Use it to swap icons. */
  render?: (state: { locked: boolean; toggle: () => void }) => React.ReactNode;
}

/**
 * Per-cell lock toggle. Renders a button (or custom element via `asChild`)
 * whose `aria-pressed` reflects the lock state. Fully unstyled.
 *
 * You can either pass children (e.g. your own lock icon) or use the `render`
 * prop for a render-prop style API.
 */
export const LockToggle: React.FC<LockToggleProps> = ({
  instanceId,
  render,
  children,
  onClick,
  ...rest
}) => {
  const fb = useFreeBird();
  const cell = fb.layout?.cells.find((c) => c.instanceId === instanceId);
  const locked = !!cell?.locked;
  const toggle = () => fb.toggleLock(instanceId);

  const body = render ? render({ locked, toggle }) : children;

  return slotWith("button", {
    type: "button",
    ...rest,
    "data-freebird-lock-toggle": "",
    "data-locked": locked ? "" : undefined,
    "aria-pressed": locked,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) toggle();
    },
    children: body,
  } as any);
};
