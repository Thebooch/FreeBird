import React from "react";
import { useFreeBird } from "../provider.js";
import { slotWith, type SlotProps } from "./Slot.js";

export interface InfoTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    SlotProps {
  /** Component id whose knowledge items should be explained by the chat. */
  componentId: string;
}

/**
 * "Info" button bound to a component id. On click, broadcasts a
 * `freebird:explain` event which any mounted `useChat` picks up and asks
 * the chat to explain the component using its knowledge items.
 *
 * The button itself is completely unstyled. Pass your own icon as children,
 * or use `asChild` to wrap an existing button/link:
 *
 *   <InfoTrigger componentId="revenueChart"><InfoIcon/></InfoTrigger>
 *   <InfoTrigger componentId="revenueChart" asChild><CustomButton>?</CustomButton></InfoTrigger>
 */
export const InfoTrigger: React.FC<InfoTriggerProps> = ({
  componentId,
  onClick,
  children,
  ...rest
}) => {
  const fb = useFreeBird();
  return slotWith("button", {
    type: "button",
    "aria-label": rest["aria-label"] ?? `Explain ${componentId}`,
    ...rest,
    "data-freebird-info-trigger": "",
    "data-component": componentId,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) fb.broadcastExplain(componentId);
    },
    children: children ?? (
      <span aria-hidden="true" style={{ fontStyle: "italic", fontWeight: 700 }}>
        i
      </span>
    ),
  } as any);
};
