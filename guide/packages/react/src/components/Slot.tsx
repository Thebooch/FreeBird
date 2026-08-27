import React from "react";

/**
 * Minimal Radix-style `asChild` slot. When `asChild` is true, the rendered
 * element is replaced by the user's React child, forwarding all props.
 *
 * This avoids pulling `@radix-ui/react-slot` as a dependency for just one
 * utility. The behavior matches closely enough for our use case.
 */
export interface SlotProps {
  asChild?: boolean;
  children?: React.ReactNode;
}

export const slotWith = <T extends React.ElementType>(
  Tag: T,
  props: React.ComponentPropsWithoutRef<T> & SlotProps,
): React.ReactElement => {
  const { asChild, children, ...rest } = props;
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ...rest,
      ...(children.props as object),
      // merge classNames
      className:
        [(rest as any).className, (children.props as any).className]
          .filter(Boolean)
          .join(" ") || undefined,
    } as any);
  }
  return React.createElement(Tag, rest as any, children);
};
